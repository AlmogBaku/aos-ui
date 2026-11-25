//! Pure address checks for the shell. No Tauri types here, so the rules can be
//! unit-tested on any host (`cargo test` on a machine with the Tauri system
//! libraries, or the standalone harness described in NOTES.md).

use url::{Host, Url};

/// Parses `input` as a strict `https` origin and returns its canonical form
/// (`https://host` or `https://host:port`, lowercase, no trailing slash).
///
/// Rejected: any scheme but `https`, credentials, a path other than `/`, a
/// query, a fragment, whitespace or control characters, percent-escapes,
/// URL-pattern / glob syntax (`* ? ( ) { } [ ] + \ ^ |`), IPv6 literals, and
/// any spelling the canonical form does not reproduce exactly (so the value the
/// shell grants is the value the person typed).
pub fn parse_strict_https_origin(input: &str) -> Result<String, String> {
    if input.is_empty() {
        return Err("empty address".into());
    }
    if input.len() > 253 + "https://:65535/".len() {
        return Err("address too long".into());
    }
    if let Some(c) = input
        .chars()
        .find(|c| c.is_whitespace() || c.is_control() || !c.is_ascii())
    {
        return Err(format!("address contains a disallowed character {c:?}"));
    }
    if let Some(c) = input
        .chars()
        .find(|c| matches!(c, '*' | '?' | '(' | ')' | '{' | '}' | '[' | ']' | '+' | '\\' | '^' | '|' | '%' | '#' | '@'))
    {
        return Err(format!(
            "address contains {c:?}; patterns, credentials, queries, fragments and escapes are not accepted"
        ));
    }

    let url = Url::parse(input).map_err(|e| format!("not a URL: {e}"))?;
    if url.scheme() != "https" {
        return Err(format!("scheme must be https, got {}", url.scheme()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials are not accepted".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("query and fragment are not accepted".into());
    }
    if url.path() != "/" {
        return Err(format!("a path is not accepted (got {})", url.path()));
    }
    match url.host() {
        Some(Host::Domain(domain)) => {
            let labels_ok = domain.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            });
            if !labels_ok {
                return Err(format!("host {domain:?} is not a plain DNS name"));
            }
        }
        Some(Host::Ipv4(_)) => {}
        Some(Host::Ipv6(_)) => return Err("IPv6 literals are not accepted by this probe".into()),
        None => return Err("missing host".into()),
    }

    let canonical = url.origin().ascii_serialization();
    // The only spellings accepted are the canonical one, with an optional single
    // trailing slash, and (for the default port) an explicit `:443`.
    let mut accepted = vec![canonical.clone(), format!("{canonical}/")];
    if url.port().is_none() {
        accepted.push(format!("{canonical}:443"));
        accepted.push(format!("{canonical}:443/"));
    }
    if !accepted.iter().any(|a| a == &input.to_ascii_lowercase()) {
        return Err(format!(
            "address must be written as the bare origin {canonical}"
        ));
    }
    Ok(canonical)
}

/// Checks that `requested` is a `wss://` URL on exactly the stored origin's host
/// and port, and returns it. `stored_origin` must come from
/// [`parse_strict_https_origin`].
pub fn socket_target(stored_origin: &str, requested: &str) -> Result<Url, String> {
    let stored = Url::parse(stored_origin).map_err(|e| format!("stored origin invalid: {e}"))?;
    let url = Url::parse(requested).map_err(|e| format!("socket URL invalid: {e}"))?;
    if url.scheme() != "wss" {
        return Err(format!("socket scheme must be wss, got {}", url.scheme()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("socket URL must not carry credentials".into());
    }
    if url.fragment().is_some() {
        return Err("socket URL must not carry a fragment".into());
    }
    if url.host() != stored.host() || url.port_or_known_default() != stored.port_or_known_default()
    {
        return Err(format!(
            "socket host {} is not the stored host {}",
            url.host_str().unwrap_or("<none>"),
            stored.host_str().unwrap_or("<none>")
        ));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_bare_origins() {
        for (input, expected) in [
            ("https://probe.example.ts.net", "https://probe.example.ts.net"),
            ("https://probe.example.ts.net/", "https://probe.example.ts.net"),
            ("https://probe.example.ts.net:8443", "https://probe.example.ts.net:8443"),
            ("https://probe.example.ts.net:443", "https://probe.example.ts.net"),
            ("https://PROBE.example.ts.net", "https://probe.example.ts.net"),
            ("https://100.64.0.7:8443", "https://100.64.0.7:8443"),
        ] {
            assert_eq!(parse_strict_https_origin(input).as_deref(), Ok(expected), "{input}");
        }
    }

    #[test]
    fn rejects_everything_else() {
        for input in [
            "",
            "http://probe.example.ts.net",
            "wss://probe.example.ts.net",
            "probe.example.ts.net",
            "https://*.example.ts.net",
            "https://probe.example.ts.net/*",
            "https://probe.example.ts.net/path",
            "https://probe.example.ts.net/./",
            "https://probe.example.ts.net//",
            "https://user:pw@probe.example.ts.net",
            "https://user@probe.example.ts.net",
            "https://probe.example.ts.net?x=1",
            "https://probe.example.ts.net/?",
            "https://probe.example.ts.net#x",
            "https://probe.example.ts.net:8443:9",
            "https://probe.example.ts.net:{port}",
            "https://[::1]:8443",
            "https://pro%62e.example.ts.net",
            " https://probe.example.ts.net",
            "https://probe.example.ts.net ",
            "https://probe_x.example.ts.net",
            "https://-probe.example.ts.net",
            "https://probe.example.ts.net.",
            "https://exämple.ts.net",
            "https://0x7f.0.0.1",
        ] {
            assert!(parse_strict_https_origin(input).is_err(), "accepted {input:?}");
        }
    }

    #[test]
    fn socket_only_on_the_stored_host_and_port() {
        let stored = "https://probe.example.ts.net:8443";
        assert!(socket_target(stored, "wss://probe.example.ts.net:8443/ws?mode=hello").is_ok());
        for bad in [
            "wss://example.com/ws",
            "wss://probe.example.ts.net/ws",
            "wss://probe.example.ts.net:9443/ws",
            "ws://probe.example.ts.net:8443/ws",
            "https://probe.example.ts.net:8443/ws",
            "wss://probe.example.ts.net:8443@example.com/ws",
            "wss://u:p@probe.example.ts.net:8443/ws",
            "wss://probe.example.ts.net.evil.example:8443/ws",
            "wss://probe.example.ts.net:8443/ws#frag",
        ] {
            assert!(socket_target(stored, bad).is_err(), "accepted {bad:?}");
        }
        let default_port = "https://probe.example.ts.net";
        assert!(socket_target(default_port, "wss://probe.example.ts.net/ws").is_ok());
        assert!(socket_target(default_port, "wss://probe.example.ts.net:443/ws").is_ok());
        assert!(socket_target(default_port, "wss://probe.example.ts.net:8443/ws").is_err());
    }
}
