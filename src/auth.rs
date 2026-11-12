//! The optional password (`BLOCKSEQ_PASSWORD`, HTTP basic auth) and a limit on
//! guessing it.
//!
//! Each client may try at most `MAX_WRONG` *different* wrong passwords per
//! WINDOW; after that it is refused until the window ends. Repeats of the
//! same wrong password (a browser resending a saved typo) count once, so a
//! typo doesn't lock you out. Behind a reverse proxy every request comes
//! from the proxy's address; list it in `BLOCKSEQ_TRUSTED_PROXIES` and the
//! client address it forwards (X-Forwarded-For) is used instead.

use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, RandomState};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};

use crate::AppState;

const WINDOW: Duration = Duration::from_secs(15 * 60);
const MAX_WRONG: usize = 10;
/// Clients remembered at most. Expired entries go first. If the map is still
/// full, the oldest client is dropped so a new one can be recorded. The map
/// is never cleared wholesale, which would forget every lockout.
const MAX_CLIENTS: usize = 4096;

struct Attempts {
    since: Instant,
    /// Hashes of the distinct wrong passwords tried (never the passwords).
    wrong: HashSet<u64>,
}

pub struct Limiter {
    clients: Mutex<HashMap<IpAddr, Attempts>>,
    hasher: RandomState,
}

impl Default for Limiter {
    fn default() -> Self {
        Limiter { clients: Mutex::new(HashMap::new()), hasher: RandomState::new() }
    }
}

impl Limiter {
    /// Seconds until this client may try again, if it is locked out.
    pub fn locked_for(&self, ip: IpAddr, now: Instant) -> Option<u64> {
        let clients = self.clients.lock();
        let a = clients.get(&ip)?;
        let left = WINDOW.checked_sub(now.duration_since(a.since))?;
        (a.wrong.len() >= MAX_WRONG).then(|| left.as_secs().max(1))
    }

    pub fn failed(&self, ip: IpAddr, password: &str, now: Instant) {
        let mut clients = self.clients.lock();
        // An address already stored is updated in place, so a full map does
        // not have to drop someone else's lockout.
        if !clients.contains_key(&ip) && clients.len() >= MAX_CLIENTS {
            clients.retain(|_, a| now.duration_since(a.since) < WINDOW);
            if clients.len() >= MAX_CLIENTS {
                let oldest = clients.iter().min_by_key(|(_, a)| a.since).map(|(ip, _)| *ip);
                if let Some(oldest) = oldest {
                    clients.remove(&oldest);
                }
            }
        }
        let a = clients.entry(ip).or_insert_with(|| Attempts { since: now, wrong: HashSet::new() });
        if now.duration_since(a.since) >= WINDOW {
            *a = Attempts { since: now, wrong: HashSet::new() };
        }
        a.wrong.insert(self.hasher.hash_one(password));
        if a.wrong.len() == MAX_WRONG {
            tracing::warn!("too many wrong passwords from {ip}: refusing it for {} minutes", WINDOW.as_secs() / 60);
        }
    }

    pub fn succeeded(&self, ip: IpAddr) {
        self.clients.lock().remove(&ip);
    }
}

/// IP addresses from `BLOCKSEQ_TRUSTED_PROXIES` (`10.0.0.1, ::1`). A port
/// (`10.0.0.1:24223`, as `ss` shows connections) is ignored; anything else
/// that isn't an address is skipped with a warning.
pub fn parse_proxies(value: &str) -> Vec<IpAddr> {
    let mut out = Vec::new();
    for item in value.split([',', ' ']).map(str::trim).filter(|s| !s.is_empty()) {
        let parsed = item
            .parse::<IpAddr>()
            .ok()
            .or_else(|| item.parse::<SocketAddr>().ok().map(|s| s.ip()));
        if let Some(ip) = parsed {
            out.push(ip);
        } else {
            tracing::warn!("BLOCKSEQ_TRUSTED_PROXIES: {item:?} isn't an IP address; ignored");
        }
    }
    out
}

/// The client's address: the peer, or the address a trusted proxy forwarded
/// (the last X-Forwarded-For entry, which the proxy itself added).
pub fn client_ip(peer: IpAddr, headers: &HeaderMap, trusted: &[IpAddr]) -> IpAddr {
    if !trusted.contains(&peer) {
        return peer;
    }
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit(',').next())
        .and_then(|ip| ip.trim().parse().ok())
        .unwrap_or(peer)
}

