// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{
    future::Future,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use reqwest::{Client, Response};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use url::Url;

use crate::{
    browser_auth::{BrowserAuth, OAuthCallback},
    credentials::Store,
};

/// The seed is cosmetic and carries no authority or token material.
fn valid_personal_ork(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
            }
        })
        && bytes[14] == b'4'
        && b"89ab".contains(&bytes[19])
}

const ERROR: &str = "Could not verify Accounts sign-in.";
const MAX_BODY: usize = 1024 * 1024;
const SCOPES: &str = "openid email profile offline_access";

#[derive(Clone, Debug)]
struct Config {
    issuer: String,
    client_id: String,
}

impl Config {
    fn new(issuer: Option<&str>, client_id: Option<&str>) -> Result<Self, String> {
        let issuer = issuer
            .filter(|value| !value.is_empty())
            .ok_or("Set ORK_ACCOUNTS_ISSUER before building the desktop app.")?;
        let client_id = client_id
            .filter(|value| !value.is_empty())
            .ok_or("Set ORK_ACCOUNTS_DESKTOP_CLIENT_ID before building the desktop app.")?;
        let url = secure_url(issuer)?;
        if url.query().is_some()
            || url.fragment().is_some()
            || client_id.trim() != client_id
            || client_id.chars().any(char::is_control)
        {
            return Err("Invalid Accounts build configuration.".into());
        }
        Ok(Self {
            issuer: issuer.into(),
            client_id: client_id.into(),
        })
    }

    fn build() -> Result<Self, String> {
        Self::new(
            option_env!("ORK_ACCOUNTS_ISSUER"),
            option_env!("ORK_ACCOUNTS_DESKTOP_CLIENT_ID"),
        )
    }

