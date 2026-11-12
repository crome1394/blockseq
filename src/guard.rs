//! Request checks and security headers for every response.
//!
//! - Cross-site requests: a page on another site must not be able to change
//!   notes through your browser (CSRF). Basic auth doesn't stop this, because
//!   browsers resend the password automatically.
//! - Host names: a hostile DNS name pointed at this server (DNS rebinding)
//!   must not be able to read notes. With `BLOCKSEQ_HOSTS` set, only those
//!   names (plus IP addresses and localhost) are served.
//! - Headers: a Content-Security-Policy for the app page, no framing by other
//!   sites, no referrer to other sites, no content sniffing.

use std::net::IpAddr;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::AppState;

/// Only Blockseq's own files run; embeds come from the three video/post
/// sites it knows. Notes may show images and media from anywhere.
const APP_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
img-src * data: blob:; media-src * data: blob:; font-src 'self' data:; connect-src 'self'; \
frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com https://platform.twitter.com; \
object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";

/// Host names from `BLOCKSEQ_HOSTS` ("notes.example.com, blockseq"); empty
/// means any name is accepted.
pub fn parse_hosts(value: &str) -> Vec<String> {
    value.split([',', ' ']).map(|h| h.trim().to_ascii_lowercase()).filter(|h| !h.is_empty()).collect()
}

/// "name:port", "[`::1`]:port" or "name" → "name" / "`::1`".
fn host_name(host: &str) -> &str {
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next().unwrap_or("");
    }
    match host.rsplit_once(':') {
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) => name,
        _ => host,
    }
}

fn host_allowed(host: &str, allowed: &[String]) -> bool {
    let name = host_name(host).to_ascii_lowercase();
    allowed.is_empty()
        || name.parse::<IpAddr>().is_ok()
        || name == "localhost"
        || allowed.contains(&name)
}

/// Why a request is refused, if it is.
pub fn refusal(method: &Method, headers: &HeaderMap, allowed: &[String]) -> Option<&'static str> {
    let text = |name: header::HeaderName| headers.get(name).and_then(|v| v.to_str().ok());
    let host = text(header::HOST).unwrap_or("");
    if !host_allowed(host, allowed) {
        return Some("This host name isn't allowed. Add it to BLOCKSEQ_HOSTS in /etc/blockseq.env.");
    }
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return None;
    }
    // Every current browser says where a request comes from.
    match headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        Some("same-origin" | "none") => return None,
        Some(_) => return Some("Cross-site request refused."),
        None => {}
    }
    // Older browsers: the Origin must be this server (as the browser or a
    // reverse proxy names it). No Origin at all: not a browser (curl, scripts).
    match text(header::ORIGIN) {
        None => None,
        Some(origin) => {
            let origin_host = origin.split_once("://").map_or("", |(_, h)| h);
            let forwarded = headers.get("x-forwarded-host").and_then(|v| v.to_str().ok());
            if !origin_host.is_empty() && (origin_host.eq_ignore_ascii_case(host) || forwarded.is_some_and(|f| origin_host.eq_ignore_ascii_case(f))) {
                None
            } else {
                Some("Cross-site request refused.")
            }
        }
    }
}

pub async fn check(State(s): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    if let Some(why) = refusal(req.method(), req.headers(), &s.allowed_hosts) {
        tracing::warn!("refused {} {}: {why}", req.method(), req.uri().path());
        return (StatusCode::FORBIDDEN, why).into_response();
    }
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    let is_html = h.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|t| t.starts_with("text/html"));
    // Uploaded files carry their own (stricter) policy from get_asset.
    if is_html && !h.contains_key(header::CONTENT_SECURITY_POLICY) {
        h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(APP_CSP));
    }
    h.entry(header::X_CONTENT_TYPE_OPTIONS).or_insert(HeaderValue::from_static("nosniff"));
    h.entry(header::X_FRAME_OPTIONS).or_insert(HeaderValue::from_static("SAMEORIGIN"));
    h.entry(header::REFERRER_POLICY).or_insert(HeaderValue::from_static("same-origin"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, v.parse().unwrap());
        }
        h
    }

    #[test]
    fn cross_site_writes_are_refused() {
        let none: Vec<String> = vec![];
        let post = Method::POST;
        let ok = |pairs| refusal(&post, &headers(pairs), &none).is_none();
        assert!(ok(&[("host", "notes.lan:3030"), ("sec-fetch-site", "same-origin")]));
        assert!(!ok(&[("host", "notes.lan:3030"), ("sec-fetch-site", "cross-site")]));
        assert!(!ok(&[("host", "notes.lan:3030"), ("sec-fetch-site", "same-site")]));
        assert!(ok(&[("host", "notes.lan:3030"), ("origin", "http://notes.lan:3030")]));
        assert!(!ok(&[("host", "notes.lan:3030"), ("origin", "https://evil.example")]));
        assert!(!ok(&[("host", "notes.lan:3030"), ("origin", "null")]));
        assert!(ok(&[("host", "10.0.0.5:3030"), ("origin", "https://notes.example.com"), ("x-forwarded-host", "notes.example.com")]));
        assert!(ok(&[("host", "notes.lan:3030")])); // curl, scripts
        // Reading is fine from anywhere the browser allows.
        assert!(refusal(&Method::GET, &headers(&[("host", "x"), ("sec-fetch-site", "cross-site")]), &none).is_none());
    }

    #[test]
    fn only_listed_host_names_when_configured() {
        let allowed = parse_hosts("notes.example.com, blockseq");
        let get = |host| refusal(&Method::GET, &headers(&[("host", host)]), &allowed).is_none();
        assert!(get("notes.example.com"));
        assert!(get("NOTES.example.com:443"));
        assert!(get("blockseq:3030"));
        assert!(get("10.0.0.20:3030"));
        assert!(get("[::1]:3030"));
        assert!(get("localhost:3939"));
        assert!(!get("rebind.attacker.example"));
        assert!(refusal(&Method::GET, &headers(&[("host", "anything")]), &[]).is_none());
    }
}
