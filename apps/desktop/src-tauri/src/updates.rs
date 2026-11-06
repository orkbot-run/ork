// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Preserves the inherited DesktopUpdateState contract. The Rust transport follows LICENSE.md.

use std::{
    future::Future,
    path::Path,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use url::Url;

const MIN_CHECK_INTERVAL: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_UPDATE_BYTES: u64 = 256 * 1024 * 1024;
const DISABLED: &str = "Automatic updates are turned off for this install.";
const UNPACKAGED: &str = "Automatic updates only run in an installed build.";
const GENERIC_FAILURE: &str = "The update could not be completed. Try again later.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Unsupported,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub phase: UpdatePhase,
    pub current_version: String,
    pub available_version: Option<String>,
    pub percent: Option<f64>,
    pub message: Option<String>,
    pub checked_at: Option<String>,
}

#[derive(Clone)]
struct Configuration {
    endpoint: Url,
    key: String,
}

fn configuration(
    enabled: Option<&str>,
    endpoint: Option<&str>,
    key: Option<&str>,
) -> Result<Configuration, String> {
    if enabled != Some("1") {
        return Err(DISABLED.into());
    }
    let endpoint = endpoint
        .and_then(|value| Url::parse(value).ok())
        .filter(secure_url)
        .ok_or("An HTTPS update feed is required.")?;
    let key = key
        .filter(|value| !value.trim().is_empty())
        .ok_or("An update verification key is required.")?;
    Ok(Configuration {
        endpoint,
        key: key.to_owned(),
    })
}

fn secure_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn installed_bundle(
    debug: bool,
    platform: &str,
    executable: &Path,
    bundle: Option<tauri::utils::config::BundleType>,
) -> bool {
    if debug {
        return false;
    }
    if platform == "macos" {
        let Some(macos) = executable.parent() else {
            return false;
        };
        let Some(contents) = macos.parent() else {
            return false;
        };
        let Some(application) = contents.parent() else {
            return false;
        };
        macos.file_name().is_some_and(|name| name == "MacOS")
            && contents.file_name().is_some_and(|name| name == "Contents")
            && application
                .extension()
                .is_some_and(|extension| extension == "app")
    } else {
        matches!(
            bundle,
            Some(
                tauri::utils::config::BundleType::AppImage
                    | tauri::utils::config::BundleType::Deb
                    | tauri::utils::config::BundleType::Rpm
                    | tauri::utils::config::BundleType::Msi
                    | tauri::utils::config::BundleType::Nsis
            )
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    NoReleases,
    Offline,
    Signature,
    ReadOnly,
    DiskFull,
    Other,
}

impl Failure {
    fn message(self) -> &'static str {
        match self {
            Self::NoReleases => "No desktop releases are published for this build yet.",
            Self::Offline => "Could not reach the update server.",
            Self::Signature => {
                "This update could not be verified. Reinstall Ork from a trusted download."
            }
            Self::ReadOnly => "Move Ork to Applications to install updates.",
            Self::DiskFull => "Free up disk space to install updates.",
            Self::Other => GENERIC_FAILURE,
        }
    }
}

fn failure(error: tauri_plugin_updater::Error) -> Failure {
    use tauri_plugin_updater::Error;
    match error {
        Error::ReleaseNotFound | Error::TargetNotFound(_) | Error::TargetsNotFound(_) => {
            Failure::NoReleases
        }
        Error::Reqwest(error) if error.status().is_some_and(|status| status.as_u16() == 404) => {
            Failure::NoReleases
        }
        Error::Reqwest(error) if error.is_connect() || error.is_timeout() => Failure::Offline,
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => Failure::Signature,
        Error::Io(error)
            if error.kind() == std::io::ErrorKind::PermissionDenied
                || error.kind() == std::io::ErrorKind::ReadOnlyFilesystem =>
        {
            Failure::ReadOnly
        }
        Error::Io(error) if error.kind() == std::io::ErrorKind::StorageFull => Failure::DiskFull,
        Error::TempDirNotOnSameMountPoint => Failure::ReadOnly,
        _ => Failure::Other,
    }
}

type Progress = Arc<dyn Fn(usize, Option<u64>) + Send + Sync>;
type Download<'a> = Pin<Box<dyn Future<Output = Result<Vec<u8>, Failure>> + Send + 'a>>;

/// This boundary keeps signature verification and platform installation in the native adapter.
trait Artifact: Send + Sync {
    fn version(&self) -> &str;
    fn download(&self, progress: Progress) -> Download<'_>;
    fn install(&self, bytes: &[u8]) -> Result<(), Failure>;
}

struct SignedArtifact(Update);
impl Artifact for SignedArtifact {
    fn version(&self) -> &str {
        &self.0.version
    }
    fn download(&self, progress: Progress) -> Download<'_> {
        Box::pin(async move {
            self.0
                .download(move |bytes, total| progress(bytes, total), || {})
                .await
                .map_err(failure)
        })
    }
    fn install(&self, bytes: &[u8]) -> Result<(), Failure> {
        // The plugin verifies the signature again immediately before touching the installation.
        self.0.install(bytes).map_err(failure)
    }
}