    fn key(&self, origin: &Url) -> String {
        let scope = serde_json::to_vec(&(
            "accounts.v1",
            &self.issuer,
            &self.client_id,
            origin.origin().ascii_serialization(),
        ))
        .expect("fixed credential scope");
        URL_SAFE_NO_PAD.encode(Sha256::digest(scope))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{CredentialStore, STORAGE_ERROR};
    use jsonwebtoken::{encode, EncodingKey, Header};
    use rsa::{pkcs1::EncodeRsaPrivateKey, traits::PublicKeyParts, RsaPrivateKey};
    use serde_json::json;
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex as StdMutex, OnceLock},
    };

    fn config() -> Config {
        Config::new(Some("https://identity.example.com"), Some("public-client")).unwrap()
    }
    fn discovery() -> Discovery {
        serde_json::from_value(json!({"issuer":"https://identity.example.com", "authorization_endpoint":"https://identity.example.com/authorize", "token_endpoint":"https://identity.example.com/token", "userinfo_endpoint":"https://identity.example.com/userinfo", "jwks_uri":"https://identity.example.com/jwks", "revocation_endpoint":null, "code_challenge_methods_supported":["S256"], "id_token_signing_alg_values_supported":["RS256"], "token_endpoint_auth_methods_supported":["none"], "response_types_supported":["code"], "authorization_response_iss_parameter_supported":true})).unwrap()
    }
    fn credential() -> Credential {
        Credential {
            account: Account {
                issuer: config().issuer,
                subject: "subject-a".into(),
                userinfo: json!({"sub":"subject-a"}),
                expires_at: now() - 1,
            },
            access_token: "old-access".into(),
            refresh_token: Some("old-refresh".into()),
            nonce: "nonce-a".into(),
        }
    }

    #[test]
    fn welcome_ork_is_only_a_bounded_cosmetic_uuid() {
        assert!(valid_personal_ork("64cf5621-3144-4810-97f5-148acdc29c35"));
        for invalid in [
            "",
            "<svg>",
            "../../account",
            "64cf5621-3144-1810-97f5-148acdc29c35",
            "64CF5621-3144-4810-97F5-148ACDC29C35",
        ] {
            assert!(!valid_personal_ork(invalid));
        }
    }

    #[test]
    fn welcome_ork_does_not_change_pkce_state_or_nonce() {
        let seed = "64cf5621-3144-4810-97f5-148acdc29c35";
        let proof = Proof::new().unwrap();
        let authorize = |hint| {
            Url::parse(
                &proof
                    .authorize(
                        &config(),
                        &discovery(),
                        "http://127.0.0.1:43210/callback",
                        hint,
                    )
                    .unwrap(),
            )
            .unwrap()
        };
        let plain = authorize(None);
        let with_avatar = authorize(Some(seed));
        let values = |url: &Url, key: &str| {
            url.query_pairs()
                .filter(|(name, _)| name == key)
                .map(|(_, value)| value.into_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(values(&with_avatar, "ork_avatar"), vec![seed]);
        for key in [
            "state",
            "nonce",
            "code_challenge",
            "redirect_uri",
            "client_id",
            "scope",
        ] {
            assert_eq!(values(&plain, key), values(&with_avatar, key));
        }
        assert!(proof
            .authorize(
                &config(),
                &discovery(),
                "http://127.0.0.1:43210/callback",
                Some("../invalid")
            )
            .is_err());
    }

    #[test]
    fn configuration_discovery_and_storage_scopes_are_strict() {
        assert!(Config::new(None, Some("client"))
            .unwrap_err()
            .contains("ORK_ACCOUNTS_ISSUER"));
        assert!(Config::new(Some("https://identity.example.com"), None)
            .unwrap_err()
            .contains("ORK_ACCOUNTS_DESKTOP_CLIENT_ID"));
        for issuer in [
            "http://identity.example.com",
            "https://user@identity.example.com",
            "https://identity.example.com?other=1",
            "https://identity.example.com/#other",
        ] {
            assert!(Config::new(Some(issuer), Some("client")).is_err());
        }
        discovery().validate(&config()).unwrap();
        let mut invalid = discovery();
        invalid.issuer.push('/');
        assert!(invalid.validate(&config()).is_err());
        invalid = discovery();
        invalid.code_challenge_methods_supported = vec!["plain".into()];
        assert!(invalid.validate(&config()).is_err());
        invalid = discovery();
        invalid.token_endpoint_auth_methods_supported = vec!["client_secret_basic".into()];
        assert!(invalid.validate(&config()).is_err());
        invalid = discovery();
        invalid.jwks_uri = "http://identity.example.com/jwks".into();
        assert!(invalid.validate(&config()).is_err());
        let origin = Url::parse("https://server.example.com").unwrap();
        let mut other = config();
        other.client_id = "different".into();
        assert_ne!(config().key(&origin), other.key(&origin));
        assert_ne!(
            config().key(&origin),
            config().key(&Url::parse("https://other.example.com").unwrap())
        );
        assert_ne!(
            config().key(&origin),
            crate::credentials::key(&origin, Some("public-client"))
        );
    }

    #[test]
    fn pkce_matches_rfc7636_and_callback_binds_state_and_issuer() {
        let mut proof = Proof::new().unwrap();
        assert_eq!(proof.verifier.len(), 43);
        assert_ne!(proof.state, proof.nonce);
        proof.verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into();
        assert_eq!(
            proof.challenge(),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let url = Url::parse(
            &proof
                .authorize(
                    &config(),
                    &discovery(),
                    "http://127.0.0.1:43210/callback",
                    None,
                )
                .unwrap(),
        )
        .unwrap();
        let values: HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(values["scope"], SCOPES);
        assert_eq!(values["prompt"], "consent");
        assert_eq!(
            url.query_pairs()
                .filter(|(name, _)| name == "prompt")
                .count(),
            1
        );
        assert_eq!(values["code_challenge_method"], "S256");
        assert_eq!(values["code_challenge"], proof.challenge());
        assert!(!values.contains_key("client_secret"));
        for redirect in [
            "http://localhost:43210/callback",
            "http://[::1]:43210/callback",
            "http://127.0.0.1:43210/other",
            "https://127.0.0.1:43210/callback",
            "http://127.0.0.1:43210/callback?other=1",
        ] {
            assert!(proof
                .authorize(&config(), &discovery(), redirect, None)
                .is_err());
        }
        let mut callback = OAuthCallback {
            code: "test-code".into(),
            state: proof.state.clone(),
            iss: Some(config().issuer),
        };
        proof.callback(&config(), &discovery(), &callback).unwrap();
        callback.iss = Some("https://other.example.com".into());
        assert!(proof.callback(&config(), &discovery(), &callback).is_err());
        callback.iss = None;
        assert!(proof.callback(&config(), &discovery(), &callback).is_err());
        callback.iss = Some(config().issuer);
        callback.state = "wrong".into();
        assert!(proof.callback(&config(), &discovery(), &callback).is_err());
    }

    fn signing() -> &'static (EncodingKey, JwkSet) {
        static KEYS: OnceLock<(EncodingKey, JwkSet)> = OnceLock::new();
        KEYS.get_or_init(|| {
            // Ephemeral test-only keys never leave this process.
            let private = RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 2048).unwrap();
            let public = private.to_public_key();
            let der = private.to_pkcs1_der().unwrap();
            let jwks = serde_json::from_value(json!({"keys":[{"kty":"RSA", "kid":"test-key", "alg":"RS256", "use":"sig", "n":URL_SAFE_NO_PAD.encode(public.n().to_bytes_be()), "e":URL_SAFE_NO_PAD.encode(public.e().to_bytes_be())}]})).unwrap();
            (EncodingKey::from_rsa_der(der.as_bytes()), jwks)
        })
    }

    fn signed(claims: &serde_json::Value) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("test-key".into());
        encode(&header, claims, &signing().0).unwrap()
    }

    #[test]
    fn id_tokens_require_signature_nonce_issuer_audience_expiry_and_subject_continuity() {
        let claims = json!({"iss":config().issuer,"aud":config().client_id,"sub":"subject-a","iat":now(),"exp":now()+300,"nonce":"nonce-a"});
        let token = signed(&claims);
        let mut hashed = claims.clone();
        hashed["at_hash"] = json!(URL_SAFE_NO_PAD.encode(&Sha256::digest(b"access-a")[..16]));
        let verified = verify_id_token(
            &signed(&hashed),
            &signing().1,
            &config(),
            Some(("nonce-a", true)),
            None,
        )
        .unwrap();
        verify_access_hash(&verified, "access-a").unwrap();
        assert!(verify_access_hash(&verified, "access-b").is_err());
        let verified_refresh = verify_id_token(
            &signed(&claims),
            &signing().1,
            &config(),
            Some(("nonce-a", false)),
            Some("subject-a"),
        )
        .unwrap();
        assert_eq!(verified_refresh.sub, "subject-a");
        assert!(verify_id_token(
            &signed(&claims),
            &signing().1,
            &config(),
            Some(("different", false)),
            Some("subject-a")
        )
        .is_err());
        let mut invalid_keys = serde_json::to_value(&signing().1).unwrap();
        for (field, value) in [
            ("use", json!("enc")),
            ("key_ops", json!(["sign"])),
            ("alg", json!("RS512")),
            ("n", json!(URL_SAFE_NO_PAD.encode([255u8; 128]))),
        ] {
            let mut keys = invalid_keys.clone();
            keys["keys"][0][field] = value;
            assert!(verify_id_token(
                &token,
                &serde_json::from_value(keys).unwrap(),
                &config(),
                None,
                None
            )
            .is_err());
        }
        let duplicate = invalid_keys["keys"][0].clone();
        invalid_keys["keys"].as_array_mut().unwrap().push(duplicate);
        assert!(verify_id_token(
            &token,
            &serde_json::from_value(invalid_keys).unwrap(),
            &config(),
            None,
            None
        )
        .is_err());
        assert_eq!(
            verify_id_token(
                &token,
                &signing().1,
                &config(),
                Some(("nonce-a", true)),
                None
            )
            .unwrap()
            .sub,
            "subject-a"
        );
        assert!(
            verify_id_token(&token, &signing().1, &config(), Some(("wrong", true)), None).is_err()
        );
        assert!(verify_id_token(&token, &signing().1, &config(), None, Some("subject-b")).is_err());
        for (field, value) in [
            ("iss", json!("https://other.example.com")),
            ("aud", json!("other-client")),
            ("sub", json!("")),
            ("exp", json!(now() - 100)),
            ("iat", json!(now() + 100)),
            ("azp", json!("other-client")),
        ] {
            let mut invalid = claims.clone();
            invalid[field] = value;
            assert!(
                verify_id_token(
                    &signed(&invalid),
                    &signing().1,
                    &config(),
                    Some(("nonce-a", true)),
                    None
                )
                .is_err(),
                "accepted {field}"
            );
        }
        let mut multiple = claims.clone();
        multiple["aud"] = json!([config().client_id, "other-client"]);
        assert!(verify_id_token(&signed(&multiple), &signing().1, &config(), None, None).is_err());
        multiple["azp"] = json!(config().client_id);
        assert!(verify_id_token(&signed(&multiple), &signing().1, &config(), None, None).is_ok());
        let mut broken = token.into_bytes();
        let last = broken.len() - 4;
        broken[last] = if broken[last] == b'A' { b'B' } else { b'A' };
        assert!(verify_id_token(
            std::str::from_utf8(&broken).unwrap(),
            &signing().1,
            &config(),
            None,
            None
        )
        .is_err());
    }

    #[derive(Default)]
    struct MemoryStore(StdMutex<HashMap<String, String>>);
    impl CredentialStore for MemoryStore {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    struct Fixture {
        accounts: Arc<Accounts>,
        store: Arc<MemoryStore>,
        origin: Url,
        requests: Arc<StdMutex<Vec<(String, String, String)>>>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Fixture {
        async fn new(failure: bool) -> Self {
            use http_body_util::{BodyExt, Full};
            use hyper::{body::Bytes, service::service_fn};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(StdMutex::new(Vec::new()));
            let saved = requests.clone();
            let task = tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let requests = saved.clone();
                    tokio::spawn(async move {
                        let service = service_fn(
                            move |request: hyper::Request<hyper::body::Incoming>| {
                                let requests = requests.clone();
                                async move {
                                    let path = request.uri().path().to_owned();
                                    let auth = request
                                        .headers()
                                        .get("authorization")
                                        .and_then(|value| value.to_str().ok())
                                        .unwrap_or("")
                                        .to_owned();
                                    let body =
                                        request.into_body().collect().await.unwrap().to_bytes();
                                    requests.lock().unwrap().push((
                                        path.clone(),
                                        String::from_utf8(body.to_vec()).unwrap(),
                                        auth,
                                    ));
                                    let value = match path.as_str() { "/token" if failure => "invalid json".into(), "/token" => json!({"access_token":"new-access", "refresh_token":"rotated-refresh", "token_type":"Bearer", "expires_in":300}).to_string(), "/userinfo" => json!({"sub":"subject-a","name":"Test"}).to_string(), _ => "{}".into() };
                                    Ok::<_, std::convert::Infallible>(hyper::Response::new(
                                        Full::new(Bytes::from(value)),
                                    ))
                                }
                            },
                        );
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                            .await;
                    });
                }
            });
            let store = Arc::new(MemoryStore::default());
            let mut discovery = discovery();
            discovery.token_endpoint = format!("{base}/token");
            discovery.userinfo_endpoint = format!("{base}/userinfo");
            discovery.revocation_endpoint = Some(format!("{base}/revoke"));
            let accounts = Arc::new(Accounts {
                store: Store(store.clone()),
                revocations: crate::revocations::Revocations::new(Store(store.clone())),
                discovery: Mutex::new(Some((Instant::now(), discovery))),
                ..Default::default()
            });
            let origin = Url::parse("https://server.example.com").unwrap();
            accounts
                .save(&config().key(&origin), &credential())
                .await
                .unwrap();
            Self {
                accounts,
                store,
                origin,
                requests,
                task,
            }
        }
    }

    #[tokio::test]
    async fn refresh_rotation_is_serialized_persisted_and_never_exposed_in_metadata() {
        let fixture = Fixture::new(false).await;
        let configuration = config();
        let (first, second) = tokio::join!(
            fixture
                .accounts
                .session_config(&fixture.origin, &configuration),
            fixture
                .accounts
                .session_config(&fixture.origin, &configuration)
        );
        for account in [first.unwrap().unwrap(), second.unwrap().unwrap()] {
            let metadata = serde_json::to_string(&account).unwrap();
            assert!(!metadata.contains("access") && !metadata.contains("refresh"));
        }
        {
            let requests = fixture.requests.lock().unwrap();
            assert_eq!(
                requests
                    .iter()
                    .filter(|(path, _, _)| path == "/token")
                    .count(),
                1
            );
            assert!(
                requests[0].1.contains("grant_type=refresh_token")
                    && requests[0].1.contains("refresh_token=old-refresh")
                    && !requests[0].1.contains("secret")
            );
            assert_eq!(requests[1].2, "Bearer new-access");
        }
        let saved = fixture
            .store
            .get(&config().key(&fixture.origin))
            .unwrap()
            .unwrap();
        assert!(saved.contains("rotated-refresh") && !saved.contains("old-refresh"));
        fixture
            .accounts
            .logout_config(std::slice::from_ref(&fixture.origin), &config())
            .await
            .unwrap();
        assert!(fixture
            .store
            .get(&config().key(&fixture.origin))
            .unwrap()
            .is_none());
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if fixture
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(path, body, _)| path == "/revoke" && body.contains("rotated-refresh"))
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn ambiguous_refresh_and_absent_refresh_require_browser_sign_in_without_replay() {
        let fixture = Fixture::new(true).await;
        assert!(fixture
            .accounts
            .session_config(&fixture.origin, &config())
            .await
            .is_err());
        assert!(fixture
            .accounts
            .session_config(&fixture.origin, &config())
            .await
            .unwrap()
            .is_none());
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
        let mut saved = credential();
        saved.refresh_token = None;
        fixture
            .accounts
            .save(&config().key(&fixture.origin), &saved)
            .await
            .unwrap();
        assert!(fixture
            .accounts
            .session_config(&fixture.origin, &config())
            .await
            .unwrap()
            .is_none());
        assert!(fixture
            .store
            .get(&config().key(&fixture.origin))
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn credentials_fail_closed_when_storage_is_unavailable() {
        struct Unavailable;
        impl CredentialStore for Unavailable {
            fn get(&self, _: &str) -> Result<Option<String>, String> {
                Err(STORAGE_ERROR.into())
            }
            fn set(&self, _: &str, _: &str) -> Result<(), String> {
                Err(STORAGE_ERROR.into())
            }
            fn delete(&self, _: &str) -> Result<(), String> {
                Err(STORAGE_ERROR.into())
            }
        }
        let accounts = Accounts {
            store: Store(Arc::new(Unavailable)),
            ..Default::default()
        };
        let origin = Url::parse("https://server.example.com").unwrap();
        assert_eq!(
            accounts.save("key", &credential()).await.unwrap_err(),
            STORAGE_ERROR
        );
        assert!(accounts.session_config(&origin, &config()).await.is_err());
        assert_eq!(
            accounts
                .logout_config(std::slice::from_ref(&origin), &config())
                .await
                .unwrap_err(),
            STORAGE_ERROR
        );
    }

    #[tokio::test]
    async fn logout_cancels_network_work_before_waiting_for_its_operation_lock() {
        let fixture = Fixture::new(false).await;
        let accounts = fixture.accounts.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let network = tokio::spawn(async move {
            let _operation = accounts.operation.lock().await;
            let generation = accounts.generation.load(Ordering::SeqCst);
            accounts
                .network(generation, async {
                    started.send(()).unwrap();
                    std::future::pending::<Result<(), String>>().await
                })
                .await
        });
        ready.await.unwrap();
        tokio::time::timeout(
            Duration::from_secs(2),
            fixture
                .accounts
                .logout_config(std::slice::from_ref(&fixture.origin), &config()),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(network.await.unwrap().is_err());
        assert!(fixture
            .store
            .get(&config().key(&fixture.origin))
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn unreadable_credentials_are_still_deleted_and_cannot_restore_after_restart() {
        struct Unreadable(Arc<MemoryStore>);
        impl CredentialStore for Unreadable {
            fn get(&self, _: &str) -> Result<Option<String>, String> {
                Err(STORAGE_ERROR.into())
            }
            fn set(&self, key: &str, value: &str) -> Result<(), String> {
                self.0.set(key, value)
            }
            fn delete(&self, key: &str) -> Result<(), String> {
                self.0.delete(key)
            }
        }
        let store = Arc::new(MemoryStore::default());
        let origin = Url::parse("https://server.example.test").unwrap();
        store
            .set(
                &config().key(&origin),
                &serde_json::to_string(&credential()).unwrap(),
            )
            .unwrap();
        let accounts = Accounts::new(Store(Arc::new(Unreadable(store.clone()))));
        accounts
            .logout_config(std::slice::from_ref(&origin), &config())
            .await
            .unwrap();
        assert!(store.get(&config().key(&origin)).unwrap().is_none());
    }

    #[tokio::test]
    async fn malformed_or_foreign_saved_credentials_are_forgotten_without_replaying_them() {
        for malformed in [true, false] {
            let store = Arc::new(MemoryStore::default());
            let origin = Url::parse("https://server.example.test").unwrap();
            let mut foreign = credential();
            foreign.account.issuer = "https://other.example.test".into();
            let value = if malformed {
                "invalid json".into()
            } else {
                serde_json::to_string(&foreign).unwrap()
            };
            store.set(&config().key(&origin), &value).unwrap();
            let accounts = Accounts::new(Store(store.clone()));
            accounts
                .logout_config(std::slice::from_ref(&origin), &config())
                .await
                .unwrap();
            assert!(store.get(&config().key(&origin)).unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn failed_revocation_persistence_still_retires_the_local_credential() {
        struct RefuseQueue(Arc<MemoryStore>);
        impl CredentialStore for RefuseQueue {
            fn get(&self, key: &str) -> Result<Option<String>, String> {
                self.0.get(key)
            }
            fn set(&self, key: &str, value: &str) -> Result<(), String> {
                if key == "pending-session-revocations.v1" {
                    Err(STORAGE_ERROR.into())
                } else {
                    self.0.set(key, value)
                }
            }
            fn delete(&self, key: &str) -> Result<(), String> {
                self.0.delete(key)
            }
        }
        let store = Arc::new(MemoryStore::default());
        let accounts = Accounts::new(Store(Arc::new(RefuseQueue(store.clone()))));
        let origin = Url::parse("https://server.example.test").unwrap();
        accounts
            .save(&config().key(&origin), &credential())
            .await
            .unwrap();
        assert!(accounts
            .logout_config(std::slice::from_ref(&origin), &config())
            .await
            .is_err());
        assert!(store.get(&config().key(&origin)).unwrap().is_none());
    }

    #[tokio::test]
    async fn logout_fences_inflight_persistence_and_clears_after_it_finishes() {
        let fixture = Fixture::new(false).await;
        let accounts = fixture.accounts.clone();
        let origin = fixture.origin.clone();
        let operation = fixture.accounts.operation.lock().await;
        let logout = tokio::spawn(async move {
            accounts
                .logout_config(std::slice::from_ref(&origin), &config())
                .await
        });
        tokio::task::yield_now().await;
        assert_eq!(fixture.accounts.generation.load(Ordering::SeqCst), 1);
        fixture
            .accounts
            .save(&config().key(&fixture.origin), &credential())
            .await
            .unwrap();
        drop(operation);
        logout.await.unwrap().unwrap();
        assert!(fixture
            .store
            .get(&config().key(&fixture.origin))
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn logout_clears_central_and_legacy_scopes_once_without_touching_other_servers() {
        let fixture = Fixture::new(false).await;
        let central = crate::server_directory::origin();
        let other = Url::parse("https://other.example.test").unwrap();
        fixture
            .accounts
            .save(&config().key(&central), &credential())
            .await
            .unwrap();
        fixture
            .accounts
            .save(&config().key(&other), &credential())
            .await
            .unwrap();
        fixture
            .accounts
            .logout_config(
                &[
                    central.clone(),
                    fixture.origin.clone(),
                    central.join("/app").unwrap(),
                ],
                &config(),
            )
            .await
            .unwrap();
        assert_eq!(fixture.accounts.generation.load(Ordering::SeqCst), 1);
        assert!(fixture
            .store
            .get(&config().key(&central))
            .unwrap()
            .is_none());
        assert!(fixture
            .store
            .get(&config().key(&fixture.origin))
            .unwrap()
            .is_none());
        assert!(fixture.store.get(&config().key(&other)).unwrap().is_some());
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if fixture
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(path, _, _)| path == "/revoke")
                    .count()
                    == 2
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn retired_document_during_secure_read_cannot_delete_credentials() {
        struct RetireOnRead {
            store: Arc<MemoryStore>,
            current: Arc<AtomicBool>,
            deletes: AtomicU64,
        }
        impl CredentialStore for RetireOnRead {
            fn get(&self, key: &str) -> Result<Option<String>, String> {
                let value = self.store.get(key);
                self.current.store(false, Ordering::SeqCst);
                value
            }
            fn set(&self, key: &str, value: &str) -> Result<(), String> {
                self.store.set(key, value)
            }
            fn delete(&self, key: &str) -> Result<(), String> {
                self.deletes.fetch_add(1, Ordering::SeqCst);
                self.store.delete(key)
            }
        }
        let store = Arc::new(MemoryStore::default());
        let current = Arc::new(AtomicBool::new(true));
        let guarded = Arc::new(RetireOnRead {
            store: store.clone(),
            current: current.clone(),
            deletes: AtomicU64::new(0),
        });
        let accounts = Accounts::new(Store(guarded.clone()));
        let origin = crate::server_directory::origin();
        accounts
            .save(&config().key(&origin), &credential())
            .await
            .unwrap();
        assert!(accounts
            .logout_config_current(std::slice::from_ref(&origin), &config(), || {
                current.load(Ordering::SeqCst)
            })
            .await
            .is_err());
        assert_eq!(guarded.deletes.load(Ordering::SeqCst), 0);
        assert!(store.get(&config().key(&origin)).unwrap().is_some());
    }

    #[tokio::test]
    async fn slow_revocation_does_not_delay_local_logout_or_touch_new_credentials() {
        use http_body_util::{BodyExt, Full};
        use hyper::{body::Bytes, service::service_fn};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/revoke", listener.local_addr().unwrap());
        let release = Arc::new(tokio::sync::Notify::new());
        let released = release.clone();
        let (request_tx, request_rx) = tokio::sync::oneshot::channel();
        let request_tx = Arc::new(StdMutex::new(Some(request_tx)));
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let service = service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                let release = released.clone();
                let request_tx = request_tx.clone();
                async move {
                    let body = request.into_body().collect().await.unwrap().to_bytes();
                    let first = request_tx.lock().unwrap().take();
                    if let Some(sender) = first {
                        sender.send(body).unwrap();
                        release.notified().await;
                    }
                    Ok::<_, std::convert::Infallible>(hyper::Response::new(Full::new(Bytes::from(
                        "{}",
                    ))))
                }
            });
            hyper::server::conn::http1::Builder::new()
                .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                .await
                .unwrap();
        });
        let store = Arc::new(MemoryStore::default());
        let mut metadata = discovery();
        metadata.revocation_endpoint = Some(endpoint);
        let accounts = Accounts {
            store: Store(store.clone()),
            revocations: crate::revocations::Revocations::new(Store(store.clone())),
            discovery: Mutex::new(Some((Instant::now(), metadata))),
            ..Default::default()
        };
        let origin = crate::server_directory::origin();
        accounts
            .save(&config().key(&origin), &credential())
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(2),
            accounts.logout_config(std::slice::from_ref(&origin), &config()),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(store.get(&config().key(&origin)).unwrap().is_none());
        assert!(accounts.operation.try_lock().is_ok());
        let request = tokio::time::timeout(Duration::from_secs(2), request_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(std::str::from_utf8(&request)
            .unwrap()
            .contains("token=old-refresh"));
        let mut fresh = credential();
        fresh.access_token = "fresh-access".into();
        fresh.refresh_token = Some("fresh-refresh".into());
        accounts.invalidate();
        accounts.save(&config().key(&origin), &fresh).await.unwrap();
        let generation = accounts.generation.load(Ordering::SeqCst);
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(accounts.generation.load(Ordering::SeqCst), generation);
        let saved: Credential =
            serde_json::from_str(&store.get(&config().key(&origin)).unwrap().unwrap()).unwrap();
        assert_eq!(saved.access_token, "fresh-access");
        assert_eq!(saved.refresh_token.as_deref(), Some("fresh-refresh"));
    }

    #[tokio::test]
    async fn queued_logout_never_deletes_credentials_after_a_newer_sign_in_starts() {
        let fixture = Fixture::new(false).await;
        let accounts = fixture.accounts.clone();
        let central = crate::server_directory::origin();
        let origins = vec![central.clone(), fixture.origin.clone()];
        let operation = fixture.accounts.operation.lock().await;
        let logout = tokio::spawn(async move { accounts.logout_config(&origins, &config()).await });
        tokio::task::yield_now().await;
        assert_eq!(fixture.accounts.generation.load(Ordering::SeqCst), 1);
        fixture.accounts.invalidate();
        fixture
            .accounts
            .save(&config().key(&central), &credential())
            .await
            .unwrap();
        drop(operation);
        assert!(logout.await.unwrap().is_err());
        assert!(fixture
            .store
            .get(&config().key(&central))
            .unwrap()
            .is_some());
        assert!(fixture.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_legacy_secure_delete_failure_is_reported_after_central_deletion() {
        struct FailLegacy {
            store: Arc<MemoryStore>,
            key: String,
        }
        impl CredentialStore for FailLegacy {
            fn get(&self, key: &str) -> Result<Option<String>, String> {
                self.store.get(key)
            }
            fn set(&self, key: &str, value: &str) -> Result<(), String> {
                self.store.set(key, value)
            }
            fn delete(&self, key: &str) -> Result<(), String> {
                if key == self.key {
                    Err(STORAGE_ERROR.into())
                } else {
                    self.store.delete(key)
                }
            }
        }
        let store = Arc::new(MemoryStore::default());
        let central = crate::server_directory::origin();
        let legacy = Url::parse("https://server.example.test").unwrap();
        let accounts = Accounts::new(Store(Arc::new(FailLegacy {
            store: store.clone(),
            key: config().key(&legacy),
        })));
        accounts
            .save(&config().key(&central), &credential())
            .await
            .unwrap();
        accounts
            .save(&config().key(&legacy), &credential())
            .await
            .unwrap();
        assert_eq!(
            accounts
                .logout_config(&[central.clone(), legacy.clone()], &config())
                .await
                .unwrap_err(),
            STORAGE_ERROR
        );
        assert!(store.get(&config().key(&central)).unwrap().is_none());
        assert!(store.get(&config().key(&legacy)).unwrap().is_some());
        let retained: Credential =
            serde_json::from_str(&store.get(&config().key(&legacy)).unwrap().unwrap()).unwrap();
        let mut fresh = credential();
        fresh.account.expires_at = now() + 300;
        fresh.nonce = Proof::new().unwrap().nonce;
        accounts
            .save(&config().key(&central), &fresh)
            .await
            .unwrap();
        let authorization = accounts
            .authorization_config(&central, &config())
            .await
            .unwrap();
        assert_ne!(
            authorization.profile_epoch(),
            login_profile_epoch(&retained.nonce)
        );
    }

    #[tokio::test]
    async fn central_authorization_is_separate_from_server_sessions_and_logout_fences_it() {
        let fixture = Fixture::new(false).await;
        let central = crate::server_directory::origin();
        assert!(fixture
            .accounts
            .authorization_config(&central, &config())
            .await
            .is_err());
        let mut valid = credential();
        valid.account.expires_at = now() + 300;
        fixture
            .accounts
            .save(&config().key(&central), &valid)
            .await
            .unwrap();
        let authorization = fixture
            .accounts
            .authorization_config(&central, &config())
            .await
            .unwrap();
        assert!(authorization.directory_bearer().is_err());
        let mut central_authorization = Authorization {
            account: authorization.account.clone(),
            profile_epoch: authorization.profile_epoch.clone(),
            token: "central-access".into(),
            generation: authorization.generation,
            personal: None,
        };
        central_authorization.account.issuer = crate::server_directory::origin()
            .origin()
            .ascii_serialization();
        assert_eq!(
            central_authorization.directory_bearer().unwrap(),
            "central-access"
        );
        assert!(fixture.accounts.is_current(&authorization));
        let public = serde_json::to_string(&authorization.account).unwrap();
        assert!(!public.contains("old-access") && !public.contains("old-refresh"));
        {
            fixture.accounts.signing_in.store(true, Ordering::SeqCst);
            let _pending = SignInGuard(&fixture.accounts.signing_in);
            assert!(!fixture.accounts.is_current(&authorization));
            assert!(fixture
                .accounts
                .authorization_config(&central, &config())
                .await
                .is_err());
            assert!(fixture
                .accounts
                .session_config(&central, &config())
                .await
                .is_err());
            assert!(fixture.requests.lock().unwrap().is_empty());
        }
        assert!(fixture.accounts.is_current(&authorization));
        fixture.accounts.invalidate();
        assert!(!fixture.accounts.is_current(&authorization));
        fixture
            .accounts
            .logout_config(std::slice::from_ref(&central), &config())
            .await
            .unwrap();
        assert!(fixture
            .accounts
            .authorization_config(&central, &config())
            .await
            .is_err());
        assert!(fixture
            .store
            .0
            .lock()
            .unwrap()
            .contains_key(&config().key(&fixture.origin)));
    }

    #[tokio::test]
    async fn login_profile_epoch_survives_refresh_and_restart_but_changes_on_interactive_login() {
        let fixture = Fixture::new(false).await;
        let expected = login_profile_epoch(&credential().nonce);
        let refreshed = fixture
            .accounts
            .authorization_config(&fixture.origin, &config())
            .await
            .unwrap();
        assert_eq!(refreshed.profile_epoch(), expected);
        let restarted = Accounts::new(Store(fixture.store.clone()));
        let restored = restarted
            .authorization_config(&fixture.origin, &config())
            .await
            .unwrap();
        assert_eq!(restored.profile_epoch(), expected);
        // A successful interactive exchange replaces the nonce even if old profile data remains.
        let mut next = credential();
        next.account.expires_at = now() + 300;
        next.nonce = Proof::new().unwrap().nonce;
        restarted
            .save(&config().key(&fixture.origin), &next)
            .await
            .unwrap();
        let replacement = restarted
            .authorization_config(&fixture.origin, &config())
            .await
            .unwrap();
        assert_ne!(replacement.profile_epoch(), expected);
        assert!(!serde_json::to_string(&replacement.account)
            .unwrap()
            .contains(replacement.profile_epoch()));
    }
}

fn secure_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| ERROR)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(ERROR.into());
    }
    Ok(url)
}

#[derive(Clone, Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    userinfo_endpoint: String,
    jwks_uri: String,
    revocation_endpoint: Option<String>,
    code_challenge_methods_supported: Vec<String>,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Vec<String>,
    #[serde(default)]
    response_types_supported: Vec<String>,
    id_token_signing_alg_values_supported: Vec<String>,
    #[serde(default)]
    authorization_response_iss_parameter_supported: bool,
}

impl Discovery {
    fn validate(&self, config: &Config) -> Result<(), String> {
        if self.issuer != config.issuer
            || !self
                .token_endpoint_auth_methods_supported
                .iter()
                .any(|value| value == "none")
            || !self
                .response_types_supported
                .iter()
                .any(|value| value == "code")
            || !self
                .code_challenge_methods_supported
                .iter()
                .any(|value| value == "S256")
            || !self
                .id_token_signing_alg_values_supported
                .iter()
                .any(|value| value == "RS256")
        {
            return Err(ERROR.into());
        }
        for endpoint in [
            &self.authorization_endpoint,
            &self.token_endpoint,
            &self.userinfo_endpoint,
            &self.jwks_uri,
        ]
        .into_iter()
        .chain(self.revocation_endpoint.iter())
        {
            secure_url(endpoint)?;
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    issuer: String,
    subject: String,
    userinfo: serde_json::Value,
    expires_at: u64,
}

impl Account {
    pub(crate) fn identity(&self) -> (&str, &str) {
        (&self.issuer, &self.subject)
    }
}

/// Native-only authorization. Tokens are never serialized into renderer IPC.
pub(crate) struct Authorization {
    pub account: Account,
    token: String,
    generation: u64,
    personal: Option<PersonalAuthority>,
    profile_epoch: String,
}

pub(crate) struct PersonalAuthority {
    pub selection: crate::installation_transport::Selection,
    pub device_id: String,
    pub epoch: u64,
}

impl Authorization {
    pub(crate) fn profile_epoch(&self) -> &str {
        &self.profile_epoch
    }
    pub(crate) fn directory_bearer(&self) -> Result<&str, String> {
        if self.personal.is_some()
            || self.token.is_empty()
            || self.account.issuer
                != crate::server_directory::origin()
                    .origin()
                    .ascii_serialization()
        {
            return Err("This build must use the central Accounts issuer.".into());
        }
        Ok(&self.token)
    }
    pub(crate) fn personal(&self) -> Option<&PersonalAuthority> {
        self.personal.as_ref()
    }
}

#[derive(Deserialize, Serialize)]
struct Credential {
    account: Account,
    access_token: String,
    refresh_token: Option<String>,
    nonce: String,
}

fn login_profile_epoch(nonce: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"orkbot-login-profile-v1\0");
    digest.update(nonce.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
    refresh_token: Option<String>,
    id_token: Option<String>,
}

#[derive(Clone, Deserialize)]
struct Claims {
    at_hash: Option<String>,
    sub: String,
    nonce: Option<String>,
    azp: Option<String>,
    aud: serde_json::Value,
    iat: u64,
    exp: u64,
}

struct Proof {
    verifier: String,
    state: String,
    nonce: String,
}

fn random() -> Result<String, String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not secure Accounts sign-in.")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

impl Proof {
    fn new() -> Result<Self, String> {
        Ok(Self {
            verifier: random()?,
            state: random()?,
            nonce: random()?,
        })
    }
    fn challenge(&self) -> String {
        URL_SAFE_NO_PAD.encode(Sha256::digest(self.verifier.as_bytes()))
    }
    fn authorize(
        &self,
        config: &Config,
        discovery: &Discovery,
        redirect: &str,
        welcome_ork: Option<&str>,
    ) -> Result<String, String> {
        if welcome_ork.is_some_and(|value| !valid_personal_ork(value)) {
            return Err("Invalid welcome Ork.".into());
        }
        crate::browser_auth::validate_public_redirect(&Url::parse(redirect).map_err(|_| ERROR)?)?;
        let mut url = secure_url(&discovery.authorization_endpoint)?;
        url.query_pairs_mut().extend_pairs([
            ("client_id", config.client_id.as_str()),
            ("response_type", "code"),
            ("prompt", "consent"),
            ("redirect_uri", redirect),
            ("scope", SCOPES),
            ("state", &self.state),
            ("nonce", &self.nonce),
            ("code_challenge", &self.challenge()),
            ("code_challenge_method", "S256"),
        ]);
        if let Some(seed) = welcome_ork {
            url.query_pairs_mut().append_pair("ork_avatar", seed);
        }
        Ok(url.into())
    }
    fn callback(
        &self,
        config: &Config,
        discovery: &Discovery,
        callback: &OAuthCallback,
    ) -> Result<(), String> {
        if callback.state != self.state
            || callback.code.is_empty()
            || callback
                .iss
                .as_ref()
                .is_some_and(|issuer| issuer != &config.issuer)
            || (discovery.authorization_response_iss_parameter_supported && callback.iss.is_none())
        {
            return Err(ERROR.into());
        }
        Ok(())
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

async fn json<T: DeserializeOwned>(mut response: Response) -> Result<T, String> {
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_BODY as u64)
    {
        return Err(ERROR.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ERROR)? {
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err(ERROR.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ERROR.into())
}

fn client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| ERROR.into())
}

fn verify_id_token(
    token: &str,
    keys: &JwkSet,
    config: &Config,
    nonce: Option<(&str, bool)>,
    subject: Option<&str>,
) -> Result<Claims, String> {
    let header = decode_header(token).map_err(|_| ERROR)?;
    // Pin the advertised asymmetric algorithm rather than trusting the token's alg or key URL.
    if header.alg != Algorithm::RS256
        || header
            .crit
            .as_ref()
            .is_some_and(|values| !values.is_empty())
    {
        return Err(ERROR.into());
    }
    let kid = header.kid.as_deref().ok_or(ERROR)?;
    let matches: Vec<_> = keys
        .keys
        .iter()
        .filter(|key| key.common.key_id.as_deref() == Some(kid))
        .collect();
    if matches.len() != 1 {
        return Err(ERROR.into());
    }
    let key = matches[0];
    let metadata = serde_json::to_value(key).map_err(|_| ERROR)?;
    if metadata.get("alg").is_some_and(|value| value != "RS256")
        || metadata.get("use").is_some_and(|value| value != "sig")
        || metadata.get("key_ops").is_some_and(|value| {
            !value
                .as_array()
                .is_some_and(|values| values.iter().any(|value| value == "verify"))
        })
    {
        return Err(ERROR.into());
    }
    let modulus = metadata
        .get("n")
        .and_then(|value| value.as_str())
        .ok_or(ERROR)?;
    let modulus = URL_SAFE_NO_PAD.decode(modulus).map_err(|_| ERROR)?;
    if modulus.len() < 256 || (modulus.len() == 256 && modulus[0] < 128) {
        return Err(ERROR.into());
    }
    let key = DecodingKey::from_jwk(key).map_err(|_| ERROR)?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[&config.issuer]);
    validation.set_audience(&[&config.client_id]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub", "iat"]);
    validation.validate_nbf = true;
    validation.leeway = 30;
    let claims = decode::<Claims>(token, &key, &validation)
        .map_err(|_| ERROR)?
        .claims;
    let multiple_audiences = claims.aud.as_array().is_some_and(|aud| aud.len() > 1);
    if claims.sub.is_empty()
        || claims.iat > now() + 30
        || claims.iat >= claims.exp
        || nonce.is_some_and(|(nonce, required)| match claims.nonce.as_deref() {
            Some(value) => value != nonce,
            None => required,
        })
        || subject.is_some_and(|subject| claims.sub != subject)
        || claims
            .azp
            .as_ref()
            .is_some_and(|azp| azp != &config.client_id)
        || (multiple_audiences && claims.azp.as_deref() != Some(&config.client_id))
    {
        return Err(ERROR.into());
    }
    Ok(claims)
}

fn verify_access_hash(claims: &Claims, access_token: &str) -> Result<(), String> {
    if let Some(hash) = &claims.at_hash {
        let digest = Sha256::digest(access_token.as_bytes());
        if hash != &URL_SAFE_NO_PAD.encode(&digest[..16]) {
            return Err(ERROR.into());
        }
    }
    Ok(())
}

async fn fetch_discovery(config: &Config, client: &Client) -> Result<Discovery, String> {
    let discovery: Discovery = json(
        client
            .get(format!(
                "{}/.well-known/openid-configuration",
                config.issuer.trim_end_matches('/')
            ))
            .send()
            .await
            .map_err(|_| ERROR)?,
    )
    .await?;
    discovery.validate(config)?;
    Ok(discovery)
}

/// A proxy's successful HTML login page is not an acknowledgement from the product API.
pub(crate) async fn revocation_ack(mut response: Response) -> bool {
    const LIMIT: usize = 4096;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > LIMIT as u64)
    {
        return false;
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if chunk.len() <= LIMIT.saturating_sub(bytes.len()) => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return false,
        }
    }
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .is_some_and(|value| value.get("success") == Some(&serde_json::Value::Bool(true)))
}

/// Resolve immutable queued provider metadata without ever reading a newer login.
pub(crate) async fn revoke_queued_token(
    client: &Client,
    issuer: &str,
    client_id: &str,
    token: &str,
    endpoint: Option<&str>,
) -> bool {
    let Ok(config) = Config::new(Some(issuer), Some(client_id)) else {
        return false;
    };
    let endpoint = match endpoint {
        Some(endpoint) => endpoint.to_owned(),
        None => match fetch_discovery(&config, client).await {
            Ok(discovery) => match discovery.revocation_endpoint {
                Some(endpoint) => endpoint,
                None => return false,
            },
            Err(_) => return false,
        },
    };
    client
        .post(endpoint)
        .form(&[("client_id", client_id), ("token", token)])
        .send()
        .await
        .ok()
        .is_some_and(|response| response.status().is_success())
}

#[derive(Default)]
pub struct Accounts {
    store: Store,
    revocations: crate::revocations::Revocations,
    discovery: Mutex<Option<(Instant, Discovery)>>,
    operation: Mutex<()>,
    generation: AtomicU64,
    cancelled: tokio::sync::Notify,
    signing_in: AtomicBool,
}

struct SignInGuard<'a>(&'a AtomicBool);

impl Drop for SignInGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Accounts {
    pub fn new(store: Store) -> Self {
        Self {
            revocations: crate::revocations::Revocations::new(store.clone()),
            store,
            ..Self::default()
        }
    }

    pub(crate) async fn queue_server_logout(
        &self,
        origin: &Url,
        cookies: String,
    ) -> Result<(), String> {
        if cookies.is_empty() {
            return Ok(());
        }
        self.revocations
            .enqueue(crate::revocations::Target::Session {
                origin: origin.origin().ascii_serialization(),
                cookies,
            })
            .await
    }

    pub(crate) async fn queue_installation_logout(
        &self,
        selection: crate::installation_transport::Selection,
        token: String,
    ) -> Result<(), String> {
        self.revocations
            .enqueue(crate::revocations::Target::Installation { selection, token })
            .await
    }

    pub(crate) async fn retry_installation_revocations(&self, authorization: &Authorization) {
        let account = crate::settings::account_key(authorization.account.identity());
        self.revocations
            .flush_installations(&account, |selection| async move {
                if !self.is_current(authorization) {
                    return Err(ERROR.into());
                }
                if !selection.uses_relay() {
                    return Ok(None);
                }
                crate::server_login::issue_relay(
                    authorization.directory_bearer()?,
                    &selection,
                    || self.is_current(authorization),
                )
                .await
                .map(Some)
            })
            .await;
    }

    pub(crate) fn retry_revocations(&self) {
        if self.revocations.is_known_empty() || self.revocations.is_running() {
            return;
        }
        let revocations = self.revocations.clone();
        tauri::async_runtime::spawn(async move {
            revocations.flush().await;
        });
    }

    pub(crate) fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.cancelled.notify_waiters();
    }

    async fn network<T>(
        &self,
        generation: u64,
        operation: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let cancelled = self.cancelled.notified();
        tokio::pin!(cancelled);
        cancelled.as_mut().enable();
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err("Accounts sign-in changed. Try again.".into());
        }
        tokio::select! {
            biased;
            _ = cancelled => Err("Accounts sign-in changed. Try again.".into()),
            result = operation => result,
        }
    }

    async fn queue_credential(
        &self,
        config: &Config,
        credential: &Credential,
    ) -> Result<(), String> {
        let endpoint = self.discovery.try_lock().ok().and_then(|cache| {
            cache
                .as_ref()
                .filter(|(_, discovery)| discovery.issuer == config.issuer)
                .and_then(|(_, discovery)| discovery.revocation_endpoint.clone())
        });
        for token in credential
            .refresh_token
            .iter()
            .chain(std::iter::once(&credential.access_token))
        {
            self.revocations
                .enqueue(crate::revocations::Target::OAuth {
                    issuer: config.issuer.clone(),
                    client_id: config.client_id.clone(),
                    token: token.clone(),
                    endpoint: endpoint.clone(),
                })
                .await?;
        }
        Ok(())
    }

    pub(crate) fn is_current(&self, authorization: &Authorization) -> bool {
        !self.signing_in.load(Ordering::SeqCst)
            && authorization.generation == self.generation.load(Ordering::SeqCst)
            && (authorization.personal.is_some() || authorization.account.expires_at > now())
    }

    /// The caller must validate the exact OS-held key before creating this local-only authority.
    pub(crate) fn personal_authorization(
        &self,
        credential: &crate::personal_devices::Credential,
        epoch: u64,
    ) -> Result<Authorization, String> {
        if !crate::profile::valid_epoch(&credential.profile_epoch) {
            return Err("Sign in to Accounts first.".into());
        }
        let authorization = Authorization {
            account: credential.account.clone(),
            token: String::new(),
            generation: self.generation.load(Ordering::SeqCst),
            profile_epoch: credential.profile_epoch.clone(),
            personal: Some(PersonalAuthority {
                selection: credential.selection.clone(),
                device_id: credential.device_id.clone(),
                epoch,
            }),
        };
        if !self.is_current(&authorization) {
            return Err(ERROR.into());
        }
        Ok(authorization)
    }

    pub(crate) async fn authorization(&self, origin: &Url) -> Result<Authorization, String> {
        self.authorization_config(origin, &Config::build()?).await
    }

    /// Identity metadata only. Reading it never renews or grants central authorization.
    pub(crate) async fn local_account(&self, origin: &Url) -> Result<Option<Account>, String> {
        let generation = self.generation.load(Ordering::SeqCst);
        let _operation = self.operation.lock().await;
        if self.signing_in.load(Ordering::SeqCst) {
            return Err(ERROR.into());
        }
        let config = Config::build()?;
        let Some(raw) = self.store.get(config.key(origin)).await? else {
            return Ok(None);
        };
        if raw.len() > 128 * 1024 {
            return Err(ERROR.into());
        }
        let stored: Credential = serde_json::from_str(&raw).map_err(|_| ERROR)?;
        if stored.account.issuer != config.issuer
            || generation != self.generation.load(Ordering::SeqCst)
        {
            return Err(ERROR.into());
        }
        Ok(Some(stored.account))
    }

    /// Read only the durable login lifetime; this never renews or creates central authority.
    pub(crate) async fn local_profile_epoch(
        &self,
        origin: &Url,
    ) -> Result<Option<(String, String)>, String> {
        let generation = self.generation.load(Ordering::SeqCst);
        let _operation = self.operation.lock().await;
        if self.signing_in.load(Ordering::SeqCst) {
            return Err(ERROR.into());
        }
        let config = Config::build()?;
        let Some(raw) = self.store.get(config.key(origin)).await? else {
            return Ok(None);
        };
        if raw.len() > 128 * 1024 {
            return Err(ERROR.into());
        }
        let stored: Credential = serde_json::from_str(&raw).map_err(|_| ERROR)?;
        if stored.account.issuer != config.issuer
            || generation != self.generation.load(Ordering::SeqCst)
        {
            return Err(ERROR.into());
        }
        Ok(Some((
            crate::settings::account_key(stored.account.identity()),
            login_profile_epoch(&stored.nonce),
        )))
    }

    async fn authorization_config(
        &self,
        origin: &Url,
        config: &Config,
    ) -> Result<Authorization, String> {
        let generation = self.generation.load(Ordering::SeqCst);
        let credential = self
            .credential_config(origin, config)
            .await?
            .ok_or("Sign in to Accounts first.")?;
        let authorization = Authorization {
            profile_epoch: login_profile_epoch(&credential.nonce),
            account: credential.account,
            token: credential.access_token,
            generation,
            personal: None,
        };
        if !self.is_current(&authorization) {
            return Err("Accounts sign-in changed. Try again.".into());
        }
        Ok(authorization)
    }

    pub(crate) async fn renew(
        &self,
        previous: &Authorization,
        origin: &Url,
    ) -> Result<Authorization, String> {
        let next = self.authorization(origin).await?;
        if previous.generation != next.generation
            || previous.account.issuer != next.account.issuer
            || previous.account.subject != next.account.subject
        {
            return Err("Accounts sign-in changed. Try again.".into());
        }
        Ok(next)
    }
    async fn discover(&self, config: &Config, client: &Client) -> Result<Discovery, String> {
        let mut cache = self.discovery.lock().await;
        if let Some((time, discovery)) = cache.as_ref() {
            if time.elapsed() < Duration::from_secs(300) && discovery.issuer == config.issuer {
                return Ok(discovery.clone());
            }
        }
        let discovery = fetch_discovery(config, client).await?;
        *cache = Some((Instant::now(), discovery.clone()));
        Ok(discovery)
    }

    pub async fn sign_in<F, Fut, C>(
        &self,
        origin: &Url,
        browser: &BrowserAuth,
        owner: &str,
        welcome_ork: Option<&str>,
        open: F,
        current: C,
    ) -> Result<Account, String>
    where
        F: FnOnce(String) -> Fut + Send,
        Fut: Future<Output = Result<(), String>> + Send,
        C: Fn() -> bool,
    {
        if welcome_ork.is_some_and(|value| !valid_personal_ork(value)) {
            return Err("Invalid welcome Ork.".into());
        }
        if self.signing_in.swap(true, Ordering::SeqCst) {
            return Err("Accounts sign-in is already in progress.".into());
        }
        let _signing_in = SignInGuard(&self.signing_in);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.cancelled.notify_waiters();
        let config = Config::build()?;
        let client = client()?;
        let discovery = self
            .network(generation, self.discover(&config, &client))
            .await?;
        let proof = Proof::new()?;
        let (callback, redirect) = browser
            .authorize_public(
                owner,
                |redirect| proof.authorize(&config, &discovery, redirect, welcome_ork),
                open,
            )
            .await?;
        proof.callback(&config, &discovery, &callback)?;
        let _operation = self.operation.lock().await;
        if !current() || generation != self.generation.load(Ordering::SeqCst) {
            return Err("Sign-in cancelled.".into());
        }
        let credential = self
            .network(generation, async {
                let response: TokenResponse = json(
                    client
                        .post(&discovery.token_endpoint)
                        .form(&[
                            ("grant_type", "authorization_code"),
                            ("client_id", &config.client_id),
                            ("code", &callback.code),
                            ("redirect_uri", &redirect),
                            ("code_verifier", &proof.verifier),
                        ])
                        .send()
                        .await
                        .map_err(|_| ERROR)?,
                )
                .await?;
                self.validate_tokens(
                    &client,
                    &config,
                    &discovery,
                    response,
                    Some(&proof.nonce),
                    None,
                )
                .await
            })
            .await?;
        if !current() || generation != self.generation.load(Ordering::SeqCst) {
            return Err("Sign-in cancelled.".into());
        }
        self.save(&config.key(origin), &credential).await?;
        Ok(credential.account)
    }

    async fn validate_tokens(
        &self,
        client: &Client,
        config: &Config,
        discovery: &Discovery,
        response: TokenResponse,
        nonce: Option<&str>,
        previous: Option<&Credential>,
    ) -> Result<Credential, String> {
        if response.access_token.is_empty()
            || !response.token_type.eq_ignore_ascii_case("bearer")
            || response.expires_in == 0
            || response.expires_in > 31_536_000
            || response
                .refresh_token
                .as_ref()
                .is_some_and(|token| token.is_empty())
        {
            return Err(ERROR.into());
        }
        let subject = if let Some(id_token) = &response.id_token {
            let keys: JwkSet = json(
                client
                    .get(&discovery.jwks_uri)
                    .send()
                    .await
                    .map_err(|_| ERROR)?,
            )
            .await?;
            let claims = verify_id_token(
                id_token,
                &keys,
                config,
                nonce
                    .map(|nonce| (nonce, true))
                    .or_else(|| previous.map(|previous| (previous.nonce.as_str(), false))),
                previous.map(|previous| previous.account.subject.as_str()),
            )?;
            verify_access_hash(&claims, &response.access_token)?;
            claims.sub
        } else {
            previous
                .map(|previous| previous.account.subject.clone())
                .filter(|_| nonce.is_none())
                .ok_or(ERROR)?
        };
        let userinfo: serde_json::Value = json(
            client
                .get(&discovery.userinfo_endpoint)
                .bearer_auth(&response.access_token)
                .send()
                .await
                .map_err(|_| ERROR)?,
        )
        .await?;
        if userinfo.get("sub").and_then(|value| value.as_str()) != Some(&subject) {
            return Err(ERROR.into());
        }
        Ok(Credential {
            account: Account {
                issuer: config.issuer.clone(),
                subject,
                userinfo,
                expires_at: now().saturating_add(response.expires_in),
            },
            nonce: nonce
                .map(str::to_owned)
                .or_else(|| previous.map(|previous| previous.nonce.clone()))
                .ok_or(ERROR)?,
            access_token: response.access_token,
            refresh_token: response
                .refresh_token
                .or_else(|| previous.and_then(|previous| previous.refresh_token.clone())),
        })
    }

    async fn save(&self, key: &str, credential: &Credential) -> Result<(), String> {
        self.store
            .set(
                key.into(),
                serde_json::to_string(credential).map_err(|_| ERROR)?,
            )
            .await
    }

    pub async fn session(&self, origin: &Url) -> Result<Option<Account>, String> {
        self.session_config(origin, &Config::build()?).await
    }

    async fn session_config(
        &self,
        origin: &Url,
        config: &Config,
    ) -> Result<Option<Account>, String> {
        let generation = self.generation.load(Ordering::SeqCst);
        let account = self
            .credential_config(origin, config)
            .await?
            .map(|credential| credential.account);
        if self.signing_in.load(Ordering::SeqCst)
            || generation != self.generation.load(Ordering::SeqCst)
        {
            return Err("Accounts sign-in changed. Try again.".into());
        }
        self.retry_revocations();
        Ok(account)
    }

    async fn credential_config(
        &self,
        origin: &Url,
        config: &Config,
    ) -> Result<Option<Credential>, String> {
        let generation = self.generation.load(Ordering::SeqCst);
        if self.signing_in.load(Ordering::SeqCst) {
            return Err("Accounts sign-in is in progress.".into());
        }
        let _operation = self.operation.lock().await;
        if self.signing_in.load(Ordering::SeqCst) {
            return Err("Accounts sign-in is in progress.".into());
        }
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err("Accounts sign-in changed. Try again.".into());
        }
        let key = config.key(origin);
        let Some(raw) = self.store.get(key.clone()).await? else {
            return Ok(None);
        };
        let previous: Credential = serde_json::from_str(&raw).map_err(|_| ERROR)?;
        if previous.account.issuer != config.issuer {
            return Err(ERROR.into());
        }
        if previous.account.expires_at > now() + 30 {
            return Ok(Some(previous));
        }
        let Some(refresh) = previous.refresh_token.as_ref() else {
            self.store.delete(key).await?;
            return Ok(None);
        };
        let client = client()?;
        let discovery = self
            .network(generation, self.discover(config, &client))
            .await?;
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err("Accounts sign-in changed. Try again.".into());
        }
        // Storage writes settle before cancellation can queue or retire this credential again.
        // Retire the predecessor before sending: an ambiguous result must never replay it.
        self.store.delete(key.clone()).await?;
        let result = self
            .network(generation, async {
                let response = client
                    .post(&discovery.token_endpoint)
                    .form(&[
                        ("grant_type", "refresh_token"),
                        ("client_id", &config.client_id),
                        ("refresh_token", refresh),
                    ])
                    .send()
                    .await
                    .map_err(|_| ERROR)?;
                if response.status() == reqwest::StatusCode::BAD_REQUEST
                    || response.status() == reqwest::StatusCode::UNAUTHORIZED
                {
                    return Ok(None);
                }
                let response: TokenResponse = json(response).await?;
                self.validate_tokens(&client, config, &discovery, response, None, Some(&previous))
                    .await
                    .map(Some)
            })
            .await;
        if generation != self.generation.load(Ordering::SeqCst) {
            // Logout can interrupt a refresh whose predecessor has already been retired.
            self.queue_credential(config, &previous).await?;
            return Err("Accounts sign-in changed. Try again.".into());
        }
        let Some(credential) = result? else {
            return Ok(None);
        };
        self.save(&key, &credential).await?;
        Ok(Some(credential))
    }

    /// Clear all native login scopes under one operation and one generation fence.
    pub async fn logout(&self, origins: &[Url], current: impl Fn() -> bool) -> Result<(), String> {
        self.logout_config_current(origins, &Config::build()?, current)
            .await
    }

    #[cfg(test)]
    async fn logout_config(&self, origins: &[Url], config: &Config) -> Result<(), String> {
        self.logout_config_current(origins, config, || true).await
    }

    async fn logout_config_current(
        &self,
        origins: &[Url],
        config: &Config,
        still_current: impl Fn() -> bool,
    ) -> Result<(), String> {
        if !still_current() {
            return Err("Accounts sign-in changed. Try again.".into());
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.cancelled.notify_waiters();
        let operation = self.operation.lock().await;
        let current = || {
            if still_current() && generation == self.generation.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("Accounts sign-in changed. Try again.".to_owned())
            }
        };
        current()?;
        let mut keys = std::collections::HashSet::new();
        let mut failure = None;
        for origin in origins {
            let key = config.key(origin);
            if !keys.insert(key.clone()) {
                continue;
            }
            let raw = self.store.get(key.clone()).await;
            current()?;
            // An unreadable or damaged credential must still be retired when deletion is available.
            if let Ok(Some(raw)) = raw {
                if let Ok(credential) = serde_json::from_str::<Credential>(&raw) {
                    if credential.account.issuer == config.issuer {
                        if let Err(error) = self.queue_credential(config, &credential).await {
                            failure = Some(error);
                        }
                    }
                }
            }
            current()?;
            if let Err(error) = self.store.delete(key).await {
                failure = Some(error);
            }
            current()?;
        }
        drop(operation);
        self.retry_revocations();
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
