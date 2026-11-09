// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Adapted from the inherited desktop URL policy and health probe, which remain Apache-2.0.
// The new Rust implementation additions follow LICENSE.md.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use serde_json::{json, Value};
use url::{Host, Url};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_PROBE_BYTES: usize = 64 * 1024;
const MAX_SAFE_PROTOCOL_VERSION: f64 = 9_007_199_254_740_991.0;

fn client_protocol_version() -> f64 {
    include_str!("../../../../packages/contracts/src/client-protocol-version.json")
        .trim()
        .parse()
        .expect("The shared client protocol version must be numeric")
}

/// Match the desktop's existing server-origin policy, including private HTTP servers.
pub fn normalize_server_url(input: &str) -> Result<Url, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Enter a server address. Public servers require HTTPS.".into());
    }

    let url = if has_scheme(input) {
        Url::parse(input)
    } else {
        let candidate = Url::parse(&format!("http://{input}"))
            .map_err(|_| "Enter a server address. Public servers require HTTPS.")?;
        if is_private_host(candidate.host()) {
            Ok(candidate)
        } else {
            Url::parse(&format!("https://{input}"))
        }
    }
    .map_err(|_| "Enter a server address. Public servers require HTTPS.")?;

    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || (url.scheme() == "http" && !is_private_host(url.host()))
    {
        return Err("Enter a server address. Public servers require HTTPS.".into());
    }

    // Paths, queries, and fragments cannot change the origin used for auth or RPC.
    Url::parse(&url.origin().ascii_serialization())
        .map_err(|_| "Enter a server address. Public servers require HTTPS.".into())
}

fn has_scheme(input: &str) -> bool {
    let Some((scheme, _)) = input.split_once("://") else {
        return false;
    };
    let mut bytes = scheme.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

// Keep this policy aligned with @orkbot/contracts/network-host. In particular,
// link-local and metadata addresses must not become trusted private HTTP origins.
fn is_private_host(host: Option<Host<&str>>) -> bool {
    match host {
        Some(Host::Domain(name)) => {
            name == "localhost" || name.ends_with(".localhost") || name.ends_with(".local")
        }
        Some(Host::Ipv4(address)) => is_private_ipv4(address),
        Some(Host::Ipv6(address)) => is_private_ipv6(address),
        None => false,
    }
}

fn is_private_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    if octets == [100, 100, 100, 200] {
        return false;
    }
    octets[0] == 127
        || octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
}

fn is_private_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    if segments == [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254] {
        return false;
    }
    address.is_loopback() || (segments[0] & 0xfe00) == 0xfc00
}

/// Check the RPC health contract without following redirects or accepting unbounded bodies.
pub async fn probe_server(server: &Url) -> Result<(), String> {
    let origin = normalize_server_url(server.as_str())?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(PROBE_TIMEOUT)
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|_| "Could not check the server connection.")?;
    let target = origin
        .join("/rpc/health")
        .map_err(|_| "Enter a server address. Public servers require HTTPS.")?;
    let mut response = client
        .post(target)
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .header("x-orkbot-protocol", client_protocol_version().to_string())
        .json(&json!({ "json": {} }))
        .send()
        .await
        .map_err(|_| "Could not connect to the server.")?;

    if response.status().is_redirection() {
        return Err("That address redirects elsewhere. Enter the final Ork server address.".into());
    }
    if !response.status().is_success() {
        return Err(format!(
            "The server answered with HTTP {}.",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROBE_BYTES as u64)
    {
        return Err("The server health response is too large.".into());
    }

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the server health response.")?
    {
        if chunk.len() > MAX_PROBE_BYTES.saturating_sub(body.len()) {
            return Err("The server health response is too large.".into());
        }
        body.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&body)
        .map_err(|_| "That address did not respond like an Ork server.")?;
    if !is_ork_health(&value) {
        return Err("That address did not respond like an Ork server.".into());
    }
    Ok(())
}

/// Require native renderer support and safe sign-in before opening a product renderer.
pub async fn require_accounts_only(server: &Url) -> Result<(), String> {
    const ERROR: &str = "This server must use Accounts sign-in with password sign-in disabled.";
    let origin = normalize_server_url(server.as_str())?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(PROBE_TIMEOUT)
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|_| ERROR)?;
    let mut response = client
        .get(origin.join("/api/auth/capabilities").map_err(|_| ERROR)?)
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .send()
        .await
        .map_err(|_| ERROR)?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_PROBE_BYTES as u64)
    {
        return Err(ERROR.into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ERROR)? {
        if chunk.len() > MAX_PROBE_BYTES.saturating_sub(body.len()) {
            return Err(ERROR.into());
        }
        body.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| ERROR)?;
    if value.get("passwordAuth") != Some(&Value::Bool(false))
        || !(value.get("accountsLogin") == Some(&Value::Bool(true))
            || value.get("sso").is_some_and(|sso| {
                sso.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| !name.trim().is_empty())
                    && sso.get("availability").and_then(Value::as_str) == Some("available")
            }))
    {
        return Err(ERROR.into());
    }
    if value.get("nativeRenderer").and_then(Value::as_str) != Some("bundled-v1") {
        return Err("Update this server before connecting with this version of Ork.".into());
    }
    require_client_protocol(value.get("protocol"))
}