struct Data {
    state: UpdateState,
    configuration: Option<Configuration>,
    last_check: Option<Instant>,
    artifact: Option<Arc<dyn Artifact>>,
    verified_bytes: Option<Arc<Vec<u8>>>,
}

impl Data {
    fn initial<R: Runtime>(app: &AppHandle<R>) -> Self {
        let executable = std::env::current_exe().ok();
        let configured = if option_env!("ORKBOT_DISABLE_AUTO_UPDATE") == Some("1")
            || std::env::var("ORKBOT_DISABLE_AUTO_UPDATE").as_deref() == Ok("1")
        {
            Err(DISABLED.to_owned())
        } else if !executable.as_deref().is_some_and(|executable| {
            installed_bundle(
                cfg!(debug_assertions),
                std::env::consts::OS,
                executable,
                tauri::utils::platform::bundle_type(),
            )
        }) {
            Err(UNPACKAGED.to_owned())
        } else {
            configuration(
                option_env!("ORKBOT_ENABLE_AUTO_UPDATE"),
                option_env!("TAURI_UPDATER_ENDPOINT"),
                option_env!("TAURI_UPDATER_PUBLIC_KEY"),
            )
        };
        let message = configured.as_ref().err().cloned();
        Self {
            state: UpdateState {
                phase: if message.is_some() {
                    UpdatePhase::Unsupported
                } else {
                    UpdatePhase::Idle
                },
                current_version: app.package_info().version.to_string(),
                available_version: None,
                percent: None,
                message,
                checked_at: None,
            },
            configuration: configured.ok(),
            last_check: None,
            artifact: None,
            verified_bytes: None,
        }
    }
}

#[derive(Default)]
pub struct UpdateCheck {
    data: Mutex<Option<Data>>,
    operation: tokio::sync::Mutex<()>,
    menu: tokio::sync::Mutex<()>,
    background_started: AtomicBool,
}

impl UpdateCheck {
    fn mutate<T, R: Runtime>(&self, app: &AppHandle<R>, change: impl FnOnce(&mut Data) -> T) -> T {
        let mut data = self.data.lock().unwrap_or_else(|error| error.into_inner());
        change(data.get_or_insert_with(|| Data::initial(app)))
    }

    fn snapshot<R: Runtime>(&self, app: &AppHandle<R>) -> UpdateState {
        let mut state = self.mutate(app, |data| data.state.clone());
        state.message = state.message.map(|message| text(app, &message));
        state
    }

