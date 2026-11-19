// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

//! Outbound paired-device transport for an explicitly enabled app-managed local installation.
//! The API selects the same device id for an operation and retains all owner/app approval policy.
use crate::host_runner::{HostRunner, HostTransport};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{collections::HashMap, time::Duration};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
};

pub struct HostDevice {
    stop: watch::Sender<bool>,
}
impl Drop for HostDevice {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

pub async fn pair(
    origin: url::Url,
    cookies: &str,
    runner: HostRunner,
) -> Result<HostDevice, String> {
    // Never send a native session to an arbitrary URL. This transport serves managed loopback
    // installations only; remote installations require their pinned native transport.
    if cookies.is_empty()
        || origin.scheme() != "http"
        || !matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    {
        return Err("Local device pairing requires an app-managed local installation.".into());
    }
    let consent_generation = runner.device_generation();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "Local device pairing failed.")?;
    let mut response = client.post(origin.join("/api/devices/pair").map_err(|_| "Local device pairing failed.")?)
        .header(reqwest::header::COOKIE, cookies).json(&json!({"name":"Ork desktop","platform":if cfg!(windows) {"win32"} else if cfg!(target_os="macos") {"darwin"} else {"linux"}}))
        .send().await.map_err(|_| "Local device pairing failed.")?;
    if response.status() != 201 {
        return Err("Local device pairing was refused. Sign in again and retry.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local device pairing failed.")?
    {
        if chunk.len() > 4096usize.saturating_sub(bytes.len()) {
            return Err("Local device pairing failed.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let paired: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Local device pairing failed.")?;
    let token = paired["token"]
        .as_str()
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("Local device pairing failed.")?
        .to_owned();
    let mut socket_url = origin
        .join("/api/devices/connect")
        .map_err(|_| "Local device pairing failed.")?;
    socket_url
        .set_scheme("ws")
        .map_err(|_| "Local device pairing failed.")?;
    let (stop, mut stopped) = watch::channel(false);
    tokio::spawn(async move {
        loop {
            if *stopped.borrow() {
                break;
            }
            let mut request = match socket_url.as_str().into_client_request() {
                Ok(v) => v,
                Err(_) => break,
            };
            let Ok(authorization) = format!("Bearer {token}").parse() else {
                break;
            };
            request.headers_mut().insert("authorization", authorization);
            let connection = tokio::select! {
                _ = stopped.changed() => break,
                connection = tokio::time::timeout(Duration::from_secs(10), connect_async_with_config(request, Some(WebSocketConfig::default().max_message_size(Some(12 * 1024 * 1024 + 4096)).max_frame_size(Some(12 * 1024 * 1024 + 4096))), false)) => connection,
            };
            let mut revoked = false;
            if let Ok(Ok((socket, _))) = connection {
                let (mut writer, mut reader) = socket.split();
                let (outgoing, mut frames) = mpsc::channel::<Value>(32);
                let mut calls: HashMap<String, watch::Sender<bool>> = HashMap::new();
                loop {
                    // Finished requests release their cancellation receiver.
                    calls.retain(|_, cancel| cancel.receiver_count() > 0);
                    tokio::select! {
                        _ = stopped.changed() => break,
                        Some(frame) = frames.recv() => {
                            tokio::select! {
                                _ = stopped.changed() => break,
                                sent = tokio::time::timeout(Duration::from_secs(5), writer.send(Message::Text(frame.to_string().into()))) => {
                                    if !matches!(sent, Ok(Ok(()))) { break; }
                                }
                            }
                        },
                        message = reader.next() => {
                            let Some(Ok(message)) = message else { break; };
                            match message {
                                Message::Ping(bytes) => {
                                    tokio::select! {
                                        _ = stopped.changed() => break,
                                        sent = tokio::time::timeout(Duration::from_secs(5), writer.send(Message::Pong(bytes))) => {
                                            if !matches!(sent, Ok(Ok(()))) { break; }
                                        }
                                    }
                                },
                                Message::Close(_) => break,
                                Message::Text(text) if text.len() <= 12 * 1024 * 1024 + 4096 => {
                                    let Ok(message) = serde_json::from_str::<Value>(&text) else { break; };
                                    if message["type"] == "revoked" { revoked = true; break; }
                                    let Some(id) = message["id"].as_str().filter(|v| !v.is_empty() && v.len() <= 64).map(str::to_owned) else { break; };
                                    if message["type"] == "cancel" { if let Some(cancel) = calls.remove(&id) { cancel.send_replace(true); } continue; }
                                    if message["type"] != "request" || calls.contains_key(&id) || calls.len() >= 20 { break; }
                                    let (cancel, cancelled) = watch::channel(false);
                                    calls.insert(id.clone(), cancel);
                                    let runner = runner.clone();
                                    let outgoing = outgoing.clone();
                                    let input = message["request"].clone();
                                    let epoch = runner.epoch();
                                    tokio::spawn(async move {
                                        let (sender, mut receiver) = mpsc::channel(8);
                                        let forward = async {
                                            while let Some(frame) = receiver.recv().await {
                                                if outgoing.send(json!({"type":"frame","id":id,"frame":frame})).await.is_err() { break; }
                                            }
                                        };
                                        let execute = async {
                                            if let Err(error) = runner.run(input, sender.clone(), cancelled, epoch, HostTransport::PairedDevice).await { let _ = sender.send(json!({"error":error})).await; }
                                            drop(sender);
                                        };
                                        tokio::join!(execute, forward);
                                    });
                                },
                                Message::Pong(_) => {},
                                _ => break,
                            }
                        },
                    }
                }
                for (_, cancel) in calls {
                    cancel.send_replace(true);
                }
            } else if let Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response))) =
                connection
            {
                if response.status() == 401 {
                    revoked = true;
                }
            }
            if revoked {
                runner.revoke_device_session(consent_generation);
                break;
            }
            tokio::select! { _ = stopped.changed() => break, _ = tokio::time::sleep(Duration::from_secs(2)) => {} }
        }
        // The paired credential is never persisted and cannot survive the native consent session.
        let _ = client
            .delete(origin.join("/api/devices/self").unwrap())
            .bearer_auth(token)
            .send()
            .await;
    });
    Ok(HostDevice { stop })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn refuses_nonlocal_pairing_before_exposing_a_session() {
        let root = tempfile::tempdir().unwrap();
        let runner = HostRunner::new(root.path().to_owned());
        for origin in [
            "https://example.com",
            "http://example.com",
            "http://127.0.0.1.example.com",
        ] {
            assert!(pair(
                url::Url::parse(origin).unwrap(),
                "private-session",
                runner.clone()
            )
            .await
            .is_err());
        }
    }

