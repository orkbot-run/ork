// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{fs, io::Read, path::Path, time::Duration};

use reqwest::{Client, Method, Response, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use url::Url;

use crate::server::normalize_server_url;

const API: &str = "https://api.orkbot.run/api/servers";
const ERROR: &str = "Could not update your servers. Try again.";
const MAX_BODY: usize = 1024 * 1024;
const DEVICE_FILE: &str = "directory-device-id";

pub fn origin() -> Url {
    Url::parse("https://api.orkbot.run").expect("The Accounts directory origin is fixed")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Local,
    Selfhosted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Server {
    pub id: String,
    pub url: String,
    pub kind: Kind,
    pub device_id: Option<String>,
}

impl Server {
    fn validate(&self, device_id: &str) -> Result<(), String> {
        let url = normalize_server_url(&self.url)?;
        if !uuid(&self.id) || self.url != url.origin().ascii_serialization() {
            return Err(ERROR.into());
        }
        match self.kind {
            Kind::Local
                if self.device_id.as_deref() == Some(device_id)
                    && url.scheme() == "http"
                    && url.host_str() == Some("127.0.0.1")
                    && url.port().is_some_and(|port| port >= 1024) => {}
            Kind::Selfhosted if self.device_id.is_none() => {}
            _ => return Err(ERROR.into()),
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct List {
    servers: Vec<Server>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Added {
    server: Server,
}

pub struct Directory {
    endpoint: Url,
    client: Client,
}

impl Directory {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            endpoint: Url::parse(API).expect("The Accounts directory endpoint is fixed"),
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|_| ERROR)?,
        })
    }

    async fn send(
        &self,
        method: Method,
        url: Url,
        token: &str,
        body: Option<serde_json::Value>,
    ) -> Result<Response, String> {
        let mut request = self.client.request(method, url).bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| ERROR)?;
        match response.status() {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                Err("Sign in to Accounts again.".into())
            }
            status if status.is_success() => Ok(response),
            _ => Err(ERROR.into()),
        }
    }

    pub async fn list(&self, token: &str, device_id: &str) -> Result<Vec<Server>, String> {
        let mut url = self.endpoint.clone();
        url.query_pairs_mut().append_pair("deviceId", device_id);
        let list: List = json(self.send(Method::GET, url, token, None).await?).await?;
        if list.servers.len() > 1000 {
            return Err(ERROR.into());
        }
        let mut ids = std::collections::HashSet::new();
        for server in &list.servers {
            server.validate(device_id)?;
            if !ids.insert(&server.id) {
                return Err(ERROR.into());
            }
        }
        Ok(list.servers)
    }

    pub async fn add(
        &self,
        token: &str,
        url: &Url,
        kind: Kind,
        device_id: &str,
    ) -> Result<Server, String> {
        let origin = url.origin().ascii_serialization();
        let mut body = serde_json::json!({ "url": origin, "kind": kind });
        if kind == Kind::Local {
            body["deviceId"] = serde_json::json!(device_id);
        }
        let added: Added = json(
            self.send(Method::POST, self.endpoint.clone(), token, Some(body))
                .await?,
        )
        .await?;
        added.server.validate(device_id)?;
        if added.server.url != origin || added.server.kind != kind {
            return Err(ERROR.into());
        }
        Ok(added.server)
    }

    pub async fn remove(&self, token: &str, id: &str) -> Result<(), String> {
        if !uuid(id) {
            return Err(ERROR.into());
        }
        let mut url = self.endpoint.clone();
        url.path_segments_mut().map_err(|_| ERROR)?.push(id);
        let response = self.send(Method::DELETE, url, token, None).await?;
        if response.status() != StatusCode::NO_CONTENT {
            return Err(ERROR.into());
        }
        Ok(())
    }
}

