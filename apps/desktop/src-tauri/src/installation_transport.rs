// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use ork_installation_transport::{HttpHeader, HttpRequest, InstallationConnection, RelayRoute};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::server_directory::WorkspaceTarget;

const ERROR: &str = "Native connection changed";
const MAX_REQUESTS: usize = 256;

#[cfg(test)]
#[path = "installation_transport_probe_tests.rs"]
mod probe_tests;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub account: String,
    pub origin: String,
    pub target: WorkspaceTarget,
    pub relay_origin: Option<String>,
    #[serde(default)]
    pub direct_origin: Option<String>,
    #[serde(default)]
    pub prefer_relay: bool,
}

impl Selection {
    /// Check the pinned installation, using a relay capability only after direct transport fails.
    pub async fn probe_available<F, Fut>(mut self, relay_ticket: F) -> Result<Self, String>
    where
        F: FnOnce(Self) -> Fut,
        Fut: std::future::Future<Output = Result<String, String>>,
    {
        if !self.uses_relay() && self.probe(None).await.is_ok() {
            return Ok(self);
        }
        if self.relay_origin.is_none() {
            return Err("Could not connect to this installation. Try again.".into());
        }
        self.prefer_relay = true;
        let ticket = relay_ticket(self.clone()).await?;
        self.probe(Some(ticket)).await?;
        Ok(self)
    }

    pub fn uses_relay(&self) -> bool {
        self.prefer_relay || (self.direct_origin.is_none() && self.relay_origin.is_some())
    }
    pub fn valid(&self) -> bool {
        if self.target.validate().is_err()
            || self.account.len() != 64
            || !self.account.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return false;
        }
        let Ok(origin) = url::Url::parse(&self.origin) else {
            return false;
        };
        if origin.origin().ascii_serialization() != self.origin
            || !origin.username().is_empty()
            || origin.password().is_some()
        {
            return false;
        }
        if origin.origin() == crate::server_directory::origin().origin()
            || (self.prefer_relay && self.relay_origin.is_none())
        {
            return false;
        }
        if (self.direct_origin.is_some() || self.relay_origin.is_some())
            && self.origin != format!("https://{}.installation.ork.invalid", self.target.server_id)
        {
            return false;
        }
        if let Some(direct) = &self.direct_origin {
            let Ok(parsed) = crate::server::normalize_server_url(direct) else {
                return false;
            };
            if parsed.origin().ascii_serialization() != *direct
                || parsed.origin() == crate::server_directory::origin().origin()
                || InstallationConnection::new(
                    direct.clone(),
                    self.target.server_id.clone(),
                    self.target.binding_version,
                    self.target.key_fingerprint.clone(),
                )
                .is_err()
            {
                return false;
            }
        }
        if let Some(relay) = &self.relay_origin {
            let Ok(parsed) = url::Url::parse(relay) else {
                return false;
            };
            if parsed.scheme() != "https"
                || parsed.origin().ascii_serialization() != *relay
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.origin() == crate::server_directory::origin().origin()
            {
                return false;
            }
        }
        self.uses_relay() || self.connection(None).is_ok()
    }

    pub async fn revoke(&self, token: &str, ticket: Option<String>) -> bool {
        let mut route = self.clone();
        if ticket.is_none() && route.direct_origin.is_some() {
            route.prefer_relay = false;
        }
        let Ok(connection) = route.connection(ticket) else {
            return false;
        };
        let operation = async {
            connection
                .start_request(HttpRequest {
                    method: "POST".into(),
                    path: "/api/auth/sign-out".into(),
                    has_body: true,
                    headers: vec![
                        HttpHeader {
                            name: "authorization".into(),
                            value: format!("Bearer {token}"),
                        },
                        HttpHeader {
                            name: "content-type".into(),
                            value: "application/json".into(),
                        },
                    ],
                })
                .await
                .ok()?;
            connection.write_body(b"{}".to_vec()).await.ok()?;
            connection.finish_body().await.ok()?;
            let head = connection.response_head().await.ok()?;
            if head.status == 401 {
                return Some(true);
            }
            if head.status != 200 {
                return None;
            }
            let mut body = Vec::new();
            while let Some(bytes) = connection.read_body().await.ok()? {
                if bytes.len() > (4096usize).saturating_sub(body.len()) {
                    return None;
                }
                body.extend(bytes);
            }
            let value: Value = serde_json::from_slice(&body).ok()?;
            Some(value["success"] == true)
        };
        let accepted = tokio::time::timeout(Duration::from_secs(8), operation)
            .await
            .ok()
            .flatten()
            .unwrap_or(false);
        connection.cancel();
        accepted
    }
    pub async fn probe(&self, ticket: Option<String>) -> Result<(), String> {
        let connection = self.connection(ticket)?;
        let probe = async {
            connection
                .start_request(HttpRequest {
                    method: "GET".into(),
                    path: "/api/auth/capabilities".into(),
                    headers: vec![],
                    has_body: false,
                })
                .await
                .map_err(|_| ERROR)?;
            let head = connection.response_head().await.map_err(|_| ERROR)?;
            if head.status != 200 {
                return Err(ERROR.to_owned());
            }
            let mut body = Vec::new();
            while let Some(bytes) = connection.read_body().await.map_err(|_| ERROR)? {
                if bytes.len() > (64 * 1024usize).saturating_sub(body.len()) {
                    return Err(ERROR.to_owned());
                }
                body.extend(bytes);
            }
            let capabilities: Value = serde_json::from_slice(&body).map_err(|_| ERROR)?;
            crate::server::require_accounts_capabilities(&capabilities)
        };
        let result = tokio::time::timeout(Duration::from_secs(8), probe)
            .await
            .map_err(|_| ERROR.to_owned());
        connection.cancel();
        result?
    }

    fn connection(&self, ticket: Option<String>) -> Result<Arc<InstallationConnection>, String> {
        self.target.validate()?;
        let target = &self.target;
        match (self.uses_relay(), self.relay_origin.as_ref(), ticket) {
            (true, Some(origin), Some(ticket)) => InstallationConnection::via_relay(
                self.origin.clone(),
                target.server_id.clone(),
                target.binding_version,
                target.key_fingerprint.clone(),
                RelayRoute {
                    origin: origin.clone(),
                    ticket,
                    organization_id: target.organization_id.clone(),
                    workspace_id: target.workspace_id.clone(),
                },
            ),
            (false, _, None) => InstallationConnection::new(
                self.direct_origin
                    .clone()
                    .unwrap_or_else(|| self.origin.clone()),
                target.server_id.clone(),
                target.binding_version,
                target.key_fingerprint.clone(),
            ),
            _ => return Err(ERROR.into()),
        }
        .map_err(|_| ERROR.into())
    }
}