    #[tokio::test]
    async fn paired_transport_dispatches_existing_frames_and_revokes_on_consent_end() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin =
            url::Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let (done, completed) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut pairing, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 8192];
            let length = pairing.read(&mut bytes).await.unwrap();
            let headers = String::from_utf8_lossy(&bytes[..length]);
            assert!(headers.starts_with("POST /api/devices/pair"));
            assert!(headers
                .to_lowercase()
                .contains("cookie: session=fixture-session"));
            let body = json!({"deviceId":"fixture-device","userId":"fixture-owner","token":"a".repeat(64)}).to_string();
            pairing.write_all(format!("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            drop(pairing);
            let (connection, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                connection,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    assert_eq!(request.uri().path(), "/api/devices/connect");
                    assert_eq!(
                        request.headers()["authorization"],
                        format!("Bearer {}", "a".repeat(64))
                    );
                    Ok(response)
                },
            )
            .await
            .unwrap();
            socket.send(Message::Text(json!({"type":"request","id":"capability","request":{"method":"capabilities","botId":"fixture-bot"}}).to_string().into())).await.unwrap();
            let message = socket.next().await.unwrap().unwrap().into_text().unwrap();
            let frame: Value = serde_json::from_str(&message).unwrap();
            assert_eq!(frame["id"], "capability");
            assert_eq!(
                frame["frame"]["value"],
                json!({"screen":false,"control":false})
            );
            let _ = done.send(());
            // Consent end retires the socket and revokes the paired token on the server.
            let (mut revoke, _) = listener.accept().await.unwrap();
            let length = revoke.read(&mut bytes).await.unwrap();
            assert!(
                String::from_utf8_lossy(&bytes[..length]).starts_with("DELETE /api/devices/self")
            );
            revoke
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let runner = HostRunner::new(root.path().to_owned());
        runner.set_enabled(true);
        let device = pair(origin, "session=fixture-session", runner)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), completed)
            .await
            .unwrap()
            .unwrap();
        drop(device);
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }
}