/// Match the shared positive safe-integer range, including JSON numbers written as 1.0.
fn require_client_protocol(range: Option<&Value>) -> Result<(), String> {
    const INVALID: &str = "That address did not respond like an Ork server.";
    let legacy = json!({ "min": 1, "max": 1 });
    let range = range.unwrap_or(&legacy);
    let Some(range) = range.as_object().filter(|range| range.len() == 2) else {
        return Err(INVALID.into());
    };
    let bound = |name| {
        range.get(name).and_then(Value::as_f64).filter(|value| {
            value.is_finite()
                && value.fract() == 0.0
                && *value > 0.0
                && *value <= MAX_SAFE_PROTOCOL_VERSION
        })
    };
    let (Some(min), Some(max)) = (bound("min"), bound("max")) else {
        return Err(INVALID.into());
    };
    if min > max {
        return Err(INVALID.into());
    }
    // Protocol compatibility is enforced by the renderer recovery gate and API.
    // A valid address must remain connectable for authentication and updates.
    Ok(())
}

fn is_ork_health(value: &Value) -> bool {
    value.get("json").is_some_and(|health| {
        health.get("ok") == Some(&Value::Bool(true))
            && health.get("version").is_some_and(Value::is_string)
    })
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread::{self, JoinHandle};
    use std::time::Instant;

    use super::*;

    fn serve_once(response: Vec<u8>) -> (Url, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let handle = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "Health request did not arrive");
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("Could not accept health request: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let size = stream.read(&mut buffer).unwrap();
                assert!(size > 0, "Health request ended before its body");
                request.extend_from_slice(&buffer[..size]);
                assert!(
                    request.len() <= 16 * 1024,
                    "Health request exceeded the test bound"
                );
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")?
                                .trim()
                                .parse::<usize>()
                                .ok()
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            // Oversized responses may be dropped before the final bytes are written.
            let _ = stream.write_all(&response);
            String::from_utf8(request).unwrap()
        });
        (server, handle)
    }

    fn http_response(status: &str, body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ).into_bytes()
    }

    #[test]
    fn public_servers_default_to_https_and_keep_only_the_origin() {
        for (input, expected) in [
            ("orkbot.example.com", "https://orkbot.example.com/"),
            (
                "  https://EXAMPLE.com:443/path?q=1#part  ",
                "https://example.com/",
            ),
            ("https://example.com:8443/path", "https://example.com:8443/"),
            ("192.0.2.1:45173/path", "https://192.0.2.1:45173/"),
            ("[2001:db8::1]:45173", "https://[2001:db8::1]:45173/"),
        ] {
            assert_eq!(
                normalize_server_url(input).unwrap().as_str(),
                expected,
                "{input}"
            );
        }
    }

    #[test]
    fn private_servers_can_use_http() {
        for input in [
            "localhost:45173",
            "app.localhost:45173",
            "server.local:45173",
            "127.0.0.1:45173",
            "127.255.255.254:45173",
            "10.0.0.1:45173",
            "172.16.0.1:45173",
            "172.31.255.254:45173",
            "192.168.0.1:45173",
            "100.64.0.1:45173",
            "100.127.255.254:45173",
            "[::1]:45173",
            "[fc00::1]:45173",
            "[fdff::1]:45173",
        ] {
            let normalized = normalize_server_url(input).unwrap();
            assert_eq!(normalized.scheme(), "http", "{input}");
            assert!(
                normalize_server_url(&format!("http://{input}")).is_ok(),
                "{input}"
            );
        }
    }

    #[test]
    fn public_and_special_addresses_cannot_use_cleartext_http() {
        for host in [
            "example.com",
            "localhost.example.com",
            "localhost.",
            "app.localhost.",
            "server.local.",
            "local",
            "app.local.example.com",
            "172.15.255.255",
            "172.32.0.0",
            "100.63.255.255",
            "100.128.0.0",
            "192.169.0.1",
            "100.100.100.200",
            "169.254.169.254",
            "169.254.1.1",
            "0.0.0.0",
            "224.0.0.1",
            "[::]",
            "[fe80::1]",
            "[::ffff:127.0.0.1]",
            "[::ffff:10.0.0.1]",
            "[fd00:ec2::254]",
            "[2001:db8::1]",
        ] {
            assert!(
                normalize_server_url(&format!("http://{host}:45173")).is_err(),
                "{host}"
            );
        }
    }

    #[test]
    fn rejects_invalid_schemes_and_embedded_credentials() {
        for input in [
            "",
            "   ",
            "file:///tmp/ork",
            "javascript:alert(1)",
            "data:text/html,hello",
            "ftp://example.com",
            "https://",
            "http://",
            "https://user@example.com",
            "https://user:password@example.com",
            "https://:password@example.com",
            "user:password@localhost:45173",
            "http://localhost:99999",
        ] {
            assert!(normalize_server_url(input).is_err(), "{input}");
        }
    }

    #[test]
    fn health_response_matches_the_existing_rpc_contract() {
        assert!(is_ork_health(
            &json!({ "json": { "ok": true, "version": "0.7.0" } })
        ));
        assert!(is_ork_health(
            &json!({ "json": { "ok": true, "version": "" } })
        ));
        for value in [
            json!(null),
            json!([]),
            json!({ "ok": true, "version": "0.7.0" }),
            json!({ "json": null }),
            json!({ "json": { "ok": 1, "version": "0.7.0" } }),
            json!({ "json": { "ok": true, "version": 7 } }),
        ] {
            assert!(!is_ork_health(&value), "{value}");
        }
    }

    #[tokio::test]
    async fn probe_posts_the_health_contract_without_credentials() {
        let (server, request) = serve_once(http_response(
            "200 OK",
            r#"{"json":{"ok":true,"version":"0.7.0"}}"#,
        ));
        assert!(probe_server(&server).await.is_ok());
        let request = request.join().unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        let headers = headers.to_ascii_lowercase();
        assert!(headers.starts_with("post /rpc/health http/1.1\r\n"));
        assert!(headers.contains("content-type: application/json"));
        assert!(headers.contains("cache-control: no-store"));
        assert!(headers.contains("x-orkbot-protocol: 1"));
        assert!(!headers.contains("authorization:"));
        assert!(!headers.contains("cookie:"));
        assert_eq!(
            serde_json::from_str::<Value>(body).unwrap(),
            json!({"json": {}})
        );
    }

    #[tokio::test]
    async fn accounts_only_capability_check_never_sends_central_credentials() {
        let (server, request) = serve_once(http_response(
            "200 OK",
            r#"{"passwordAuth":false,"sso":{"name":"Accounts","availability":"available"},"nativeRenderer":"bundled-v1"}"#,
        ));
        require_accounts_only(&server).await.unwrap();
        let request = request.join().unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /api/auth/capabilities http/1.1\r\n"));
        assert!(!request.contains("authorization:") && !request.contains("cookie:"));
    }

    #[tokio::test]
    async fn accounts_only_capability_check_accepts_native_grants_without_server_oidc() {
        let (server, request) = serve_once(http_response(
            "200 OK",
            r#"{"passwordAuth":false,"accountsLogin":true,"sso":null,"nativeRenderer":"bundled-v1"}"#,
        ));
        require_accounts_only(&server).await.unwrap();
        assert!(!request
            .join()
            .unwrap()
            .to_lowercase()
            .contains("authorization:"));
    }

    #[tokio::test]
    async fn accounts_only_capability_check_requires_the_packaged_renderer_protocol() {
        for capability in [None, Some(json!(true)), Some(json!("bundled-v2"))] {
            let mut value = json!({ "passwordAuth": false, "accountsLogin": true });
            if let Some(capability) = capability {
                value["nativeRenderer"] = capability;
            }
            let (server, request) = serve_once(http_response("200 OK", &value.to_string()));
            assert_eq!(
                require_accounts_only(&server).await.unwrap_err(),
                "Update this server before connecting with this version of Ork."
            );
            request.join().unwrap();
        }
    }

    #[tokio::test]
    async fn accounts_only_capability_check_requires_a_supported_protocol_range() {
        for (range, accepted) in [
            (json!({"min": 1, "max": 1}), true),
            (json!({"min": 1.0, "max": 2.0}), true),
            (json!({"min": 1, "max": 9_007_199_254_740_991_u64}), true),
            (json!({"min": 2, "max": 3}), true),
            (json!({"min": 2, "max": 1}), false),
            (json!({"min": 0, "max": 1}), false),
            (json!({"min": -1, "max": 1}), false),
            (json!({"min": 1.5, "max": 2}), false),
            (json!({"min": "1", "max": 1}), false),
            (json!({"min": 1, "max": 9_007_199_254_740_992_u64}), false),
            (json!({"min": 1}), false),
            (json!({"min": 1, "max": 1, "extra": true}), false),
            (json!(null), false),
            (json!("1"), false),
        ] {
            let value = json!({"passwordAuth": false, "accountsLogin": true,
                "nativeRenderer": "bundled-v1", "protocol": range});
            let (server, request) = serve_once(http_response("200 OK", &value.to_string()));
            let result = require_accounts_only(&server).await;
            if accepted {
                result.unwrap();
            } else {
                let expected = if range == json!({"min": 2, "max": 3}) {
                    "Update Ork to connect to this server."
                } else {
                    "That address did not respond like an Ork server."
                };
                assert_eq!(result.unwrap_err(), expected);
            }
            request.join().unwrap();
        }
    }

    #[tokio::test]
    async fn accounts_only_capability_check_rejects_legacy_unavailable_and_unsafe_responses() {
        for body in [
            r#"{"passwordAuth":true,"accountsLogin":true,"sso":null}"#,
            r#"{"passwordAuth":false,"accountsLogin":"true","sso":null}"#,
            r#"{"passwordAuth":true,"sso":{"name":"Accounts","availability":"available"}}"#,
            r#"{"passwordAuth":false,"sso":null}"#,
            r#"{"passwordAuth":false,"sso":{"name":"Accounts"}}"#,
            r#"{"passwordAuth":false,"sso":{"name":"Accounts","availability":"unavailable"}}"#,
            r#"{"passwordAuth":false,"sso":{"name":"Accounts","availability":"checking"}}"#,
            r#"{"passwordAuth":false,"sso":{"name":" ","availability":"available"}}"#,
            r#"{"passwordAuth":"false","sso":{"name":"Accounts","availability":"available"}}"#,
            "not json",
        ] {
            let (server, request) = serve_once(http_response("200 OK", body));
            assert!(require_accounts_only(&server).await.is_err(), "{body}");
            request.join().unwrap();
        }
        for response in [
            b"HTTP/1.1 302 Found\r\nLocation: https://untrusted.example.com\r\nContent-Length: 0\r\n\r\n".to_vec(),
            http_response("401 Unauthorized", "{}"),
            http_response("200 OK", &" ".repeat(MAX_PROBE_BYTES + 1)),
        ] {
            let (server, request) = serve_once(response);
            assert!(require_accounts_only(&server).await.is_err());
            request.join().unwrap();
        }
    }

    #[tokio::test]
    async fn probe_rejects_redirects_without_following_them() {
        let (server, request) = serve_once(
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        );
        assert_eq!(
            probe_server(&server).await.unwrap_err(),
            "That address redirects elsewhere. Enter the final Ork server address."
        );
        request.join().unwrap();
    }

    #[tokio::test]
    async fn probe_rejects_http_errors_and_non_ork_responses() {
        for (status, body, expected) in [
            (
                "401 Unauthorized",
                "{}",
                "The server answered with HTTP 401.",
            ),
            (
                "200 OK",
                "not JSON",
                "That address did not respond like an Ork server.",
            ),
            (
                "200 OK",
                r#"{"ok":true,"version":"0.7.0"}"#,
                "That address did not respond like an Ork server.",
            ),
        ] {
            let (server, request) = serve_once(http_response(status, body));
            assert_eq!(probe_server(&server).await.unwrap_err(), expected);
            request.join().unwrap();
        }
    }

    #[tokio::test]
    async fn probe_rejects_oversized_declared_and_streamed_bodies() {
        let mut streamed =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
        streamed.extend_from_slice(format!("{:x}\r\n", MAX_PROBE_BYTES + 1).as_bytes());
        streamed.extend(std::iter::repeat_n(b' ', MAX_PROBE_BYTES + 1));
        streamed.extend_from_slice(b"\r\n0\r\n\r\n");
        for response in [
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_PROBE_BYTES + 1
            )
            .into_bytes(),
            streamed,
        ] {
            let (server, request) = serve_once(response);
            assert_eq!(
                probe_server(&server).await.unwrap_err(),
                "The server health response is too large."
            );
            request.join().unwrap();
        }
    }
}
