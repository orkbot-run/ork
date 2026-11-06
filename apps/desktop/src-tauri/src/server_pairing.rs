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
    pub expires_at: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Pending,
    ApprovalRequired,
    Approved,
    Ready,
    Failed,
    Expired,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingState {
    pub status: Status,
    pub origin: Option<String>,
    pub expires_at: u64,
}

fn valid_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl Pairing {
    fn validate(&self, now: u64) -> Result<(), String> {
        if !valid_id(&self.id)
            || self.code.len() != 6
            || !self.code.bytes().all(|byte| ALPHABET.contains(&byte))
            || self.expires_at <= now
            || self.expires_at > now.saturating_add(LIFETIME_SECONDS + CLOCK_SKEW_SECONDS)
        {
            return Err(ERROR.into());
        }
        Ok(())
    }
}

impl PairingState {
    fn validate(&self, pairing: &Pairing) -> Result<(), String> {
        if self.expires_at != pairing.expires_at {
            return Err(ERROR.into());
        }
        if let Some(origin) = &self.origin {
            if origin.len() > 2048
                || crate::server::normalize_server_url(origin)?
                    .origin()
                    .ascii_serialization()
                    != *origin
            {
                return Err(ERROR.into());
            }
        }
        match self.status {
            Status::Pending if self.origin.is_some() => Err(ERROR.into()),
            Status::ApprovalRequired | Status::Approved | Status::Ready
                if self.origin.is_none() =>
            {
                Err(ERROR.into())
            }
            _ => Ok(()),
        }
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

    pub async fn create(&self, bearer: &str) -> Result<Pairing, String> {
        let pairing: Pairing = self
            .request(
                Method::POST,
                self.endpoint.clone(),
                bearer,
                Some(serde_json::json!({})),
            )
            .await?;
        pairing.validate(time::OffsetDateTime::now_utc().unix_timestamp().max(0) as u64)?;
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
        state.validate(pairing)?;
        Ok(state)
    }

    pub async fn approve(
        &self,
        bearer: &str,
        pairing: &Pairing,
        origin: &str,
    ) -> Result<PairingState, String> {
        let mut url = self.item(&pairing.id)?;
        url.path_segments_mut().map_err(|_| ERROR)?.push("approve");
        let state: PairingState = self
            .request(
                Method::POST,
                url,
                bearer,
                Some(serde_json::json!({"origin": origin})),
            )
            .await?;
        state.validate(pairing)?;
        if state.status != Status::Approved || state.origin.as_deref() != Some(origin) {
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
    origin: Option<String>,
    approved_origin: Option<String>,
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
            origin: None,
            approved_origin: None,
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
            active.request == request && active.owner == owner && active.gate == gate
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

    pub fn observe(
        &self,
        request: &str,
        owner: &str,
        gate: u64,
        state: &PairingState,
    ) -> Result<(), String> {
        let mut guard = self.0.lock().map_err(|_| ERROR)?;
        let active = guard
            .as_mut()
            .filter(|active| {
                active.request == request && active.owner == owner && active.gate == gate
            })
            .ok_or(ERROR)?;
        let pairing = active.pairing.as_ref().ok_or(ERROR)?;
        state.validate(pairing)?;
        if active
            .origin
            .as_ref()
            .is_some_and(|origin| state.origin.as_ref().is_some_and(|next| next != origin))
        {
            return Err(ERROR.into());
        }
        match state.status {
            Status::Pending if active.origin.is_some() => return Err(ERROR.into()),
            Status::ApprovalRequired => active.origin = state.origin.clone(),
            Status::Approved | Status::Ready if active.approved_origin != state.origin => {
                return Err(ERROR.into())
            }
            _ => {}
        }
        Ok(())
    }

    pub fn shown_origin(
        &self,
        request: &str,
        owner: &str,
        gate: u64,
        origin: &str,
    ) -> Result<(), String> {
        let guard = self.0.lock().map_err(|_| ERROR)?;
        let active = guard
            .as_ref()
            .filter(|active| {
                active.request == request && active.owner == owner && active.gate == gate
            })
            .ok_or(ERROR)?;
        if active.origin.as_deref() != Some(origin)
            || active.pairing.as_ref().is_none_or(|pairing| {
                pairing.expires_at <= time::OffsetDateTime::now_utc().unix_timestamp().max(0) as u64
            })
        {
            return Err(ERROR.into());
        }
        Ok(())
    }

    pub fn approved(
        &self,
        request: &str,
        owner: &str,
        gate: u64,
        origin: &str,
    ) -> Result<(), String> {
        let mut guard = self.0.lock().map_err(|_| ERROR)?;
        let active = guard
            .as_mut()
            .filter(|active| {
                active.request == request
                    && active.owner == owner
                    && active.gate == gate
                    && active.origin.as_deref() == Some(origin)
            })
            .ok_or(ERROR)?;
        active.approved_origin = Some(origin.into());
        Ok(())
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
    const ORIGIN: &str = "https://server.example.test";

    fn pairing() -> Pairing {
        Pairing {
            id: "a".repeat(64),
            code: "2A3B4C".into(),
            expires_at: 1300,
        }
    }
    fn state(status: Status, origin: Option<&str>, expires_at: u64) -> PairingState {
        PairingState {
            status,
            origin: origin.map(str::to_owned),
            expires_at,
        }
    }
    fn active() -> (Attempts, Pairing) {
        let attempts = Attempts::default();
        let mut value = pairing();
        value.expires_at = time::OffsetDateTime::now_utc().unix_timestamp() as u64 + 300;
        attempts
            .begin("request".into(), "owner".into(), 1, "fixture-bearer".into())
            .unwrap();
        assert!(attempts
            .finish("request", "owner", 1, value.clone())
            .unwrap());
        (attempts, value)
    }

    #[test]
    fn validates_code_identifier_and_bounded_lifetime_without_a_target() {
        let value = pairing();
        value.validate(1000).unwrap();
        for code in [
            "ABC123", "AAAAA0", "AAAAAI", "AAAAAO", "abcdef", "ABCDE", "ABCDEFG",
        ] {
            let mut invalid = value.clone();
            invalid.code = code.into();
            assert!(invalid.validate(1000).is_err());
        }
        for id in ["../path".into(), "A".repeat(64), "a".repeat(63)] {
            let mut invalid = value.clone();
            invalid.id = id;
            assert!(invalid.validate(1000).is_err());
        }
        assert!(value.validate(1300).is_err());
        assert!(value.validate(900).is_err());
    }

    #[test]
    fn ready_and_approved_states_require_a_previous_explicit_local_approval() {
        let (attempts, value) = active();
        for status in [Status::Approved, Status::Ready] {
            assert!(attempts
                .observe(
                    "request",
                    "owner",
                    1,
                    &state(status, Some(ORIGIN), value.expires_at)
                )
                .is_err());
        }
        assert!(attempts
            .shown_origin("request", "owner", 1, ORIGIN)
            .is_err());
        attempts
            .observe(
                "request",
                "owner",
                1,
                &state(Status::ApprovalRequired, Some(ORIGIN), value.expires_at),
            )
            .unwrap();
        assert!(attempts
            .observe(
                "request",
                "owner",
                1,
                &state(Status::Ready, Some(ORIGIN), value.expires_at)
            )
            .is_err());
        attempts
            .shown_origin("request", "owner", 1, ORIGIN)
            .unwrap();
        attempts.approved("request", "owner", 1, ORIGIN).unwrap();
        attempts
            .observe(
                "request",
                "owner",
                1,
                &state(Status::Ready, Some(ORIGIN), value.expires_at),
            )
            .unwrap();
    }

    #[test]
    fn a_claimed_domain_cannot_be_replaced_or_approved_for_another_account() {
        let (attempts, value) = active();
        attempts
            .observe(
                "request",
                "owner",
                1,
                &state(Status::ApprovalRequired, Some(ORIGIN), value.expires_at),
            )
            .unwrap();
        assert!(attempts
            .observe(
                "request",
                "owner",
                1,
                &state(
                    Status::ApprovalRequired,
                    Some("https://other.example.test"),
                    value.expires_at
                )
            )
            .is_err());
        assert!(attempts
            .shown_origin("request", "owner", 1, "https://other.example.test")
            .is_err());
        assert!(attempts
            .approved("request", "other-owner", 1, ORIGIN)
            .is_err());
        assert!(attempts.approved("request", "owner", 2, ORIGIN).is_err());
        assert!(attempts
            .approved("other-request", "owner", 1, ORIGIN)
            .is_err());
        assert!(attempts
            .observe(
                "request",
                "owner",
                1,
                &state(Status::Pending, None, value.expires_at)
            )
            .is_err());
    }

    #[test]
    fn logout_and_new_account_invalidate_late_approval_without_losing_the_new_attempt() {
        let (attempts, value) = active();
        attempts
            .observe(
                "request",
                "owner",
                1,
                &state(Status::ApprovalRequired, Some(ORIGIN), value.expires_at),
            )
            .unwrap();
        attempts.take(None).unwrap();
        attempts
            .begin(
                "new-request".into(),
                "new-owner".into(),
                2,
                "new-fixture-bearer".into(),
            )
            .unwrap();
        assert!(attempts.approved("request", "owner", 1, ORIGIN).is_err());
        assert!(!attempts.finish("request", "owner", 1, value).unwrap());
        assert!(attempts.take(Some("request")).is_none());
        assert!(attempts.matches("new-request", "new-owner", 2));
    }

    #[test]
    fn cancellation_during_authorization_prevents_a_late_create_from_binding() {
        let state = Attempts::default();
        state
            .begin("first".into(), String::new(), 1, String::new())
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
    async fn create_sends_only_native_bearer_and_an_empty_body_without_browser_headers() {
        let mut value = pairing();
        value.expires_at = time::OffsetDateTime::now_utc().unix_timestamp() as u64 + 300;
        let (broker, request) =
            fixture("201 Created", serde_json::to_string(&value).unwrap(), "").await;
        assert_eq!(
            broker.create("fixture-central-bearer").await.unwrap().id,
            value.id
        );
        let request = request.await.unwrap();
        assert!(request.starts_with("POST /api/server-pairings HTTP/1.1"));
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(headers
            .to_lowercase()
            .contains("authorization: bearer fixture-central-bearer"));
        assert!(!headers.to_lowercase().contains("\r\norigin:"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(body).unwrap(),
            serde_json::json!({})
        );
    }

    #[tokio::test]
    async fn status_rejects_noncanonical_origin_expiry_changes_and_unknown_phases() {
        let value = pairing();
        for body in [
            serde_json::json!({"status":"approval-required", "origin":"https://server.example.test/path", "expiresAt":1300}),
            serde_json::json!({"status":"pending", "origin":ORIGIN, "expiresAt":1300}),
            serde_json::json!({"status":"ready", "origin":null, "expiresAt":1300}),
            serde_json::json!({"status":"ready", "origin":ORIGIN, "expiresAt":1400}),
            serde_json::json!({"status":"other", "origin":ORIGIN, "expiresAt":1300}),
        ] {
            let (broker, request) = fixture("200 OK", body.to_string(), "").await;
            assert!(broker.status("fixture-bearer", &value).await.is_err());
            assert!(request
                .await
                .unwrap()
                .starts_with(&format!("GET /api/server-pairings/{} HTTP/1.1", value.id)));
        }
        let (broker, request) = fixture(
            "200 OK",
            serde_json::json!({"status":"pending", "origin":null, "expiresAt":1300}).to_string(),
            "",
        )
        .await;
        assert_eq!(
            broker
                .status("fixture-bearer", &value)
                .await
                .unwrap()
                .status,
            Status::Pending
        );
        request.await.unwrap();
    }

    #[tokio::test]
    async fn approve_sends_the_exact_shown_origin_and_rejects_a_different_response() {
        let value = pairing();
        for (origin, status, accepted) in [
            (ORIGIN, "approved", true),
            ("https://other.example.test", "approved", false),
            (ORIGIN, "ready", false),
        ] {
            let (broker, request) = fixture(
                "200 OK",
                serde_json::json!({"status":status,"origin":origin,"expiresAt":1300}).to_string(),
                "",
            )
            .await;
            assert_eq!(
                broker
                    .approve("fixture-bearer", &value, ORIGIN)
                    .await
                    .is_ok(),
                accepted
            );
            let request = request.await.unwrap();
            assert!(request.starts_with(&format!(
                "POST /api/server-pairings/{}/approve HTTP/1.1",
                value.id
            )));
            let (headers, body) = request.split_once("\r\n\r\n").unwrap();
            assert!(headers
                .to_lowercase()
                .contains("authorization: bearer fixture-bearer"));
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(body).unwrap(),
                serde_json::json!({"origin": ORIGIN})
            );
        }
    }

    #[tokio::test]
    async fn delete_checks_status_and_never_puts_the_bearer_in_the_url() {
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
            assert!(broker.create("fixture-bearer").await.is_err());
            request.await.unwrap();
        }
    }
}
