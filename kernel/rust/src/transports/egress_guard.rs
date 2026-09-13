//! Egress policy for registry fetches, from `TELO_EGRESS`. Mirrors
//! `../../nodejs/src/transports/egress-guard.ts`:
//! - unset / `open` — no restriction (the default; a developer machine);
//! - `public-only` — refuse any host that is, or resolves to, a private,
//!   loopback, link-local, or carrier-grade-NAT address.
//!
//! A guardrail, not isolation: the check-then-fetch gap is open to DNS
//! rebinding, and network-level egress policy is the actual boundary. One
//! difference from Node, in the stricter direction: the OCI client checks every
//! redirect hop too, where Node checks only the URL a fetch starts at.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};

#[derive(Debug, thiserror::Error)]
pub enum EgressError {
    #[error(
        "Egress to '{host}' denied: it resolves to the non-public address {address} \
         (TELO_EGRESS=public-only). Refusing to fetch from private, loopback, link-local, or CGNAT ranges."
    )]
    Denied { host: String, address: IpAddr },
    #[error("Egress check for '{host}' could not resolve it (TELO_EGRESS=public-only): {detail}")]
    Unresolvable { host: String, detail: String },
}

fn is_private_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, ..] = address.octets();
    a == 0 // "this network"
        || a == 10
        || a == 127 // loopback
        || (a == 100 && (64..=127).contains(&b)) // CGNAT 100.64/10
        || (a == 169 && b == 254) // link-local, incl. cloud metadata
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
}

fn is_private_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_private_ipv4(mapped);
    }
    let first = address.segments()[0];
    address.is_unspecified()
        || address.is_loopback()
        || (first & 0xfe00) == 0xfc00 // unique-local fc00::/7
        || (first & 0xffc0) == 0xfe80 // link-local fe80::/10
}

/// True when `address` is not publicly routable.
pub fn is_private_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => is_private_ipv4(v4),
        IpAddr::V6(v6) => is_private_ipv6(v6),
    }
}

/// Read per call, like every kernel `TELO_*` setting, so the policy in force is
/// the process's at the time of the fetch.
fn policy_active() -> bool {
    std::env::var("TELO_EGRESS").is_ok_and(|value| value.eq_ignore_ascii_case("public-only"))
}

/// The host of a URL or a bare `host[:port]`, IPv6 brackets stripped.
fn host_of(host_or_url: &str) -> &str {
    let authority = match host_or_url.split_once("://") {
        Some((_, rest)) => rest.split(['/', '?', '#']).next().unwrap_or(""),
        None => host_or_url,
    };
    let authority = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    if let Some(bracketed) = authority.strip_prefix('[') {
        return bracketed.split(']').next().unwrap_or("");
    }
    authority.rsplit_once(':').map_or(authority, |(host, _)| host)
}

/// Assert `host_or_url` may be fetched under the active policy. A no-op unless
/// `TELO_EGRESS=public-only`. An IP literal is judged directly; a hostname is
/// resolved and every address must be public. A resolution failure is an
/// error, never a silent pass.
pub fn assert_public_egress(host_or_url: &str) -> Result<(), EgressError> {
    if !policy_active() {
        return Ok(());
    }
    let host = host_of(host_or_url);
    if let Ok(address) = host.parse::<IpAddr>() {
        return match is_private_address(address) {
            true => Err(EgressError::Denied {
                host: host.to_string(),
                address,
            }),
            false => Ok(()),
        };
    }
    let addresses = (host, 443).to_socket_addrs().map_err(|err| EgressError::Unresolvable {
        host: host.to_string(),
        detail: err.to_string(),
    })?;
    for socket in addresses {
        if is_private_address(socket.ip()) {
            return Err(EgressError::Denied {
                host: host.to_string(),
                address: socket.ip(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_the_non_public_ranges() {
        for private in [
            "0.1.2.3", "10.0.0.5", "127.0.0.1", "100.64.0.1", "100.127.255.255", "169.254.169.254",
            "172.16.0.1", "172.31.255.255", "192.168.1.1", "::", "::1", "fc00::1", "fd12::1",
            "fe80::1", "febf::1", "::ffff:10.0.0.1",
        ] {
            assert!(is_private_address(private.parse().unwrap()), "{private}");
        }
        for public in ["8.8.8.8", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"] {
            assert!(!is_private_address(public.parse().unwrap()), "{public}");
        }
        assert_eq!(host_of("http://127.0.0.1:5000/v2/x"), "127.0.0.1");
        assert_eq!(host_of("https://[::1]:443/token?scope=a"), "::1");
        assert_eq!(host_of("ghcr.io"), "ghcr.io");
    }
}