/// True when the two passwords are the same. Both are hashed first, then all
/// 32 bytes are compared, so a different length does not return early.
fn passwords_match(given: &str, expected: &str) -> bool {
    let a = Sha256::digest(given.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// The password given in a basic-auth header (any user name), if any.
fn given_password(headers: &HeaderMap) -> Option<String> {
    let encoded = headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Basic ")?;
    let raw = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    let creds = String::from_utf8(raw).ok()?;
    Some(creds.split_once(':').map_or("", |(_, p)| p).to_string())
}

pub async fn require_password(State(s): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let Some(expected) = &s.password else {
        return next.run(req).await;
    };
    // Monitoring can check health without the password (it shows no notes).
    if req.uri().path() == "/api/health" {
        return next.run(req).await;
    }
    let peer = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map_or(IpAddr::from([0, 0, 0, 0]), |c| c.0.ip());
    let ip = client_ip(peer, req.headers(), &s.trusted_proxies);
    let now = Instant::now();
    if let Some(secs) = s.limiter.locked_for(ip, now) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, secs.to_string())],
            format!("Too many wrong passwords. Try again in {} minutes.", secs.div_ceil(60)),
        )
            .into_response();
    }
    match given_password(req.headers()) {
        Some(p) if passwords_match(&p, expected) => {
            s.limiter.succeeded(ip);
            next.run(req).await
        }
        given => {
            // A request without a password is just the browser asking; only
            // actual wrong passwords count.
            if let Some(p) = given {
                s.limiter.failed(ip, &p, now);
            }
            (StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, "Basic realm=\"Blockseq\"")], "Password required")
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinct_wrong_passwords_lock_a_client_out_for_a_while() {
        let l = Limiter::default();
        let ip: IpAddr = "10.0.0.9".parse().unwrap();
        let other: IpAddr = "10.0.0.10".parse().unwrap();
        let t0 = Instant::now();
        // The same typo over and over counts once.
        for _ in 0..50 {
            l.failed(ip, "typo", t0);
        }
        assert!(l.locked_for(ip, t0).is_none());
        for i in 0..MAX_WRONG - 1 {
            l.failed(ip, &format!("guess {i}"), t0);
        }
        assert!(l.locked_for(ip, t0).is_some());
        assert!(l.locked_for(other, t0).is_none());
        // After the window it may try again.
        assert!(l.locked_for(ip, t0 + WINDOW + Duration::from_secs(1)).is_none());
    }

    #[test]
    fn a_full_lockout_map_drops_the_oldest_client() {
        let l = Limiter::default();
        let t0 = Instant::now();
        let ip_at = |i: u32| {
            let octet = |shift| u8::try_from((i >> shift) & 0xff_u32).expect("masked to one byte");
            IpAddr::from([10, octet(16), octet(8), octet(0)])
        };
        for i in 0..u32::try_from(MAX_CLIENTS).unwrap() {
            let when = t0 + Duration::from_millis(u64::from(i));
            let ip = ip_at(i);
            for n in 0..MAX_WRONG {
                l.failed(ip, &format!("pw{n}"), when);
            }
        }
        let later = t0 + Duration::from_secs(30);
        let oldest = ip_at(0);
        let newest = ip_at(u32::try_from(MAX_CLIENTS).unwrap() - 1);
        assert!(l.locked_for(oldest, later).is_some());
        assert!(l.locked_for(newest, later).is_some());
        // The newest client is already stored: another wrong password must
        // not push the oldest one out.
        l.failed(newest, "one more", later);
        assert!(l.locked_for(oldest, later).is_some());
        let extra: IpAddr = "192.0.2.1".parse().unwrap();
        for n in 0..MAX_WRONG {
            l.failed(extra, &format!("pw{n}"), later);
        }
        assert!(l.locked_for(oldest, later).is_none());
        assert!(l.locked_for(newest, later).is_some());
        assert!(l.locked_for(extra, later).is_some());
    }

    #[test]
    fn password_compare_checks_the_whole_hash() {
        assert!(passwords_match("secret", "secret"));
        assert!(passwords_match("", ""));
        assert!(!passwords_match("secret", "secre"));
        assert!(!passwords_match("secret", "secret "));
        assert!(!passwords_match("", "x"));
    }

    #[test]
    fn proxy_list_accepts_addresses_with_ports() {
        let ips = parse_proxies("10.0.0.1:24223, ::1, [fe80::1]:443, nonsense");
        assert_eq!(ips, vec!["10.0.0.1".parse::<IpAddr>().unwrap(), "::1".parse().unwrap(), "fe80::1".parse().unwrap()]);
    }

    #[test]
    fn forwarded_address_only_from_trusted_proxies() {
        let proxy: IpAddr = "10.0.0.1".parse().unwrap();
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "1.2.3.4, 5.6.7.8".parse().unwrap());
        assert_eq!(client_ip(proxy, &h, &[proxy]), "5.6.7.8".parse::<IpAddr>().unwrap());
        let lan: IpAddr = "10.0.0.50".parse().unwrap();
        assert_eq!(client_ip(lan, &h, &[proxy]), lan); // spoofed header ignored
        assert_eq!(client_ip(proxy, &HeaderMap::new(), &[proxy]), proxy);
    }
}