    async fn discover<R: Runtime, F, Fut>(
        &self,
        app: &AppHandle<R>,
        discover: F,
    ) -> (UpdateState, bool)
    where
        F: FnOnce(Configuration) -> Fut,
        Fut: Future<Output = Result<Option<Arc<dyn Artifact>>, Failure>>,
    {
        let Ok(_operation) = self.operation.try_lock() else {
            return (self.snapshot(app), false);
        };
        let configuration = self.mutate(app, |data| {
            if matches!(
                data.state.phase,
                UpdatePhase::Ready | UpdatePhase::Available | UpdatePhase::Downloading
            ) || data
                .last_check
                .is_some_and(|last| last.elapsed() < MIN_CHECK_INTERVAL)
            {
                return None;
            }
            let configuration = data.configuration.clone()?;
            data.last_check = Some(Instant::now());
            data.state.phase = UpdatePhase::Checking;
            data.state.message = None;
            data.state.percent = None;
            Some(configuration)
        });
        let Some(configuration) = configuration else {
            return (self.snapshot(app), false);
        };
        let result = discover(configuration).await;
        let download = self.mutate(app, |data| {
            data.state.checked_at = OffsetDateTime::now_utc().format(&Rfc3339).ok();
            data.verified_bytes = None;
            match result {
                Ok(Some(artifact)) => {
                    data.state.phase = UpdatePhase::Available;
                    data.state.available_version = Some(artifact.version().to_owned());
                    data.artifact = Some(artifact);
                    true
                }
                Ok(None) => {
                    data.state.phase = UpdatePhase::Idle;
                    data.state.available_version = None;
                    data.artifact = None;
                    false
                }
                Err(error) => {
                    data.state.phase = if error == Failure::NoReleases {
                        UpdatePhase::Unsupported
                    } else {
                        UpdatePhase::Error
                    };
                    data.state.message = Some(error.message().to_owned());
                    data.state.available_version = None;
                    data.artifact = None;
                    false
                }
            }
        });
        (self.snapshot(app), download)
    }

    async fn download<R: Runtime>(&self, app: &AppHandle<R>) -> UpdateState {
        let _operation = self.operation.lock().await;
        let artifact = self.mutate(app, |data| {
            if data.verified_bytes.is_some() || data.configuration.is_none() {
                return None;
            }
            let artifact = data.artifact.clone()?;
            data.state.phase = UpdatePhase::Downloading;
            data.state.percent = Some(0.0);
            data.state.message = None;
            Some(artifact)
        });
        let Some(artifact) = artifact else {
            return self.snapshot(app);
        };
        let received = Arc::new(AtomicU64::new(0));
        let (budget_sender, mut budget) = tokio::sync::watch::channel(false);
        let notifier = budget_sender.clone();
        let downloaded = Arc::clone(&received);
        let progress_app = app.clone();
        let progress: Progress = Arc::new(move |bytes, total| {
            let received = downloaded
                .fetch_add(bytes as u64, Ordering::Relaxed)
                .saturating_add(bytes as u64);
            if received > MAX_UPDATE_BYTES || total.is_some_and(|total| total > MAX_UPDATE_BYTES) {
                notifier.send_replace(true);
            }
            let manager = progress_app.state::<UpdateCheck>();
            manager.mutate(&progress_app, |data| {
                data.state.percent = total
                    .filter(|total| *total > 0)
                    .map(|total| (received as f64 / total as f64 * 100.0).clamp(0.0, 100.0));
            });
        });
        let result = tokio::select! {
            result = artifact.download(progress) => result,
            _ = budget.changed() => Err(Failure::Other),
        };
        let result = result.and_then(|bytes| {
            if bytes.is_empty() || bytes.len() as u64 > MAX_UPDATE_BYTES || *budget.borrow() {
                Err(Failure::Other)
            } else {
                Ok(bytes)
            }
        });
        self.mutate(app, |data| match result {
            Ok(bytes) => {
                data.verified_bytes = Some(Arc::new(bytes));
                data.state.phase = UpdatePhase::Ready;
                data.state.percent = None;
                data.state.message = None;
            }
            Err(error) => {
                data.verified_bytes = None;
                data.state.phase = UpdatePhase::Error;
                data.state.percent = None;
                data.state.message = Some(error.message().to_owned());
            }
        });
        drop(budget_sender);
        self.snapshot(app)
    }