async fn json<T: DeserializeOwned>(mut response: Response) -> Result<T, String> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BODY as u64)
    {
        return Err(ERROR.into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ERROR)? {
        if chunk.len() > MAX_BODY.saturating_sub(body.len()) {
            return Err(ERROR.into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| ERROR.into())
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

/// Persist a random installation identifier, without using a hostname or hardware identifier.
pub fn device_id(directory: &Path) -> Result<String, String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory).map_err(|_| ERROR)?;
    let metadata = fs::symlink_metadata(directory).map_err(|_| ERROR)?;
    if !metadata.is_dir() || reparse_point(&metadata) {
        return Err(ERROR.into());
    }
    let path = directory.join(DEVICE_FILE);
    if path.try_exists().map_err(|_| ERROR)? {
        return read_device_id(&path);
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| ERROR)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let id = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|_| ERROR)?;
    std::io::Write::write_all(&mut file, id.as_bytes()).map_err(|_| ERROR)?;
    file.as_file().sync_all().map_err(|_| ERROR)?;
    match file.persist_noclobber(&path) {
        Ok(_) => Ok(id),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_device_id(&path)
        }
        Err(_) => Err(ERROR.into()),
    }
}

fn read_device_id(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ERROR)?;
    if !metadata.is_file() || reparse_point(&metadata) || metadata.len() != 36 {
        return Err(ERROR.into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let mut id = String::new();
    let file = options.open(path).map_err(|_| ERROR)?;
    let after = file.metadata().map_err(|_| ERROR)?;
    if !after.is_file() || reparse_point(&after) || after.len() != 36 {
        return Err(ERROR.into());
    }
    file.take(37).read_to_string(&mut id).map_err(|_| ERROR)?;
    if !uuid(&id) {
        return Err(ERROR.into());
    }
    Ok(id)
}

fn reparse_point(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x0000_0400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const DEVICE: &str = "44aee490-a584-437b-953c-c739295c1857";

    async fn response(
        status: &str,
        body: String,
        extra: &str,
    ) -> (Directory, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Url::parse(&format!(
            "http://{}/api/servers",
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
                let mut buffer = [0; 4096];
                let count = stream.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                let text = String::from_utf8_lossy(&bytes);
                if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                    let size = headers
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|value| value.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if body.len() >= size {
                        break;
                    }
                }
            }
            // Oversized-response tests intentionally close the connection before consuming it.
            let _ = stream.write_all(wire.as_bytes()).await;
            String::from_utf8(bytes).unwrap()
        });
        let directory = Directory {
            endpoint,
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
        };
        (directory, task)
    }

    fn entry() -> serde_json::Value {
        serde_json::json!({"id": DEVICE, "url": "https://server.example.com", "kind": "selfhosted", "deviceId": null})
    }

    #[tokio::test]
    async fn directory_requests_keep_bearer_native_and_send_the_exact_bookmark_contract() {
        let (directory, wire) = response(
            "200 OK",
            serde_json::json!({"servers": [entry()]}).to_string(),
            "",
        )
        .await;
        assert_eq!(
            directory
                .list("private-fixture-token", DEVICE)
                .await
                .unwrap()
                .len(),
            1
        );
        let request = wire.await.unwrap();
        assert!(request.starts_with(&format!("GET /api/servers?deviceId={DEVICE} HTTP/1.1\r\n")));
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer private-fixture-token\r\n"));
        assert!(!serde_json::to_string(&entry())
            .unwrap()
            .contains("private-fixture-token"));

        let (directory, wire) = response(
            "200 OK",
            serde_json::json!({"server": entry()}).to_string(),
            "",
        )
        .await;
        directory
            .add(
                "private-fixture-token",
                &Url::parse("https://server.example.com").unwrap(),
                Kind::Selfhosted,
                DEVICE,
            )
            .await
            .unwrap();
        let request = wire.await.unwrap();
        let body: serde_json::Value =
            serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"url": "https://server.example.com", "kind": "selfhosted"})
        );

        let local = serde_json::json!({"id": DEVICE, "url": "http://127.0.0.1:45173", "kind": "local", "deviceId": DEVICE});
        let (directory, wire) = response(
            "200 OK",
            serde_json::json!({"server": local}).to_string(),
            "",
        )
        .await;
        directory
            .add(
                "private-fixture-token",
                &Url::parse("http://127.0.0.1:45173").unwrap(),
                Kind::Local,
                DEVICE,
            )
            .await
            .unwrap();
        let request = wire.await.unwrap();
        let body: serde_json::Value =
            serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"url": "http://127.0.0.1:45173", "kind": "local", "deviceId": DEVICE})
        );

        let (directory, wire) = response("204 No Content", String::new(), "").await;
        directory
            .remove("private-fixture-token", DEVICE)
            .await
            .unwrap();
        assert!(wire
            .await
            .unwrap()
            .starts_with(&format!("DELETE /api/servers/{DEVICE} HTTP/1.1\r\n")));
    }

    #[tokio::test]
    async fn directory_rejects_redirects_auth_errors_foreign_devices_and_unbounded_bodies() {
        for (status, body, extra) in [
            ("302 Found", "{}".into(), "Location: https://untrusted.example.com/\r\n"),
            ("401 Unauthorized", "{}".into(), ""),
            ("403 Forbidden", "{}".into(), ""),
            ("500 Internal Server Error", "{}".into(), ""),
            ("200 OK", serde_json::json!({"servers": [{"id":DEVICE, "url":"http://127.0.0.1:45173", "kind":"local", "deviceId":"other-device"}]}).to_string(), ""),
            ("200 OK", " ".repeat(MAX_BODY + 1), ""),
        ] {
            let (directory, wire) = response(status, body, extra).await;
            assert!(directory.list("private-fixture-token", DEVICE).await.is_err());
            wire.await.unwrap();
        }
        let (directory, wire) = response(
            "200 OK",
            serde_json::json!({"server":entry()}).to_string(),
            "",
        )
        .await;
        assert!(directory
            .add(
                "private-fixture-token",
                &Url::parse("https://different.example.com").unwrap(),
                Kind::Selfhosted,
                DEVICE
            )
            .await
            .is_err());
        wire.await.unwrap();
        assert!(directory
            .remove("private-fixture-token", "../other")
            .await
            .is_err());
    }

    #[test]
    fn local_bookmarks_are_scoped_to_this_device_and_canonical_loopback() {
        let mut server = Server {
            id: DEVICE.into(),
            url: "http://127.0.0.1:45173".into(),
            kind: Kind::Local,
            device_id: Some(DEVICE.into()),
        };
        server.validate(DEVICE).unwrap();
        for url in [
            "https://example.com",
            "http://127.0.0.1:45173/path",
            "http://localhost:45173",
            "http://127.0.0.1:80",
        ] {
            server.url = url.into();
            assert!(server.validate(DEVICE).is_err());
        }
        server.url = "http://127.0.0.1:45173".into();
        assert!(server.validate("another-device").is_err());
        server.kind = Kind::Selfhosted;
        assert!(server.validate(DEVICE).is_err());
        server.device_id = None;
        server.validate(DEVICE).unwrap();
        server.id = "../other".into();
        assert!(server.validate(DEVICE).is_err());
    }

    #[test]
    fn installation_identifier_is_stable_random_and_private() {
        let root = tempfile::tempdir().unwrap();
        let first = device_id(root.path()).unwrap();
        assert!(uuid(&first));
        assert_eq!(first, device_id(root.path()).unwrap());
        assert_eq!(&first[14..15], "4");
        let other = tempfile::tempdir().unwrap();
        assert_ne!(first, device_id(other.path()).unwrap());
        fs::write(root.path().join(DEVICE_FILE), "invalid").unwrap();
        assert!(device_id(root.path()).is_err());
    }
}
