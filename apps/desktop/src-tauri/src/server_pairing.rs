// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{sync::Mutex, time::Duration};

use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use url::Url;

const ERROR: &str = "Could not complete that request. Try again.";
const ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_BODY: usize = 4096;
// Accounts issues a five-minute ticket; tolerate a small device clock offset at receipt.
const LIFETIME_SECONDS: u64 = 300;
const CLOCK_SKEW_SECONDS: u64 = 30;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pairing {
    pub id: String,
    pub code: String,
    pub origin: String,
    pub expires_at: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pending,
    Ready,
    Failed,
    Expired,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingState {
    pub status: Status,
    pub origin: String,
    pub expires_at: u64,
}

fn valid_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl Pairing {
    fn validate(&self, origin: &str, now: u64) -> Result<(), String> {
        if !valid_id(&self.id)
            || self.code.len() != 6
            || !self.code.bytes().all(|byte| ALPHABET.contains(&byte))
            || self.origin != origin
            || self.expires_at <= now
            || self.expires_at > now.saturating_add(LIFETIME_SECONDS + CLOCK_SKEW_SECONDS)
        {
            return Err(ERROR.into());
        }
        Ok(())
    }
}

pub struct Broker {
    endpoint: Url,
    client: Client,
}

impl Broker {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            endpoint: crate::server_directory::origin()
                .join("/api/server-pairings")
                .map_err(|_| ERROR)?,
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|_| ERROR)?,
        })
    }

    async fn request<T: serde::de::DeserializeOwned>(
        &self,
        method: Method,
        url: Url,
        bearer: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T, String> {
        let mut request = self.client.request(method, url).bearer_auth(bearer);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request.send().await.map_err(|_| ERROR)?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|size| size > MAX_BODY as u64)
        {
            return Err(ERROR.into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ERROR)? {
            if chunk.len() > MAX_BODY.saturating_sub(bytes.len()) {
                return Err(ERROR.into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| ERROR.into())
    }

    pub async fn create(&self, bearer: &str, origin: &str) -> Result<Pairing, String> {
        let pairing: Pairing = self
            .request(
                Method::POST,
                self.endpoint.clone(),
                bearer,
                Some(serde_json::json!({"origin": origin})),
            )
            .await?;
        pairing.validate(
            origin,
            time::OffsetDateTime::now_utc().unix_timestamp().max(0) as u64,
        )?;
        Ok(pairing)
    }

    fn item(&self, id: &str) -> Result<Url, String> {
        if !valid_id(id) {
            return Err(ERROR.into());
        }
        let mut url = self.endpoint.clone();
        url.path_segments_mut().map_err(|_| ERROR)?.push(id);
        Ok(url)
    }

    pub async fn status(&self, bearer: &str, pairing: &Pairing) -> Result<PairingState, String> {
        let state: PairingState = self
            .request(Method::GET, self.item(&pairing.id)?, bearer, None)
            .await?;
        if state.origin != pairing.origin || state.expires_at != pairing.expires_at {
            return Err(ERROR.into());
        }
        Ok(state)
    }

    pub async fn cancel(&self, bearer: &str, id: &str) -> Result<(), String> {
        let response = self
            .client
            .delete(self.item(id)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ERROR)?;
        if response.status() != StatusCode::NO_CONTENT {
            return Err(ERROR.into());
        }
        Ok(())
    }
}

pub struct Attempt {
    request: String,
    owner: String,
    gate: u64,
    pub origin: String,
    bearer: String,
    pub pairing: Option<Pairing>,
}

impl Attempt {
    pub fn cancel(self) {
        if let Some(pairing) = self.pairing {
            cancel_background(self.bearer, pairing.id);
        }
    }
}

pub fn cancel_background(bearer: String, id: String) {
    tauri::async_runtime::spawn(async move {
        if let Ok(broker) = Broker::new() {
            let _ = broker.cancel(&bearer, &id).await;
        }
    });
}

#[derive(Default)]
pub struct Attempts(Mutex<Option<Attempt>>);

impl Attempts {
    pub fn begin(
        &self,
        request: String,
        owner: String,
        gate: u64,
        origin: String,
        bearer: String,
    ) -> Result<(), String> {
        if request.is_empty()
            || request.len() > 64
            || !request
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(ERROR.into());
        }
        let previous = self.0.lock().map_err(|_| ERROR)?.replace(Attempt {
            request,
            owner,
            gate,
            origin,
            bearer,
            pairing: None,
        });
        if let Some(previous) = previous {
            previous.cancel();
        }
        Ok(())
    }

    pub fn bind(
        &self,
        request: &str,
        owner: &str,
        gate: u64,
        bearer: &str,
    ) -> Result<bool, String> {
        let mut active = self.0.lock().map_err(|_| ERROR)?;
        let Some(active) = active.as_mut().filter(|active| {
            active.request == request && active.gate == gate && active.owner.is_empty()
        }) else {
            return Ok(false);
        };
        active.owner = owner.into();
        active.bearer = bearer.into();
        Ok(true)
    }

    pub fn matches(&self, request: &str, owner: &str, gate: u64) -> bool {
        self.0.lock().ok().is_some_and(|active| {
            active.as_ref().is_some_and(|active| {
                active.request == request && active.owner == owner && active.gate == gate
            })
        })
    }

    pub fn finish(
        &self,
        request: &str,
        owner: &str,
        gate: u64,
        pairing: Pairing,
    ) -> Result<bool, String> {
        let mut active = self.0.lock().map_err(|_| ERROR)?;
        let Some(active) = active.as_mut().filter(|active| {
            active.request == request
                && active.owner == owner
                && active.gate == gate
                && active.origin == pairing.origin
        }) else {
            return Ok(false);
        };
        active.pairing = Some(pairing);
        Ok(true)
    }

    pub fn pairing(&self, request: &str, owner: &str, gate: u64) -> Result<Pairing, String> {
        self.0
            .lock()
            .map_err(|_| ERROR)?
            .as_ref()
            .filter(|active| {
                active.request == request && active.owner == owner && active.gate == gate
            })
            .and_then(|active| active.pairing.clone())
            .ok_or_else(|| ERROR.into())
    }

    pub fn take(&self, request: Option<&str>) -> Option<Attempt> {
        let mut active = self.0.lock().ok()?;
        if request.is_some_and(|request| {
            active
                .as_ref()
                .is_none_or(|active| active.request != request)
        }) {
            return None;
        }
        active.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairing() -> Pairing {
        Pairing {
            id: "a".repeat(64),
            code: "2A3B4C".into(),
            origin: "https://server.example.test".into(),
            expires_at: 1300,
        }
    }

    #[test]
    fn validates_code_origin_identifier_and_bounded_lifetime() {
        let value = pairing();
        value.validate(&value.origin, 1000).unwrap();
        for code in [
            "ABC123", "AAAAA0", "AAAAAI", "AAAAAO", "abcdef", "ABCDE", "ABCDEFG",
        ] {
            let mut invalid = value.clone();
            invalid.code = code.into();
            assert!(invalid.validate(&value.origin, 1000).is_err());
        }
        for id in ["../path".into(), "A".repeat(64), "a".repeat(63)] {
            let mut invalid = value.clone();
            invalid.id = id;
            assert!(invalid.validate(&value.origin, 1000).is_err());
        }
        assert!(value
            .validate("https://another.example.test", 1000)
            .is_err());
        assert!(value.validate(&value.origin, 1300).is_err());
        assert!(value.validate(&value.origin, 900).is_err());
    }

    #[test]
    fn stale_results_and_cancellations_cannot_replace_a_new_account_attempt() {
        let state = Attempts::default();
        let value = pairing();
        state
            .begin(
                "first".into(),
                "account-a".into(),
                1,
                value.origin.clone(),
                "fixture-bearer".into(),
            )
            .unwrap();
        state.take(Some("first")).unwrap();
        state
            .begin(
                "second".into(),
                "account-b".into(),
                2,
                value.origin.clone(),
                "other-fixture-bearer".into(),
            )
            .unwrap();
        assert!(!state
            .finish("first", "account-a", 1, value.clone())
            .unwrap());
        assert!(state.take(Some("first")).is_none());
        assert!(!state.matches("second", "account-a", 2));
        assert!(!state.matches("second", "account-b", 1));
        assert!(state.finish("second", "account-b", 2, value).unwrap());
        assert!(state.pairing("second", "account-b", 2).is_ok());
        assert!(state.take(None).is_some());
        assert!(state.pairing("second", "account-b", 2).is_err());
    }

    #[test]
    fn cancellation_during_authorization_prevents_a_late_create_from_binding() {
        let state = Attempts::default();
        state
            .begin(
                "first".into(),
                String::new(),
                1,
                pairing().origin,
                String::new(),
            )
            .unwrap();
        state.take(Some("first")).unwrap();
        assert!(!state.bind("first", "owner", 1, "fixture-bearer").unwrap());
    }

    async fn fixture(
        status: &str,
        body: String,
        extra: &str,
    ) -> (Broker, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Url::parse(&format!(
            "http://{}/api/server-pairings",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let wire = format!(
            "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut part = [0; 4096];
                let size = stream.read(&mut part).await.unwrap();
                assert!(size > 0);
                bytes.extend_from_slice(&part[..size]);
                let text = String::from_utf8_lossy(&bytes);
                if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                    let size = headers
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|size| size.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if body.len() >= size {
                        break;
                    }
                }
            }
            let _ = stream.write_all(wire.as_bytes()).await;
            String::from_utf8(bytes).unwrap()
        });
        (
            Broker {
                endpoint,
                client: Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(2))
                    .build()
                    .unwrap(),
            },
            task,
        )
    }

    #[tokio::test]
    async fn create_sends_only_native_bearer_and_canonical_origin_without_browser_headers() {
        let mut value = pairing();
        value.expires_at = time::OffsetDateTime::now_utc().unix_timestamp() as u64 + 300;
        let (broker, request) =
            fixture("201 Created", serde_json::to_string(&value).unwrap(), "").await;
        let created = broker
            .create("fixture-central-bearer", &value.origin)
            .await
            .unwrap();
        assert_eq!(created.id, value.id);
        let request = request.await.unwrap();
        assert!(request.starts_with("POST /api/server-pairings HTTP/1.1"));
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(headers
            .to_lowercase()
            .contains("authorization: bearer fixture-central-bearer"));
        assert!(!headers.to_lowercase().contains("\r\norigin:"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(body).unwrap(),
            serde_json::json!({"origin": value.origin})
        );
    }

    #[tokio::test]
    async fn status_rejects_a_different_origin_expiry_or_unknown_phase() {
        let value = pairing();
        for body in [
            serde_json::json!({"status":"ready", "origin":"https://another.example.test", "expiresAt":1300}),
            serde_json::json!({"status":"ready", "origin":value.origin, "expiresAt":1400}),
            serde_json::json!({"status":"other", "origin":value.origin, "expiresAt":1300}),
        ] {
            let (broker, request) = fixture("200 OK", body.to_string(), "").await;
            assert!(broker.status("fixture-bearer", &value).await.is_err());
            let request = request.await.unwrap();
            assert!(request.starts_with(&format!("GET /api/server-pairings/{} HTTP/1.1", value.id)));
        }
        let (broker, request) = fixture(
            "200 OK",
            serde_json::json!({"status":"ready", "origin":value.origin, "expiresAt":1300})
                .to_string(),
            "",
        )
        .await;
        assert_eq!(
            broker
                .status("fixture-bearer", &value)
                .await
                .unwrap()
                .status,
            Status::Ready
        );
        request.await.unwrap();
    }

    #[tokio::test]
    async fn delete_checks_the_http_status_and_never_puts_the_bearer_in_the_url() {
        for (status, accepted) in [
            ("204 No Content", true),
            ("200 OK", false),
            ("403 Forbidden", false),
        ] {
            let (broker, request) = fixture(status, String::new(), "").await;
            assert_eq!(
                broker.cancel("fixture-bearer", &pairing().id).await.is_ok(),
                accepted
            );
            let request = request.await.unwrap();
            assert!(request.starts_with(&format!(
                "DELETE /api/server-pairings/{} HTTP/1.1",
                pairing().id
            )));
            assert!(!request.lines().next().unwrap().contains("fixture-bearer"));
        }
    }

    #[tokio::test]
    async fn redirects_and_oversized_responses_are_rejected() {
        for (status, body, headers) in [
            (
                "302 Found",
                "{}".into(),
                "Location: https://unrelated.example.test\r\n",
            ),
            ("200 OK", "x".repeat(MAX_BODY + 1), ""),
        ] {
            let (broker, request) = fixture(status, body, headers).await;
            assert!(broker
                .create("fixture-bearer", &pairing().origin)
                .await
                .is_err());
            request.await.unwrap();
        }
    }
}