    async fn install_with<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        confirm: impl FnOnce(&str) -> bool,
    ) -> (UpdateState, bool) {
        let _operation = self.operation.lock().await;
        let cached = self.mutate(app, |data| {
            if data.state.phase != UpdatePhase::Ready {
                return None;
            }
            Some((data.artifact.clone()?, data.verified_bytes.clone()?))
        });
        let Some((artifact, bytes)) = cached else {
            return (self.snapshot(app), false);
        };
        if !confirm(artifact.version()) {
            return (self.snapshot(app), false);
        }
        let result = tauri::async_runtime::spawn_blocking(move || artifact.install(&bytes)).await;
        match result {
            Ok(Ok(())) => (self.snapshot(app), true),
            result => {
                let error = result.ok().and_then(Result::err).unwrap_or(Failure::Other);
                self.mutate(app, |data| {
                    data.state.phase = UpdatePhase::Ready;
                    data.state.message = Some(error.message().to_owned());
                });
                (self.snapshot(app), false)
            }
        }
    }
}

fn text<R: Runtime>(app: &AppHandle<R>, message: &str) -> String {
    app.try_state::<Mutex<crate::locale::Locale>>()
        .and_then(|locale| locale.lock().ok().map(|locale| locale.text(message)))
        .unwrap_or_else(|| message.to_owned())
}

pub fn state(app: &AppHandle) -> UpdateState {
    app.state::<UpdateCheck>().snapshot(app)
}

/// Automatic checks may download a verified package, but never prompt or install it.
pub fn start_background(app: AppHandle) {
    if app
        .state::<UpdateCheck>()
        .background_started
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        // An empty feed can be temporary during first publication or channel replacement.
        if app
            .state::<UpdateCheck>()
            .mutate(&app, |data| data.configuration.is_none())
        {
            return;
        }
        loop {
            check_state(&app).await;
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

pub async fn check_state(app: &AppHandle) -> UpdateState {
    let manager = app.state::<UpdateCheck>();
    let native_app = app.clone();
    let (state, should_download) = manager
        .discover(app, move |configuration| async move {
            let cleanup = native_app.clone();
            let updater = native_app
                .updater_builder()
                .endpoints(vec![configuration.endpoint])
                .map_err(failure)?
                .pubkey(configuration.key)
                .timeout(REQUEST_TIMEOUT)
                .configure_client(|client| client.https_only(true))
                .on_before_exit(move || crate::shutdown_native(&cleanup))
                .build()
                .map_err(failure)?;
            let update = updater.check().await.map_err(failure)?;
            update
                .map(|update| {
                    if !secure_url(&update.download_url) {
                        return Err(Failure::Other);
                    }
                    Ok(Arc::new(SignedArtifact(update)) as Arc<dyn Artifact>)
                })
                .transpose()
        })
        .await;
    if should_download {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            download(&app).await;
        });
    }
    state
}

pub async fn download(app: &AppHandle) -> UpdateState {
    app.state::<UpdateCheck>().download(app).await
}

pub async fn install(app: &AppHandle) -> UpdateState {
    let (state, installed) = app
        .state::<UpdateCheck>()
        .install_with(app, |version| {
            app.dialog()
                .message(
                    text(app, "Ork {version} is ready to install.").replace("{version}", version),
                )
                .title(app.config().product_name.as_deref().unwrap_or("Ork"))
                .buttons(MessageDialogButtons::OkCancelCustom(
                    text(app, "Restart"),
                    text(app, "Later"),
                ))
                .blocking_show()
        })
        .await;
    if installed {
        crate::shutdown_native(app);
        app.restart();
    }
    state
}

