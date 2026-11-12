//! The optional password (BLOCKSEQ_PASSWORD, HTTP basic auth) and a limit on
//! guessing it.
//!
//! Each client may try at most MAX_WRONG *different* wrong passwords per
//! WINDOW; after that it is refused until the window ends. Repeats of the
//! same wrong password (a browser resending a saved typo) count once, so a
//! typo doesn't lock you out. Behind a reverse proxy every request comes
//! from the proxy's address; list it in BLOCKSEQ_TRUSTED_PROXIES and the
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

use crate::AppState;

const WINDOW: Duration = Duration::from_secs(15 * 60);
const MAX_WRONG: usize = 10;
/// Clients remembered at most (old entries are dropped first).
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
        if clients.len() >= MAX_CLIENTS {
            clients.retain(|_, a| now.duration_since(a.since) < WINDOW);
            if clients.len() >= MAX_CLIENTS {
                clients.clear();
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

/// IP addresses from BLOCKSEQ_TRUSTED_PROXIES ("10.0.0.1, ::1").
pub fn parse_proxies(value: &str) -> Vec<IpAddr> {
    value.split([',', ' ']).filter_map(|p| p.trim().parse().ok()).collect()
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

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
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
        Some(p) if constant_time_eq(p.as_bytes(), expected.as_bytes()) => {
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