struct Request {
    connection: Arc<InstallationConnection>,
    input: Option<HttpRequest>,
}

struct Context {
    selection: Selection,
    document: Option<String>,
    token: Option<String>,
    blocked: bool,
    authenticating: bool,
    requests: HashMap<String, Request>,
}

impl Context {
    fn cancel(&mut self) {
        for (_, request) in self.requests.drain() {
            request.connection.cancel();
        }
    }
}

impl Drop for Context {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[derive(Default)]
pub struct Transport(
    Mutex<HashMap<String, Context>>,
    tokio::sync::OnceCell<crate::renderer_host::RendererHost>,
);

pub struct LoginGuard<'a> {
    transport: &'a Transport,
    label: String,
    document: String,
}
impl Drop for LoginGuard<'_> {
    fn drop(&mut self) {
        let _ = self
            .transport
            .with_context(&self.label, &self.document, true, |context| {
                context.authenticating = false;
                Ok(())
            });
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    method: String,
    path: String,
    headers: Vec<Header>,
    #[serde(rename = "hasBody")]
    has_body: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    name: String,
    value: String,
}

impl Transport {
    pub fn begin_login(&self, label: &str, document: &str) -> Result<LoginGuard<'_>, String> {
        self.with(label, document, |context| {
            if context.authenticating {
                return Err(ERROR.into());
            }
            context.authenticating = true;
            Ok(())
        })?;
        Ok(LoginGuard {
            transport: self,
            label: label.into(),
            document: document.into(),
        })
    }
    pub async fn renderer(&self, directory: &std::path::Path) -> Result<url::Url, String> {
        Ok(self
            .1
            .get_or_try_init(|| crate::renderer_host::RendererHost::start(directory))
            .await?
            .origin
            .clone())
    }

    pub fn logical_origin(&self, label: &str, physical: &url::Url) -> Option<url::Url> {
        let renderer = self.1.get()?;
        if physical.origin() != renderer.origin.origin() {
            return None;
        }
        url::Url::parse(&self.selected(label)?.origin).ok()
    }
    pub fn select(&self, label: &str, selection: Selection) -> Result<(), String> {
        selection.target.validate()?;
        if !selection.valid() {
            return Err(ERROR.into());
        }
        // Validate direct selections before granting the document any native network authority.
        if !selection.uses_relay() {
            selection.connection(None)?.cancel();
        }
        self.0.lock().map_err(|_| ERROR)?.insert(
            label.into(),
            Context {
                selection,
                document: None,
                token: None,
                blocked: false,
                authenticating: false,
                requests: HashMap::new(),
            },
        );
        Ok(())
    }

    pub fn selected(&self, label: &str) -> Option<Selection> {
        self.0
            .lock()
            .ok()?
            .get(label)
            .map(|context| context.selection.clone())
    }
    pub fn active_selection(&self, label: &str, document: &str) -> Result<Selection, String> {
        self.with(label, document, |context| Ok(context.selection.clone()))
    }

    pub fn document(&self, label: &str, document: &str) {
        if let Ok(mut contexts) = self.0.lock() {
            if let Some(context) = contexts.get_mut(label) {
                if context.document.as_deref() != Some(document) {
                    context.cancel();
                    context.document = Some(document.into());
                    context.authenticating = false;
                }
            }
        }
    }

    pub fn remove(&self, label: &str) {
        if let Ok(mut contexts) = self.0.lock() {
            contexts.remove(label);
        }
    }

    pub fn block_all(&self) {
        if let Ok(mut contexts) = self.0.lock() {
            for context in contexts.values_mut() {
                context.blocked = true;
                context.cancel();
            }
        }
    }

    pub fn retire_session(
        &self,
        label: &str,
        document: &str,
    ) -> Result<Option<(Selection, String)>, String> {
        self.with_context(label, document, true, |context| {
            context.cancel();
            Ok(context
                .token
                .take()
                .map(|token| (context.selection.clone(), token)))
        })
    }

    pub fn captured_session(
        &self,
        label: &str,
        document: &str,
    ) -> Result<Option<(Selection, String)>, String> {
        self.with_context(label, document, true, |context| {
            Ok(context
                .token
                .as_ref()
                .map(|token| (context.selection.clone(), token.clone())))
        })
    }

    fn with<T>(
        &self,
        label: &str,
        document: &str,
        work: impl FnOnce(&mut Context) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_context(label, document, false, work)
    }

    fn with_context<T>(
        &self,
        label: &str,
        document: &str,
        allow_blocked: bool,
        work: impl FnOnce(&mut Context) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut contexts = self.0.lock().map_err(|_| ERROR)?;
        let context = contexts.get_mut(label).ok_or(ERROR)?;
        if context.document.as_deref() != Some(document) || (context.blocked && !allow_blocked) {
            return Err(ERROR.into());
        }
        work(context)
    }

    pub fn token(&self, label: &str, document: &str, token: String) -> Result<(), String> {
        if token.is_empty()
            || token.len() > 16 * 1024
            || token.bytes().any(|c| !c.is_ascii_graphic())
        {
            return Err(ERROR.into());
        }
        self.with(label, document, |context| {
            context.token = Some(token);
            Ok(())
        })
    }

    pub fn open(
        &self,
        label: &str,
        document: &str,
        id: &str,
        input: &str,
        ticket: Option<String>,
    ) -> Result<(), String> {
        if !crate::server_directory::uuid(id) || input.len() > 64 * 1024 {
            return Err(ERROR.into());
        }
        let input: Input = serde_json::from_str(input).map_err(|_| ERROR)?;
        if input.headers.len() > 128 {
            return Err(ERROR.into());
        }
        self.with(label, document, |context| {
            if context.requests.len() >= MAX_REQUESTS || context.requests.contains_key(id) {
                return Err(ERROR.into());
            }
            let mut headers = Vec::new();
            for header in input.headers {
                if header.name.len() > 256 || header.value.len() > 16 * 1024 {
                    return Err(ERROR.into());
                }
                if matches!(
                    header.name.to_ascii_lowercase().as_str(),
                    "authorization"
                        | "cookie"
                        | "host"
                        | "origin"
                        | "referer"
                        | "forwarded"
                        | "proxy-authorization"
                ) || header.name.to_ascii_lowercase().starts_with("x-forwarded-")
                {
                    continue;
                }
                headers.push(HttpHeader {
                    name: header.name,
                    value: header.value,
                });
            }
            if let Some(token) = &context.token {
                headers.push(HttpHeader {
                    name: "authorization".into(),
                    value: format!("Bearer {token}"),
                });
            }
            let connection = context.selection.connection(ticket)?;
            let input = HttpRequest {
                method: input.method,
                path: input.path,
                headers,
                has_body: input.has_body,
            };
            input.validate().map_err(|_| ERROR)?;
            context.requests.insert(
                id.into(),
                Request {
                    connection,
                    input: Some(input),
                },
            );
            Ok(())
        })
    }

    fn request(
        &self,
        label: &str,
        document: &str,
        id: &str,
    ) -> Result<Arc<InstallationConnection>, String> {
        self.with(label, document, |context| {
            context
                .requests
                .get(id)
                .map(|r| r.connection.clone())
                .ok_or(ERROR.into())
        })
    }

    pub async fn start(&self, label: &str, document: &str, id: &str) -> Result<(), String> {
        let (connection, input) = self.with(label, document, |context| {
            let request = context.requests.get_mut(id).ok_or(ERROR)?;
            Ok((
                request.connection.clone(),
                request.input.take().ok_or(ERROR)?,
            ))
        })?;
        connection
            .start_request(input)
            .await
            .map_err(|_| ERROR.to_owned())
    }

    pub async fn write(
        &self,
        label: &str,
        document: &str,
        id: &str,
        encoded: &str,
    ) -> Result<bool, String> {
        if encoded.len() > 88 * 1024 {
            return Err(ERROR.into());
        }
        let bytes = STANDARD.decode(encoded).map_err(|_| ERROR)?;
        if bytes.len() > 64 * 1024 {
            return Err(ERROR.into());
        }
        self.request(label, document, id)?
            .write_body(bytes)
            .await
            .map_err(|_| ERROR.into())
    }

    pub async fn finish(&self, label: &str, document: &str, id: &str) -> Result<(), String> {
        self.request(label, document, id)?
            .finish_body()
            .await
            .map_err(|_| ERROR.into())
    }

    pub async fn head(&self, label: &str, document: &str, id: &str) -> Result<Value, String> {
        let head = self
            .request(label, document, id)?
            .response_head()
            .await
            .map_err(|_| ERROR)?;
        self.request(label, document, id)?;
        Ok(
            json!({ "status": head.status, "headers": head.headers.into_iter()
            .filter(|h| !matches!(h.name.to_ascii_lowercase().as_str(), "set-cookie" | "set-auth-token"))
            .map(|h| json!({ "name": h.name, "value": h.value })).collect::<Vec<_>>() }),
        )
    }

    pub async fn read(
        &self,
        label: &str,
        document: &str,
        id: &str,
    ) -> Result<Option<String>, String> {
        let bytes = self
            .request(label, document, id)?
            .read_body()
            .await
            .map_err(|_| ERROR)?;
        self.request(label, document, id)?;
        if bytes.is_none() {
            self.cancel(label, document, id);
        }
        Ok(bytes.map(|bytes| STANDARD.encode(bytes)))
    }

    pub fn cancel(&self, label: &str, document: &str, id: &str) {
        let _ = self.with(label, document, |context| {
            if let Some(request) = context.requests.remove(id) {
                request.connection.cancel();
            }
            Ok(())
        });
    }

    /// Authentication is bounded and consumes only a fresh native connection to this installation.
    pub async fn json(
        &self,
        label: &str,
        document: &str,
        path: &str,
        body: Value,
        ticket: Option<String>,
    ) -> Result<Value, String> {
        let selection = self.with(label, document, |context| Ok(context.selection.clone()))?;
        let connection = selection.connection(ticket)?;
        // Keep the authentication operation in the same cancellation table as ordinary requests.
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| ERROR)?;
        let id = format!("auth-{}", STANDARD.encode(random));
        self.with(label, document, |context| {
            if context.requests.len() >= MAX_REQUESTS {
                return Err(ERROR.into());
            }
            context.requests.insert(
                id.clone(),
                Request {
                    connection: connection.clone(),
                    input: None,
                },
            );
            Ok(())
        })?;
        let operation = async {
            let body = serde_json::to_vec(&body).map_err(|_| ERROR)?;
            if body.len() > 64 * 1024 {
                return Err(ERROR.to_owned());
            }
            connection
                .start_request(HttpRequest {
                    method: "POST".into(),
                    path: path.into(),
                    has_body: true,
                    headers: vec![HttpHeader {
                        name: "content-type".into(),
                        value: "application/json".into(),
                    }],
                })
                .await
                .map_err(|_| ERROR)?;
            connection.write_body(body).await.map_err(|_| ERROR)?;
            connection.finish_body().await.map_err(|_| ERROR)?;
            let head = connection.response_head().await.map_err(|_| ERROR)?;
            if !(200..300).contains(&head.status) {
                return Err(ERROR.to_owned());
            }
            let mut body = Vec::new();
            while let Some(bytes) = connection.read_body().await.map_err(|_| ERROR)? {
                if bytes.len() > (64 * 1024usize).saturating_sub(body.len()) {
                    return Err(ERROR.to_owned());
                }
                body.extend(bytes);
            }
            self.with(label, document, |_| Ok(()))?;
            serde_json::from_slice(&body).map_err(|_| ERROR.to_owned())
        };
        let result = tokio::time::timeout(Duration::from_secs(15), operation)
            .await
            .map_err(|_| ERROR.to_owned());
        self.cancel(label, document, &id);
        connection.cancel();
        result?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selection() -> Selection {
        Selection {
            account: "a".repeat(64),
            origin: "https://installation.example.test".into(),
            relay_origin: None,
            direct_origin: None,
            prefer_relay: false,
            target: WorkspaceTarget {
                organization_id: "11111111-1111-4111-8111-111111111111".into(),
                server_id: "22222222-2222-4222-8222-222222222222".into(),
                workspace_id: "33333333-3333-4333-8333-333333333333".into(),
                binding_version: 1,
                key_fingerprint: "b".repeat(64),
            },
        }
    }
    #[test]
    fn route_changes_preserve_logical_scope_and_validate_both_pinned_routes() {
        let mut route = selection();
        route.origin = format!(
            "https://{}.installation.ork.invalid",
            route.target.server_id
        );
        route.direct_origin = Some("http://192.168.1.8:5173".into());
        route.relay_origin = Some("https://relay.example.test".into());
        assert!(route.valid());
        assert!(!route.uses_relay());
        assert!(route.connection(None).is_ok());
        route.prefer_relay = true;
        assert!(route.valid());
        assert!(route.uses_relay());
        assert!(route.connection(None).is_err());
        let logical = route.origin.clone();
        route.prefer_relay = false;
        assert_eq!(route.origin, logical);
        for direct in [
            "http://public.example.test",
            "http://169.254.169.254",
            "https://api.ork.run",
            "https://lan.example.test/path",
        ] {
            route.direct_origin = Some(direct.into());
            assert!(!route.valid(), "{direct}");
        }
        route.direct_origin = Some("https://lan.example.test".into());
        route.origin = "https://another.installation.ork.invalid".into();
        assert!(!route.valid());
    }
    #[test]
    fn authentication_is_serialized_per_document_and_a_stale_guard_cannot_release_a_replacement() {
        let transport = Transport::default();
        transport.select("window", selection()).unwrap();
        transport.document("window", "first");
        let first = transport.begin_login("window", "first").unwrap();
        assert!(transport.begin_login("window", "first").is_err());
        transport.document("window", "second");
        let second = transport.begin_login("window", "second").unwrap();
        drop(first);
        assert!(transport.begin_login("window", "second").is_err());
        drop(second);
        assert!(transport.begin_login("window", "second").is_ok());
        transport.block_all();
        assert!(transport.begin_login("window", "second").is_err());
    }
    const ID: &str = "44444444-4444-4444-8444-444444444444";
    fn input() -> String {
        json!({ "method": "POST", "path": "/rpc/me", "headers": [], "hasBody": false }).to_string()
    }

    #[tokio::test]
    async fn a_local_document_resolves_only_its_own_registered_logical_installation() {
        let transport = Transport::default();
        let dir = tempfile::tempdir().unwrap();
        let local = transport.renderer(dir.path()).await.unwrap();
        transport.select("one", selection()).unwrap();
        assert_eq!(
            transport.logical_origin("one", &local).unwrap().as_str(),
            "https://installation.example.test/"
        );
        assert!(transport.logical_origin("two", &local).is_none());
        assert!(transport
            .logical_origin("one", &url::Url::parse("http://127.0.0.2:1234").unwrap())
            .is_none());
        transport.remove("one");
        assert!(transport.logical_origin("one", &local).is_none());
    }

    #[test]
    fn a_reload_retires_pending_requests_and_never_accepts_the_previous_document() {
        let transport = Transport::default();
        transport.select("window", selection()).unwrap();
        transport.document("window", "first");
        transport
            .open("window", "first", ID, &input(), None)
            .unwrap();
        let request = transport.request("window", "first", ID).unwrap();
        transport.document("window", "second");
        assert!(transport.request("window", "first", ID).is_err());
        assert!(transport
            .open("window", "first", ID, &input(), None)
            .is_err());
        assert!(transport
            .token("window", "first", "retired".into())
            .is_err());
        assert!(transport.request("window", "second", ID).is_err());
        // A held request is canceled even after it left the manager's map.
        let runtime = tokio::runtime::Runtime::new().unwrap();
        assert!(runtime.block_on(request.response_head()).is_err());
    }

    #[test]
    fn native_tokens_replace_renderer_credentials_and_never_cross_windows() {
        let transport = Transport::default();
        transport.select("one", selection()).unwrap();
        transport.select("two", selection()).unwrap();
        transport.document("one", "doc");
        transport.document("two", "doc");
        transport
            .token("one", "doc", "product-session".into())
            .unwrap();
        let input = json!({ "method": "POST", "path": "/rpc/me", "hasBody": false,
            "headers": [{"name":"AUTHORIZATION","value":"Bearer renderer"}, {"name":"Cookie","value":"other"},
            {"name":"Host","value":"evil"}, {"name":"Origin","value":"evil"}, {"name":"x-forwarded-host","value":"evil"}] }).to_string();
        transport.open("one", "doc", ID, &input, None).unwrap();
        transport.open("two", "doc", ID, &input, None).unwrap();
        for (window, expected) in [("one", true), ("two", false)] {
            transport
                .with(window, "doc", |context| {
                    let headers = &context.requests[ID].input.as_ref().unwrap().headers;
                    assert_eq!(
                        headers.iter().filter(|h| h.name == "authorization").count(),
                        usize::from(expected)
                    );
                    assert!(headers.iter().all(|h| !matches!(
                        h.value.as_str(),
                        "Bearer renderer" | "other" | "evil"
                    )));
                    Ok(())
                })
                .unwrap();
        }
        transport.remove("one");
        assert!(transport.selected("one").is_none());
        assert!(transport.selected("two").is_some());
    }

    #[test]
    fn logout_blocks_network_work_before_waiting_for_durable_revocation_storage() {
        let transport = Transport::default();
        transport.select("one", selection()).unwrap();
        transport.document("one", "doc");
        transport
            .token("one", "doc", "captured-session".into())
            .unwrap();
        transport.open("one", "doc", ID, &input(), None).unwrap();
        transport.block_all();
        assert!(transport.open("one", "doc", ID, &input(), None).is_err());
        assert!(transport
            .token("one", "doc", "late-session".into())
            .is_err());
        assert_eq!(
            transport.captured_session("one", "doc").unwrap().unwrap().1,
            "captured-session"
        );
        transport.retire_session("one", "doc").unwrap();
        assert!(transport.captured_session("one", "doc").unwrap().is_none());
        transport.document("one", "replacement-doc");
        assert!(transport
            .open("one", "replacement-doc", ID, &input(), None)
            .is_err());
    }
}
