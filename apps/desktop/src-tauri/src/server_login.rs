// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use url::Url;

const ERROR: &str = "Could not continue";
const MAX_RESPONSE: usize = 32 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub grant: String,
    pub expires_at: u64,
}

pub fn valid_challenge(challenge: &str) -> bool {
    challenge.len() == 43
        && challenge
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Native document URLs include their current route; only the confirmed origin is an audience.
pub fn audience_for_document(document_url: &Url, requested_origin: &str) -> Result<Url, String> {
    if requested_origin != document_url.origin().ascii_serialization() {
        return Err(ERROR.into());
    }
    crate::server::normalize_server_url(requested_origin)
}

/// This public probe conveys no authority and never sends Accounts credentials to a server.
pub async fn initialization_required(
    origin: &Url,
    current: impl Fn() -> bool,
) -> Result<bool, String> {
    const LIMIT: usize = 1024;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Initialization {
        required: bool,
    }
    if !current() || crate::server::normalize_server_url(origin.as_str())? != *origin {
        return Err(ERROR.into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| ERROR)?;
    let mut response = client
        .get(
            origin
                .join("/api/auth/native/initialization")
                .map_err(|_| ERROR)?,
        )
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .send()
        .await
        .map_err(|_| ERROR)?;
    if !current() {
        return Err(ERROR.into());
    }
    // Older servers can safely be tried through their ordinary, authenticated login path.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|length| length > LIMIT as u64)
    {
        return Err(ERROR.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ERROR)? {
        if !current() || chunk.len() > LIMIT.saturating_sub(bytes.len()) {
            return Err(ERROR.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !current() {
        return Err(ERROR.into());
    }
    let state: Initialization = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    Ok(state.required)
}

pub async fn issue(
    token: &str,
    origin: &Url,
    challenge: &str,
    current: impl Fn() -> bool,
) -> Result<Grant, String> {
    let endpoint = crate::server_directory::origin()
        .join("/api/server-login-grants")
        .map_err(|_| ERROR)?;
    issue_at(&endpoint, token, origin, challenge, current).await
}

async fn issue_at(
    endpoint: &Url,
    token: &str,
    origin: &Url,
    challenge: &str,
    current: impl Fn() -> bool,
) -> Result<Grant, String> {
    if !valid_challenge(challenge) || !current() {
        return Err(ERROR.into());
    }
    let canonical = crate::server::normalize_server_url(origin.as_str())?;
    if canonical != *origin {
        return Err(ERROR.into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| ERROR)?;
    let mut response = client.post(endpoint.clone()).bearer_auth(token).json(&serde_json::json!({"origin": origin.origin().ascii_serialization(), "challenge":challenge})).send().await.map_err(|_| ERROR)?;
    if !current()
        || !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE as u64)
    {
        return Err(ERROR.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ERROR)? {
        if !current() || chunk.len() > MAX_RESPONSE.saturating_sub(bytes.len()) {
            return Err(ERROR.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    let grant = value["grant"]
        .as_str()
        .filter(|grant| {
            grant.len() <= 16 * 1024
                && grant.split('.').count() == 3
                && grant.split('.').all(|part| {
                    !part.is_empty()
                        && part
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                })
        })
        .ok_or(ERROR)?;
    let expires_at = value["expiresAt"].as_u64().ok_or(ERROR)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ERROR)?
        .as_secs();
    if !current() || expires_at <= now || expires_at > now + 65 {
        return Err(ERROR.into());
    }
    Ok(Grant {
        grant: grant.to_owned(),
        expires_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn endpoint(
        status: &str,
        body: String,
        invalidate: Option<Arc<AtomicBool>>,
    ) -> (Url, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "http://{}/api/server-login-grants",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let status = status.to_owned();
        let serving = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let read = stream.read(&mut chunk).await.unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&chunk[..read]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")?
                                .trim()
                                .parse::<usize>()
                                .ok()
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            if let Some(current) = invalidate {
                current.store(false, Ordering::SeqCst);
            }
            stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:1/never\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            String::from_utf8(bytes).unwrap()
        });
        (url, serving)
    }

    #[tokio::test]
    async fn public_initialization_probe_never_sends_bearers_cookies_or_browser_origin() {
        for required in [true, false] {
            let (endpoint, serving) = endpoint(
                "200 OK",
                serde_json::json!({"required": required}).to_string(),
                None,
            )
            .await;
            assert_eq!(
                initialization_required(&endpoint.join("/").unwrap(), || true)
                    .await
                    .unwrap(),
                required
            );
            let request = serving.await.unwrap();
            assert!(request.starts_with("GET /api/auth/native/initialization HTTP/1.1\r\n"));
            let headers = request.to_lowercase();
            for forbidden in ["\r\nauthorization:", "\r\ncookie:", "\r\norigin:"] {
                assert!(!headers.contains(forbidden));
            }
        }
        let (endpoint, serving) = endpoint("404 Not Found", String::new(), None).await;
        assert!(
            !initialization_required(&endpoint.join("/").unwrap(), || true)
                .await
                .unwrap()
        );
        serving.await.unwrap();
    }

    #[tokio::test]
    async fn public_initialization_probe_rejects_redirects_large_or_ambiguous_data() {
        for (status, body) in [
            ("302 Found", "{}".into()),
            ("401 Unauthorized", "{}".into()),
            ("200 OK", "x".repeat(1025)),
            ("200 OK", "{\"required\":\"false\"}".into()),
            ("200 OK", "{\"required\":false,\"other\":true}".into()),
            ("200 OK", "{}".into()),
        ] {
            let (endpoint, serving) = endpoint(status, body, None).await;
            assert!(
                initialization_required(&endpoint.join("/").unwrap(), || true)
                    .await
                    .is_err()
            );
            serving.await.unwrap();
        }
    }

    #[tokio::test]
    async fn cancelled_initialization_probe_cannot_resolve_a_newer_link() {
        let current = Arc::new(AtomicBool::new(true));
        let (endpoint, serving) = endpoint(
            "200 OK",
            "{\"required\":false}".into(),
            Some(current.clone()),
        )
        .await;
        assert!(
            initialization_required(&endpoint.join("/").unwrap(), || current
                .load(Ordering::SeqCst))
            .await
            .is_err()
        );
        serving.await.unwrap();
        assert!(
            initialization_required(&Url::parse("http://127.0.0.1:1").unwrap(), || false)
                .await
                .is_err()
        );
    }

    fn response() -> serde_json::Value {
        serde_json::json!({"grant":"header.payload.signature", "expiresAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()+30})
    }

    #[tokio::test]
    async fn native_bearer_goes_only_to_accounts_and_returned_proof_is_server_scoped() {
        let (endpoint, serving) = endpoint("200 OK", response().to_string(), None).await;
        let origin = Url::parse("https://server.example.test").unwrap();
        let challenge = "a".repeat(43);
        let result = issue_at(
            &endpoint,
            "native-fixture-bearer",
            &origin,
            &challenge,
            || true,
        )
        .await
        .unwrap();
        assert_eq!(result.grant, "header.payload.signature");
        let request = serving.await.unwrap();
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer native-fixture-bearer\r\n"));
        assert!(request.starts_with("POST /api/server-login-grants HTTP/1.1\r\n"));
        let body: serde_json::Value =
            serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"origin":"https://server.example.test", "challenge":challenge})
        );
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("native-fixture-bearer"));
    }

    #[tokio::test]
    async fn a_native_document_on_signup_requests_a_grant_for_the_origin_alone() {
        let sessions = crate::native::Sessions::default();
        let server = Url::parse("https://server.example.test").unwrap();
        let proof = sessions.insert("server-1", &server).unwrap();
        let route = server.join("/sign-up?next=%2Fapp").unwrap();
        let (document, _) = sessions
            .authorize("server-1", &route, &proof, &"a".repeat(64), Some(1))
            .unwrap();
        assert_eq!(document.origin.path(), "/sign-up");
        let origin =
            audience_for_document(&document.origin, "https://server.example.test").unwrap();
        assert_eq!(origin, server);
        let (endpoint, serving) = endpoint("200 OK", response().to_string(), None).await;
        let challenge = "a".repeat(43);
        issue_at(
            &endpoint,
            "native-fixture-bearer",
            &origin,
            &challenge,
            || sessions.is_current(&document),
        )
        .await
        .unwrap();
        let request = serving.await.unwrap();
        let body: serde_json::Value =
            serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"origin":"https://server.example.test", "challenge":challenge})
        );
        assert!(audience_for_document(&document.origin, "https://other.example.test").is_err());
        assert!(
            audience_for_document(&document.origin, "https://server.example.test/sign-up").is_err()
        );
        assert!(issue_at(
            &Url::parse("http://127.0.0.1:1/never").unwrap(),
            "native-fixture-bearer",
            &document.origin,
            &challenge,
            || true
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn failures_redirects_stale_accounts_and_unbounded_proofs_are_not_returned() {
        let mut expired = response();
        expired["expiresAt"] = serde_json::json!(1);
        let mut oversized = response();
        oversized["grant"] = serde_json::json!("a".repeat(MAX_RESPONSE));
        for (status, body) in [
            ("302 Found", response()),
            ("401 Unauthorized", response()),
            ("200 OK", expired),
            ("200 OK", oversized),
            ("200 OK", serde_json::json!({"grant":"not a proof"})),
        ] {
            let (endpoint, serving) = endpoint(status, body.to_string(), None).await;
            assert!(issue_at(
                &endpoint,
                "native-fixture-bearer",
                &Url::parse("https://server.example.test").unwrap(),
                &"a".repeat(43),
                || true
            )
            .await
            .is_err());
            serving.await.unwrap();
        }
        let current = Arc::new(AtomicBool::new(true));
        let (endpoint, serving) =
            endpoint("200 OK", response().to_string(), Some(current.clone())).await;
        assert!(issue_at(
            &endpoint,
            "native-fixture-bearer",
            &Url::parse("https://server.example.test").unwrap(),
            &"a".repeat(43),
            || current.load(Ordering::SeqCst)
        )
        .await
        .is_err());
        serving.await.unwrap();
    }

    #[tokio::test]
    async fn invalid_challenges_or_cancelled_attempts_never_send_a_request() {
        let endpoint = Url::parse("http://127.0.0.1:1/never").unwrap();
        for challenge in ["", "a", &"a".repeat(44), &format!("{}=", "a".repeat(42))] {
            assert!(!valid_challenge(challenge));
            assert!(issue_at(
                &endpoint,
                "native-fixture-bearer",
                &Url::parse("https://server.example.test").unwrap(),
                challenge,
                || true
            )
            .await
            .is_err());
        }
        assert!(issue_at(
            &endpoint,
            "native-fixture-bearer",
            &Url::parse("https://server.example.test").unwrap(),
            &"a".repeat(43),
            || false
        )
        .await
        .is_err());
    }
}