/// The menu joins an existing download and uses the same native confirmation as the bridge.
pub async fn check(app: AppHandle) {
    let manager = app.state::<UpdateCheck>();
    let Ok(_menu) = manager.menu.try_lock() else {
        return;
    };
    let checked = check_state(&app).await;
    let checked = if matches!(
        checked.phase,
        UpdatePhase::Available | UpdatePhase::Downloading | UpdatePhase::Checking
    ) {
        download(&app).await
    } else {
        checked
    };
    if checked.phase == UpdatePhase::Ready {
        install(&app).await;
    } else {
        let message = checked.message.unwrap_or_else(|| {
            if checked.phase == UpdatePhase::Idle {
                text(&app, "Ork is up to date.")
            } else {
                text(&app, "Could not check for updates.")
            }
        });
        app.dialog()
            .message(message)
            .title(app.config().product_name.as_deref().unwrap_or("Ork"))
            .show(|_| {});
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_need_explicit_enablement_a_key_and_https() {
        assert!(configuration(
            None,
            Some("https://updates.example.com/latest.json"),
            Some("key")
        )
        .is_err());
        assert!(configuration(Some("1"), None, Some("key")).is_err());
        assert!(configuration(
            Some("1"),
            Some("https://updates.example.com/latest.json"),
            None
        )
        .is_err());
        for endpoint in [
            "http://updates.example.com",
            "file:///tmp/updates",
            "https://user:password@updates.example.com",
            "https://user@updates.example.com",
        ] {
            assert!(configuration(Some("1"), Some(endpoint), Some("key")).is_err());
        }
        assert!(configuration(
            Some("1"),
            Some("https://updates.example.com/latest.json"),
            Some("key")
        )
        .is_ok());
    }

    #[test]
    fn development_and_raw_mac_binaries_cannot_update() {
        assert!(!installed_bundle(
            true,
            "macos",
            Path::new("/Applications/Ork.app/Contents/MacOS/Ork"),
            None
        ));
        assert!(!installed_bundle(
            false,
            "macos",
            Path::new("/tmp/target/release/Ork"),
            None
        ));
        assert!(installed_bundle(
            false,
            "macos",
            Path::new("/Applications/Ork.app/Contents/MacOS/Ork"),
            None
        ));
        assert!(!installed_bundle(
            false,
            "windows",
            Path::new("app.exe"),
            None
        ));
        assert!(installed_bundle(
            false,
            "windows",
            Path::new("app.exe"),
            Some(tauri::utils::config::BundleType::Nsis)
        ));
    }

    #[test]
    fn disabled_updater_configuration_can_initialize_the_plugin() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let config: tauri_plugin_updater::Config =
            serde_json::from_value(config["plugins"]["updater"].clone()).unwrap();
        assert!(config.pubkey.is_empty());
        assert!(config.endpoints.is_empty());
        assert!(!config.dangerous_insecure_transport_protocol);
        assert!(!config.allow_downgrades);
        assert!(config.require_signed_version);
    }

    struct FakeArtifact {
        version: &'static str,
        fail_download: bool,
        installs: Arc<AtomicU64>,
    }

    struct OversizedArtifact;
    impl Artifact for OversizedArtifact {
        fn version(&self) -> &str {
            "0.8.0"
        }
        fn download(&self, progress: Progress) -> Download<'_> {
            Box::pin(async move {
                progress(1, Some(MAX_UPDATE_BYTES + 1));
                std::future::pending().await
            })
        }
        fn install(&self, _bytes: &[u8]) -> Result<(), Failure> {
            Err(Failure::Other)
        }
    }
    impl Artifact for FakeArtifact {
        fn version(&self) -> &str {
            self.version
        }
        fn download(&self, progress: Progress) -> Download<'_> {
            Box::pin(async move {
                progress(4, Some(4));
                if self.fail_download {
                    Err(Failure::Signature)
                } else {
                    Ok(vec![1, 2, 3, 4])
                }
            })
        }
        fn install(&self, bytes: &[u8]) -> Result<(), Failure> {
            assert_eq!(bytes, &[1, 2, 3, 4]);
            self.installs.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(UpdateCheck::default());
        app.state::<UpdateCheck>().mutate(app.handle(), |data| {
            data.configuration = Some(
                configuration(
                    Some("1"),
                    Some("https://updates.example.com/latest.json"),
                    Some("fixture-public-key"),
                )
                .unwrap(),
            );
            data.state.phase = UpdatePhase::Idle;
            data.state.message = None;
        });
        app
    }

    #[tokio::test]
    async fn only_verified_downloads_become_ready_and_installation_needs_confirmation() {
        let app = app();
        let manager = app.state::<UpdateCheck>();
        let installs = Arc::new(AtomicU64::new(0));
        let artifact: Arc<dyn Artifact> = Arc::new(FakeArtifact {
            version: "0.8.0",
            fail_download: false,
            installs: Arc::clone(&installs),
        });
        let (available, start_download) = manager
            .discover(app.handle(), move |_| async move { Ok(Some(artifact)) })
            .await;
        assert_eq!(available.phase, UpdatePhase::Available);
        assert!(start_download);
        assert!(available.checked_at.is_some());
        let ready = manager.download(app.handle()).await;
        assert_eq!(ready.phase, UpdatePhase::Ready);
        assert_eq!(ready.available_version.as_deref(), Some("0.8.0"));
        let (_, installed) = manager.install_with(app.handle(), |_| false).await;
        assert!(!installed);
        assert_eq!(installs.load(Ordering::SeqCst), 0);
        let (_, installed) = manager
            .install_with(app.handle(), |version| version == "0.8.0")
            .await;
        assert!(installed);
        assert_eq!(installs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_signature_failure_never_caches_or_installs_bytes() {
        let app = app();
        let manager = app.state::<UpdateCheck>();
        let installs = Arc::new(AtomicU64::new(0));
        let artifact: Arc<dyn Artifact> = Arc::new(FakeArtifact {
            version: "0.8.0",
            fail_download: true,
            installs: Arc::clone(&installs),
        });
        manager
            .discover(app.handle(), move |_| async move { Ok(Some(artifact)) })
            .await;
        let failed = manager.download(app.handle()).await;
        assert_eq!(failed.phase, UpdatePhase::Error);
        assert_eq!(
            failed.message.as_deref(),
            Some(Failure::Signature.message())
        );
        assert!(manager.mutate(app.handle(), |data| data.verified_bytes.is_none()));
        assert!(!manager.install_with(app.handle(), |_| true).await.1);
        assert_eq!(installs.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn oversized_downloads_are_cancelled_before_they_can_be_cached() {
        let app = app();
        let manager = app.state::<UpdateCheck>();
        manager
            .discover(app.handle(), |_| async {
                Ok(Some(Arc::new(OversizedArtifact) as Arc<dyn Artifact>))
            })
            .await;
        let failed = tokio::time::timeout(Duration::from_secs(1), manager.download(app.handle()))
            .await
            .unwrap();
        assert_eq!(failed.phase, UpdatePhase::Error);
        assert!(manager.mutate(app.handle(), |data| data.verified_bytes.is_none()));
        assert!(!manager.install_with(app.handle(), |_| true).await.1);
    }

    #[tokio::test]
    async fn a_feed_without_releases_can_discover_the_first_publication_later() {
        let app = app();
        let manager = app.state::<UpdateCheck>();
        let (empty, _) = manager
            .discover(app.handle(), |_| async { Err(Failure::NoReleases) })
            .await;
        assert_eq!(empty.phase, UpdatePhase::Unsupported);
        manager.mutate(app.handle(), |data| {
            assert!(data.configuration.is_some());
            data.last_check = Some(Instant::now() - MIN_CHECK_INTERVAL);
        });
        let (published, download) = manager
            .discover(app.handle(), |_| async {
                Ok(Some(Arc::new(FakeArtifact {
                    version: "1.1.1",
                    fail_download: false,
                    installs: Arc::new(AtomicU64::new(0)),
                }) as Arc<dyn Artifact>))
            })
            .await;
        assert_eq!(published.phase, UpdatePhase::Available);
        assert!(download);
    }

    #[tokio::test]
    async fn repeated_checks_are_rate_limited_and_do_not_report_offline_as_up_to_date() {
        let app = app();
        let manager = app.state::<UpdateCheck>();
        let (failed, _) = manager
            .discover(app.handle(), |_| async { Err(Failure::Offline) })
            .await;
        assert_eq!(failed.phase, UpdatePhase::Error);
        assert_eq!(failed.message.as_deref(), Some(Failure::Offline.message()));
        let calls = AtomicU64::new(0);
        let (unchanged, start_download) = manager
            .discover(app.handle(), |_| async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(None)
            })
            .await;
        assert_eq!(unchanged.checked_at, failed.checked_at);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!start_download);
    }
}
