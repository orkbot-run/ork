// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Adapted from the inherited local-stack.ts and docker-cli.ts, which remain Apache-2.0.
// The Rust implementation additions follow LICENSE.md.

use std::{
    collections::{BTreeMap, VecDeque},
    ffi::OsString,
    fs::{self, DirBuilder, Metadata, OpenOptions},
    future::Future,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{io::AsyncReadExt, process::Command, sync::watch};
use url::Url;

use crate::host_computer::Connection;

pub(crate) const LEGACY_PROJECT_NAME: &str = "orkbot-desktop-tauri";
const COMPOSE_FILE: &str = "docker-compose.images.yml";
const ENV_TEMPLATE: &str = ".env.images.example";
const ENV_FILE: &str = ".env";
const TOKEN_FILE: &str = ".desktop-stack-token";
const WEB_URL_FILE: &str = ".desktop-web-url";
const HOST_CONFIG_FILE: &str = ".desktop-host-config";
const OUTPUT_LINES: usize = 20;
const OUTPUT_BYTES: usize = 64 * 1024;
const LINE_BYTES: usize = 4096;
const FILE_BYTES: u64 = 1024 * 1024;
const SECRETS: [(&str, usize); 6] = [
    ("POSTGRES_PASSWORD", 16),
    ("POSTGRES_APP_PASSWORD", 16),
    ("BETTER_AUTH_SECRET", 32),
    ("ENCRYPTION_KEY", 32),
    ("SCREEN_PROXY_SECRET", 32),
    ("SANDBOX_SUPERVISOR_TOKEN", 32),
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalStackPhase {
    Idle,
    CheckingDocker,
    DockerMissing,
    DockerNotRunning,
    Preparing,
    Pulling,
    Starting,
    WaitingHealthy,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStackState {
    pub phase: LocalStackPhase,
    pub message: Option<String>,
    pub output: Vec<String>,
    pub layer_bytes: BTreeMap<String, u64>,
    pub image_tag: String,
    #[serde(skip)]
    pub generation: u64,
}

impl LocalStackState {
    fn initial(image_tag: &str) -> Self {
        Self {
            phase: LocalStackPhase::Idle,
            message: None,
            output: Vec::new(),
            layer_bytes: BTreeMap::new(),
            image_tag: image_tag.to_owned(),
            generation: 0,
        }
    }
}

pub type StateListener = Arc<dyn Fn(LocalStackState) + Send + Sync>;
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceOperation {
    organization_id: String,
    server_id: String,
    binding_version: u64,
    key_fingerprint: String,
    pub operation_id: String,
    pub completed: bool,
}
type LineListener = Arc<dyn Fn(String) + Send + Sync>;
type Environment = BTreeMap<String, OsString>;

struct Current {
    state: LocalStackState,
    web_url: Url,
}

/// Owns only this preview's Compose project. Bot execution remains in the Ork Server.
pub struct LocalStack {
    directory: PathBuf,
    project_name: String,
    account_key: Option<String>,
    resources: PathBuf,
    image_tag: String,
    environment: Environment,
    current: Arc<Mutex<Current>>,
    on_change: Option<StateListener>,
    operation: tokio::sync::Mutex<()>,
    cancellation: Mutex<Option<watch::Sender<bool>>>,
    generation: AtomicU64,
    stopping: AtomicBool,
    runner: Arc<dyn DockerRunner>,
    host: Option<Connection>,
    choice_save: tokio::sync::Mutex<()>,
}

impl LocalStack {
    pub fn new(
        directory: PathBuf,
        resources: PathBuf,
        image_tag: String,
        on_change: Option<StateListener>,
        host: Option<Connection>,
    ) -> Self {
        let web_url = read_web_url(&directory).unwrap_or_else(|| {
            Url::parse("http://127.0.0.1:45173").expect("The default local origin is valid")
        });
        Self {
            directory,
            project_name: LEGACY_PROJECT_NAME.to_owned(),
            account_key: None,
            resources,
            image_tag: image_tag.clone(),
            environment: std::env::vars_os()
                .filter_map(|(key, value)| Some((key.to_str()?.to_owned(), value)))
                .collect(),
            current: Arc::new(Mutex::new(Current {
                state: LocalStackState::initial(&image_tag),
                web_url,
            })),
            on_change,
            operation: tokio::sync::Mutex::new(()),
            cancellation: Mutex::new(None),
            generation: AtomicU64::new(0),
            stopping: AtomicBool::new(false),
            runner: Arc::new(SystemDocker),
            host,
            choice_save: tokio::sync::Mutex::new(()),
        }
    }

    /// Reuse only process configuration. Each account owns its Compose project and private files.
    pub fn scoped(
        &self,
        directory: PathBuf,
        project_name: String,
        account_key: String,
        on_change: Option<StateListener>,
        host: Option<Connection>,
    ) -> Self {
        let mut stack = Self::new(
            directory,
            self.resources.clone(),
            self.image_tag.clone(),
            on_change,
            host,
        );
        stack.project_name = project_name;
        stack.account_key = Some(account_key);
        stack.environment = self.environment.clone();
        stack.runner = self.runner.clone();
        stack
    }

    pub fn host_connection(&self) -> Option<Connection> {
        self.host.clone()
    }

    /// Saved local bookmarks must identify this account's existing instance before it starts.
    pub fn matches_saved_url(&self, expected: &str) -> bool {
        read_web_url(&self.directory)
            .is_some_and(|url| url.origin().ascii_serialization() == expected)
    }

    pub fn state(&self) -> LocalStackState {
        let mut state = self
            .current
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .state
            .clone();
        if self.stopping.load(Ordering::SeqCst) {
            state.phase = LocalStackPhase::Idle;
            state.message = Some("The local server is stopping. Retry when it has stopped.".into());
        }
        state
    }

    pub fn web_url(&self) -> Url {
        self.current
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .web_url
            .clone()
    }

    /// The receipt contains only public operation IDs. It survives app and daemon restarts.
    pub fn workspace_operation(
        &self,
        organization_id: &str,
        server_id: &str,
        binding_version: u64,
        key_fingerprint: &str,
    ) -> Result<WorkspaceOperation, String> {
        if !crate::server_directory::uuid(organization_id)
            || !crate::server_directory::uuid(server_id)
            || binding_version == 0
            || key_fingerprint.len() != 64
            || !key_fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("Workspace unavailable".into());
        }
        let path = self.directory.join(".desktop-workspace-operation");
        if fs::symlink_metadata(&path).is_ok() {
            let saved = read_private(&path, 1024).ok_or("Workspace unavailable")?;
            let value: WorkspaceOperation =
                serde_json::from_slice(&saved).map_err(|_| "Workspace unavailable")?;
            if value.organization_id != organization_id
                || value.server_id != server_id
                || value.binding_version != binding_version
                || value.key_fingerprint != key_fingerprint
                || !crate::server_directory::uuid(&value.operation_id)
            {
                return Err("Workspace unavailable".into());
            }
            return Ok(value);
        }
        let operation = WorkspaceOperation {
            organization_id: organization_id.to_owned(),
            server_id: server_id.to_owned(),
            binding_version,
            key_fingerprint: key_fingerprint.to_owned(),
            operation_id: crate::server_directory::device_id(
                &self.directory.join("workspace-operation"),
            )?,
            completed: false,
        };
        write_private(
            &path,
            &serde_json::to_vec(&operation).map_err(|_| "Workspace unavailable")?,
        )?;
        Ok(operation)
    }

    pub fn complete_workspace_operation(
        &self,
        mut operation: WorkspaceOperation,
    ) -> Result<(), String> {
        operation.completed = true;
        write_private(
            &self.directory.join(".desktop-workspace-operation"),
            &serde_json::to_vec(&operation).map_err(|_| "Workspace unavailable")?,
        )
    }

    pub async fn installation(&self, body: serde_json::Value) -> Result<serde_json::Value, String> {
        const ERROR: &str = "Could not complete local installation. Retry to continue.";
        if self.account_key.is_none() || !self.matches_desired_stack().await {
            return Err(ERROR.into());
        }
        let token = read_token(&self.directory).ok_or(ERROR)?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| ERROR)?;
        let mut response = client
            .post(
                self.web_url()
                    .join("/api/desktop-settings/installation")
                    .map_err(|_| ERROR)?,
            )
            .header("x-orkbot-desktop-stack-token", token)
            .json(&body)
            .send()
            .await
            .map_err(|_| ERROR)?;
        if !response.status().is_success() {
            return Err(ERROR.into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ERROR)? {
            if chunk.len() > (16 * 1024_usize).saturating_sub(bytes.len()) {
                return Err(ERROR.into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| ERROR.into())
    }

    /// A second click joins the existing intent instead of starting another Compose process.
    #[cfg(test)]
    pub async fn start(&self) -> LocalStackState {
        self.start_for(self.intent()).await
    }

    pub fn intent(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub async fn start_for(&self, generation: u64) -> LocalStackState {
        if generation != self.intent() {
            return self.state();
        }
        if self.stopping.load(Ordering::SeqCst) {
            return self.state();
        }
        let Ok(_operation) = self.operation.try_lock() else {
            return self.state();
        };
        let cancel = self.begin_operation();
        if generation != self.generation.load(Ordering::SeqCst)
            || self.stopping.load(Ordering::SeqCst)
        {
            self.abort();
        }
        let mut initial = LocalStackState::initial(&self.image_tag);
        initial.generation = generation;
        self.replace_state(initial);
        self.phase(LocalStackPhase::CheckingDocker);
        if let Err(message) = self.start_once(cancel).await {
            self.fail(message);
        }
        self.end_operation();
        self.state()
    }

    /// Interrupts our CLI process without stopping containers already created by the daemon.
    pub fn abort(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(cancel) = self
            .cancellation
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
        {
            cancel.send_replace(true);
        }
    }

    /// Stop preserves volumes, images, settings, and other Compose projects.
    pub async fn stop(&self) -> LocalStackState {
        self.stopping.store(true, Ordering::SeqCst);
        self.replace_state(self.state());
        self.abort();
        let _operation = self.operation.lock().await;
        let cancel = self.begin_operation();
        let stopped = async {
            match fs::symlink_metadata(self.directory.join(COMPOSE_FILE)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok::<(), String>(());
                }
                Err(_) => return Err("Could not read the local server configuration.".into()),
                Ok(_) => {}
            }
            read_private(&self.directory.join(COMPOSE_FILE), FILE_BYTES)
                .ok_or("Could not read the local server configuration.")?;
            let binary = resolve_docker_binary(&self.environment)
                .ok_or("Docker is not installed on this computer.")?;
            let token =
                read_token(&self.directory).ok_or("The local server settings are unavailable.")?;
            let values = read_environment(&self.directory)?;
            let redactions = redactions(&values, &token);
            let result = self
                .compose(
                    &binary,
                    &["stop"],
                    Duration::from_secs(90),
                    &token,
                    cancel,
                    redactions,
                )
                .await;
            if result.code == 0 {
                Ok(())
            } else {
                Err(
                    "Could not stop the local server. Check that Docker is running, then retry."
                        .into(),
                )
            }
        }
        .await;
        match stopped {
            Ok(()) => self.replace_state(LocalStackState::initial(&self.image_tag)),
            Err(message) => self.fail(message),
        }
        self.end_operation();
        self.stopping.store(false, Ordering::SeqCst);
        let state = self.state();
        if let Some(listener) = &self.on_change {
            listener(state.clone());
        }
        state
    }

    /// A health response only belongs to this app when both its private token and image match.
    pub async fn matches_desired_stack(&self) -> bool {
        if self.stopping.load(Ordering::SeqCst) || !self.matches_host_config() {
            return false;
        }
        let Some(token) = read_token(&self.directory) else {
            return false;
        };
        probe_owned_stack(&self.web_url(), &token, &self.image_tag).await
            && match &self.account_key {
                Some(owner) => probe_managed_account(&self.web_url(), &token, owner).await,
                None => true,
            }
            && !self.stopping.load(Ordering::SeqCst)
    }

    fn host_config_identity(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(b"accounts-only-owner-v2\0");
        hash.update(self.account_key.as_deref().unwrap_or_default().as_bytes());
        hash.update([0]);

        if let Some(host) = &self.host {
            hash.update(host.url.as_bytes());
            hash.update([0]);
            hash.update(host.token.as_bytes());
        }
        format!("{:x}", hash.finalize())
    }

    fn matches_host_config(&self) -> bool {
        match read_private(&self.directory.join(HOST_CONFIG_FILE), 256) {
            Some(saved) => saved == self.host_config_identity().as_bytes(),
            None => false,
        }
    }

    /// Persists only the existing native-main capability; browser sessions cannot choose a host.
    pub async fn save_host_choice(&self, computer_host: &str) -> Result<(), String> {
        if !matches!(computer_host, "docker" | "this-mac") {
            return Err("Invalid local computer choice.".into());
        }
        let _save = self.choice_save.lock().await;
        if !self.matches_desired_stack().await {
            return Err("Local server is unavailable.".into());
        }
        let token = read_token(&self.directory).ok_or("Local server is unavailable.")?;
        save_local_computer_host(&self.web_url(), &token, computer_host).await
    }

    fn begin_operation(&self) -> watch::Receiver<bool> {
        let (sender, receiver) = watch::channel(false);
        *self
            .cancellation
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(sender);
        receiver
    }

    fn end_operation(&self) {
        *self
            .cancellation
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }

    fn replace_state(&self, state: LocalStackState) {
        self.current
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .state = state.clone();
        if let Some(listener) = &self.on_change {
            listener(self.state());
        }
    }

    fn phase(&self, phase: LocalStackPhase) {
        let mut state = self.state();
        state.phase = phase;
        state.message = None;
        self.replace_state(state);
    }

    fn fail(&self, message: String) {
        let mut state = self.state();
        state.phase = LocalStackPhase::Failed;
        state.message = Some(message);
        self.replace_state(state);
    }

    fn wait_for_docker(&self, phase: LocalStackPhase, message: &str) {
        let mut state = self.state();
        state.phase = phase;
        state.message = Some(message.to_owned());
        self.replace_state(state);
    }

    async fn start_once(&self, cancel: watch::Receiver<bool>) -> Result<(), String> {
        private_directory(&self.directory)?;
        if self.matches_desired_stack().await {
            self.phase(LocalStackPhase::Ready);
            return Ok(());
        }
        check_cancelled(&cancel)?;
        let Some(binary) = resolve_docker_binary(&self.environment) else {
            self.wait_for_docker(
                LocalStackPhase::DockerMissing,
                "Docker is not installed on this computer.",
            );
            return Ok(());
        };
        let version = self
            .docker(
                &binary,
                strings(&["compose", "version", "--short"]),
                Duration::from_secs(15),
                None,
                cancel.clone(),
                Vec::new(),
            )
            .await;
        check_result_cancelled(&cancel, &version)?;
        if version.code != 0 {
            if failure_kind(&version) == DockerFailure::ComposeMissing {
                self.wait_for_docker(LocalStackPhase::DockerMissing, "Docker Compose is missing. Install Docker Desktop or the docker-compose-plugin, then retry.");
                return Ok(());
            }
            return Err(
                "Could not check Docker Compose. Check the Docker installation, then retry.".into(),
            );
        }
        let info = self
            .docker(
                &binary,
                strings(&["info", "--format", "{{.ServerVersion}}"]),
                Duration::from_secs(20),
                None,
                cancel.clone(),
                Vec::new(),
            )
            .await;
        check_result_cancelled(&cancel, &info)?;
        if info.code != 0 {
            let message = if failure_kind(&info) == DockerFailure::Permission {
                "This user cannot access Docker. Check Docker socket permissions, then retry."
            } else {
                "Docker is installed but not running. Start Docker, then retry."
            };
            self.wait_for_docker(LocalStackPhase::DockerNotRunning, message);
            return Ok(());
        }

        self.phase(LocalStackPhase::Preparing);
        let compose = read_private(&self.resources.join(COMPOSE_FILE), FILE_BYTES)
            .ok_or("Could not read the bundled local server configuration.")?;
        write_private(&self.directory.join(COMPOSE_FILE), &compose)?;
        ensure_environment(&self.directory, &self.resources.join(ENV_TEMPLATE))?;
        let token = ensure_token(&self.directory)?;
        let values = read_environment(&self.directory)?;
        let redactions = redactions(&values, &token);
        if read_web_url(&self.directory).is_none() {
            self.set_web_url(allocate_loopback_url()?);
        }
        check_cancelled(&cancel)?;

        let mut cached = immutable_image_tag(&self.image_tag)
            && self
                .images_cached(&binary, &token, cancel.clone(), redactions.clone())
                .await;
        if !cached {
            check_cancelled(&cancel)?;
            self.phase(LocalStackPhase::Pulling);
            let pull = self
                .compose(
                    &binary,
                    &["pull"],
                    Duration::from_secs(30 * 60),
                    &token,
                    cancel.clone(),
                    redactions.clone(),
                )
                .await;
            check_result_cancelled(&cancel, &pull)?;
            if pull.code != 0 {
                let kind = failure_kind(&pull);
                if matches!(
                    kind,
                    DockerFailure::ImageUnavailable | DockerFailure::Network
                ) {
                    cached = self
                        .images_cached(&binary, &token, cancel.clone(), redactions.clone())
                        .await;
                }
                check_cancelled(&cancel)?;
                if !cached {
                    return Err(failure_message(kind, true).into());
                }
            }
        }

        self.phase(LocalStackPhase::Starting);
        let mut up = vec!["up", "-d"];
        if cached {
            up.extend(["--pull", "never"]);
        }
        if compose_supports_wait_timeout(&version.stdout) {
            up.extend(["--wait", "--wait-timeout", "300"]);
        }
        for attempt in 0..3 {
            write_private(
                &self.directory.join(WEB_URL_FILE),
                self.web_url().origin().ascii_serialization().as_bytes(),
            )?;
            let result = self
                .compose(
                    &binary,
                    &up,
                    Duration::from_secs(360),
                    &token,
                    cancel.clone(),
                    redactions.clone(),
                )
                .await;
            check_result_cancelled(&cancel, &result)?;
            if result.code == 0 {
                break;
            }
            if failure_kind(&result) != DockerFailure::PortInUse || attempt == 2 {
                return Err(failure_message(failure_kind(&result), false).into());
            }
            self.set_web_url(allocate_loopback_url()?);
        }

        self.phase(LocalStackPhase::WaitingHealthy);
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut cancellation = cancel.clone();
        loop {
            check_cancelled(&cancel)?;
            let web_url = self.web_url();
            let ready = tokio::select! {
                ready = probe_owned_stack(&web_url, &token, &self.image_tag) => ready,
                _ = cancellation.changed() => return Err("The start was interrupted. Retry to continue.".into()),
            };
            if ready {
                if let Some(owner) = &self.account_key {
                    if !probe_managed_account(&web_url, &token, owner).await {
                        return Err("The local server could not verify this account. Update the local server and retry.".into());
                    }
                    check_cancelled(&cancel)?;
                }
                write_private(
                    &self.directory.join(HOST_CONFIG_FILE),
                    self.host_config_identity().as_bytes(),
                )?;
                self.phase(LocalStackPhase::Ready);
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(
                    "The local server started but did not answer. Retry and check Docker.".into(),
                );
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(2)) => {},
                _ = cancellation.changed() => return Err("The start was interrupted. Retry to continue.".into()),
            }
        }
    }

    fn set_web_url(&self, url: Url) {
        self.current
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .web_url = url;
    }

    async fn images_cached(
        &self,
        binary: &Path,
        token: &str,
        cancel: watch::Receiver<bool>,
        redactions: Vec<String>,
    ) -> bool {
        let images = self
            .compose(
                binary,
                &["config", "--images"],
                Duration::from_secs(20),
                token,
                cancel.clone(),
                redactions.clone(),
            )
            .await;
        if images.code != 0 || *cancel.borrow() {
            return false;
        }
        let images = images
            .stdout
            .split_whitespace()
            .collect::<std::collections::BTreeSet<_>>();
        if images.is_empty() || images.len() > 64 || images.iter().any(|image| image.len() > 512) {
            return false;
        }
        let mut args = strings(&["image", "inspect", "--format", "{{.Id}}", "--"]);
        args.extend(images.into_iter().map(str::to_owned));
        self.docker(
            binary,
            args,
            Duration::from_secs(20),
            Some(token),
            cancel,
            redactions,
        )
        .await
        .code
            == 0
    }

    async fn compose(
        &self,
        binary: &Path,
        args: &[&str],
        timeout: Duration,
        token: &str,
        cancel: watch::Receiver<bool>,
        redactions: Vec<String>,
    ) -> DockerResult {
        let mut arguments = strings(&[
            "compose",
            "--env-file",
            ENV_FILE,
            "-f",
            COMPOSE_FILE,
            "--project-name",
            &self.project_name,
        ]);
        arguments.extend(args.iter().map(|arg| (*arg).to_owned()));
        self.docker(binary, arguments, timeout, Some(token), cancel, redactions)
            .await
    }

    async fn docker(
        &self,
        binary: &Path,
        args: Vec<String>,
        timeout: Duration,
        token: Option<&str>,
        cancel: watch::Receiver<bool>,
        mut redactions: Vec<String>,
    ) -> DockerResult {
        if let Some(owner) = &self.account_key {
            redactions.push(owner.clone());
        }
        if let Some(host) = &self.host {
            redactions.push(host.token.clone());
            redactions.sort_by_key(|value| std::cmp::Reverse(value.len()));
            redactions.dedup();
        }
        let mut environment = docker_environment(
            &self.environment,
            binary,
            &self.web_url(),
            &self.image_tag,
            token,
            self.host.as_ref(),
        );
        if let Some(owner) = &self.account_key {
            environment.insert("ORKBOT_DESKTOP_ACCOUNT_KEY".into(), OsString::from(owner));
        }
        let current = Arc::clone(&self.current);
        let listener = self.on_change.clone();
        let output_redactions = redactions.clone();
        let output: LineListener = Arc::new(move |line| {
            let line = redact_line(&line, &output_redactions);
            if line.is_empty() {
                return;
            }
            let state = {
                let mut current = current.lock().unwrap_or_else(|error| error.into_inner());
                if !matches!(
                    current.state.phase,
                    LocalStackPhase::Pulling
                        | LocalStackPhase::Starting
                        | LocalStackPhase::WaitingHealthy
                ) {
                    return;
                }
                update_layer_bytes(&mut current.state.layer_bytes, &line);
                current.state.output.push(line);
                if current.state.output.len() > OUTPUT_LINES {
                    current.state.output.remove(0);
                }
                current.state.clone()
            };
            if let Some(listener) = &listener {
                listener(state);
            }
        });
        let result = self
            .runner
            .run(
                DockerRequest {
                    binary: binary.to_path_buf(),
                    args,
                    cwd: self.directory.clone(),
                    environment,
                    timeout,
                },
                cancel,
                output,
            )
            .await;
        DockerResult {
            code: result.code,
            stdout: redact_text(&result.stdout, &redactions),
            stderr: redact_text(&result.stderr, &redactions),
        }
    }
}

impl Drop for LocalStack {
    fn drop(&mut self) {
        self.abort();
    }
}

pub fn image_tag(version: &str, packaged: bool, revision: Option<&str>) -> String {
    if let Some(revision) = revision.filter(|revision| packaged && source_revision(revision)) {
        format!("sha-{revision}")
    } else if packaged && stable_version(version) {
        format!("v{version}")
    } else {
        "edge".into()
    }
}

fn source_revision(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn immutable_image_tag(value: &str) -> bool {
    value.strip_prefix("sha-").is_some_and(source_revision)
        || value.strip_prefix('v').is_some_and(stable_version)
}

fn stable_version(version: &str) -> bool {
    let parts = version.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

fn check_cancelled(cancel: &watch::Receiver<bool>) -> Result<(), String> {
    if *cancel.borrow() {
        Err("The start was interrupted. Retry to continue.".into())
    } else {
        Ok(())
    }
}

fn check_result_cancelled(
    cancel: &watch::Receiver<bool>,
    result: &DockerResult,
) -> Result<(), String> {
    if result.code == 130 {
        return Err("The start was interrupted. Retry to continue.".into());
    }
    check_cancelled(cancel)
}

pub(crate) fn private_directory(directory: &Path) -> Result<(), String> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(directory)
        .map_err(|_| "Could not prepare the local server directory.")?;
    let metadata = fs::symlink_metadata(directory)
        .map_err(|_| "Could not read the local server directory.")?;
    if !metadata.is_dir() || reparse_point(&metadata) {
        return Err("The local server directory is not a regular directory.".into());
    }
    Ok(())
}

pub(crate) fn read_private(path: &Path, limit: u64) -> Option<Vec<u8>> {
    read_regular_file(path, limit, false)
}

pub(crate) fn read_owned_private(path: &Path, limit: u64) -> Option<Vec<u8>> {
    read_regular_file(path, limit, true)
}

fn read_regular_file(path: &Path, limit: u64, private: bool) -> Option<Vec<u8>> {
    let before = fs::symlink_metadata(path).ok()?;
    if !before.is_file() || reparse_point(&before) || before.len() > limit {
        return None;
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path).ok()?;
    let after = file.metadata().ok()?;
    if !after.is_file() || reparse_point(&after) {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions and never changes process credentials.
        let uid = unsafe { libc::geteuid() };
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || (private && (after.uid() != uid || after.mode() & 0o077 != 0))
        {
            return None;
        }
    }
    #[cfg(not(unix))]
    if private {
        // Without an ACL ownership check, an old instance remains unbound and untouched.
        return None;
    }
    let mut contents = Vec::new();
    file.take(limit + 1).read_to_end(&mut contents).ok()?;
    (contents.len() as u64 <= limit).then_some(contents)
}

pub(crate) fn reparse_point(metadata: &Metadata) -> bool {
    #[cfg(unix)]
    {
        metadata.file_type().is_symlink()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x0000_0400 != 0
    }
}

pub(crate) fn write_private(path: &Path, contents: &[u8]) -> Result<(), String> {
    let directory = path.parent().ok_or("The local server path is invalid.")?;
    let mut file = tempfile::NamedTempFile::new_in(directory)
        .map_err(|_| "Could not write local server settings.")?;
    file.write_all(contents)
        .map_err(|_| "Could not write local server settings.")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Could not write local server settings.")?;
    file.persist(path)
        .map_err(|_| "Could not save local server settings.")?;
    Ok(())
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut value = vec![0; bytes];
    getrandom::fill(&mut value).map_err(|_| "Could not generate local server secrets.")?;
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn render_environment(
    template: &str,
    mut random: impl FnMut(usize) -> Result<String, String>,
) -> Result<String, String> {
    let mut lines = Vec::new();
    for line in template.split('\n') {
        let (name, value) = line.split_once('=').unwrap_or(("", ""));
        if matches!(name, "ORKBOT_IMAGE_TAG" | "ORKBOT_COMPUTER_IMAGE_TAG") {
            continue;
        }
        if value.is_empty() && line == format!("{name}=") {
            if let Some((_, bytes)) = SECRETS.iter().find(|(secret, _)| *secret == name) {
                lines.push(format!("{name}={}", random(*bytes)?));
                continue;
            }
        }
        lines.push(line.to_owned());
    }
    Ok(lines.join("\n"))
}

fn ensure_environment(directory: &Path, template: &Path) -> Result<(), String> {
    let destination = directory.join(ENV_FILE);
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if !reparse_point(&metadata) {
            read_environment(directory)?;
            return Ok(());
        }
    }
    let template = read_private(template, FILE_BYTES)
        .ok_or("Could not read the bundled local server settings.")?;
    let template = std::str::from_utf8(&template)
        .map_err(|_| "The bundled local server settings are invalid.")?;
    let contents = render_environment(template, random_hex)?;
    parse_environment(&contents)?;
    write_private(&destination, contents.as_bytes())
}

fn parse_environment(contents: &str) -> Result<BTreeMap<String, String>, String> {
    let values = dotenvy::from_read_iter(contents.as_bytes())
        .collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(|_| {
            "The local server settings are invalid. Correct the settings before retrying."
        })?;
    if SECRETS.iter().any(|(name, _)| {
        values
            .get(*name)
            .is_none_or(|value| value.trim().is_empty())
    }) {
        return Err("The local server settings are missing required secrets. Restore the existing settings before retrying.".into());
    }
    Ok(values)
}

fn read_environment(directory: &Path) -> Result<BTreeMap<String, String>, String> {
    let contents = read_private(&directory.join(ENV_FILE), FILE_BYTES)
        .ok_or("Could not read the local server settings.")?;
    let contents =
        std::str::from_utf8(&contents).map_err(|_| "The local server settings are invalid.")?;
    parse_environment(contents)
}

fn read_token(directory: &Path) -> Option<String> {
    let value = read_private(&directory.join(TOKEN_FILE), 1024)?;
    let value = std::str::from_utf8(&value).ok()?.trim();
    (value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then(|| value.to_owned())
}

fn ensure_token(directory: &Path) -> Result<String, String> {
    if let Some(token) = read_token(directory) {
        return Ok(token);
    }
    let token = random_hex(32)?;
    write_private(&directory.join(TOKEN_FILE), format!("{token}\n").as_bytes())?;
    Ok(token)
}

fn read_web_url(directory: &Path) -> Option<Url> {
    let bytes = read_private(&directory.join(WEB_URL_FILE), 128)?;
    let value = std::str::from_utf8(&bytes).ok()?;
    let port = value
        .strip_prefix("http://127.0.0.1:")?
        .parse::<u16>()
        .ok()?;
    if port < 1024 || value != format!("http://127.0.0.1:{port}") {
        return None;
    }
    Url::parse(value).ok()
}

fn allocate_loopback_url() -> Result<Url, String> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| "Could not allocate a local server port.")?;
    let port = listener
        .local_addr()
        .map_err(|_| "Could not allocate a local server port.")?
        .port();
    Url::parse(&format!("http://127.0.0.1:{port}"))
        .map_err(|_| "Could not allocate a local server port.".into())
}

fn local_stack_target(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some_and(|port| port >= 1024)
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

async fn save_local_computer_host(
    url: &Url,
    token: &str,
    computer_host: &str,
) -> Result<(), String> {
    const ERROR: &str = "Could not save local computer choice.";
    if !local_stack_target(url) {
        return Err(ERROR.into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| ERROR)?;
    let target = url
        .join("/api/desktop-settings/computer-host")
        .map_err(|_| ERROR)?;
    let mut response = client
        .post(target)
        .header("x-orkbot-local-settings-token", token)
        .json(&serde_json::json!({"computerHost": computer_host}))
        .send()
        .await
        .map_err(|_| ERROR)?;
    if !response.status().is_success() || response.content_length().is_some_and(|size| size > 1024)
    {
        return Err(ERROR.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ERROR)? {
        if chunk.len() > 1024_usize.saturating_sub(bytes.len()) {
            return Err(ERROR.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    if value.get("ok") != Some(&serde_json::Value::Bool(true)) {
        return Err(ERROR.into());
    }
    Ok(())
}

async fn probe_stack_json(url: &Url, path: &str, token: &str) -> Option<serde_json::Value> {
    if !local_stack_target(url) {
        return None;
    }
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return None;
    };
    let Ok(target) = url.join(path) else {
        return None;
    };
    let Ok(mut response) = client
        .get(target)
        .header("x-orkbot-desktop-stack-token", token)
        .send()
        .await
    else {
        return None;
    };
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|bytes| bytes > OUTPUT_BYTES as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if chunk.len() <= OUTPUT_BYTES.saturating_sub(bytes.len()) => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return None,
        }
    }
    serde_json::from_slice(&bytes).ok()
}

async fn probe_owned_stack(url: &Url, token: &str, image_tag: &str) -> bool {
    probe_stack_json(url, "/.well-known/orkbot-desktop-stack", token)
        .await
        .is_some_and(|value| {
            value.get("ok") == Some(&serde_json::Value::Bool(true))
                && value.get("imageTag").and_then(serde_json::Value::as_str) == Some(image_tag)
        })
}

async fn probe_managed_account(url: &Url, token: &str, owner: &str) -> bool {
    probe_stack_json(url, "/api/auth/capabilities", token)
        .await
        .is_some_and(|value| {
            value
                .get("managedAccountKey")
                .and_then(serde_json::Value::as_str)
                == Some(owner)
        })
}

fn redactions(values: &BTreeMap<String, String>, token: &str) -> Vec<String> {
    let mut secrets = values
        .iter()
        .filter(|(name, value)| {
            !value.is_empty()
                && !matches!(name.as_str(), "MASTER_KEY_PROVIDER" | "SECRET_STORE")
                && (["PASSWORD", "SECRET", "TOKEN", "KEY"]
                    .iter()
                    .any(|part| name.contains(part))
                    || matches!(name.as_str(), "SMTP_URL" | "DATABASE_URL"))
        })
        .flat_map(|(_, value)| {
            std::iter::once(value.clone()).chain(value.split(['\r', '\n']).map(str::to_owned))
        })
        .collect::<Vec<_>>();
    secrets.push(token.to_owned());
    secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
    secrets.dedup();
    secrets
}

fn redact_text(text: &str, secrets: &[String]) -> String {
    let mut text = text.to_owned();
    for secret in secrets {
        if !secret.is_empty() {
            text = text.replace(secret, "[redacted]");
        }
    }
    text
}

fn redact_line(line: &str, secrets: &[String]) -> String {
    redact_text(line, secrets)
        .trim()
        .chars()
        .take(LINE_BYTES)
        .collect()
}

fn update_layer_bytes(layers: &mut BTreeMap<String, u64>, line: &str) {
    let parts = line.split_whitespace().collect::<Vec<_>>();
    if parts.len() < 3 || parts[1] != "Downloading" || parts[0].len() > 128 {
        return;
    }
    let value = parts[2];
    let boundary = value
        .find(|character: char| !character.is_ascii_digit() && character != '.')
        .unwrap_or(value.len());
    let Ok(number) = value[..boundary].parse::<f64>() else {
        return;
    };
    let unit = if boundary == value.len() {
        parts.get(3).copied().unwrap_or("")
    } else {
        &value[boundary..]
    };
    let multiplier = match unit {
        "B" => 1.0,
        "KB" | "kB" => 1000.0,
        "MB" => 1_000_000.0,
        "GB" => 1_000_000_000.0,
        _ => return,
    };
    let bytes = number * multiplier;
    if !bytes.is_finite()
        || bytes <= 0.0
        || (layers.len() >= 1024 && !layers.contains_key(parts[0]))
    {
        return;
    }
    let previous = layers.entry(parts[0].to_owned()).or_default();
    *previous = (*previous).max(bytes as u64);
}

fn install_directories(environment: &Environment) -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut paths = vec![
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/Applications/Docker.app/Contents/Resources/bin"),
        ];
        if let Some(home) = environment.get("HOME") {
            for suffix in [".orbstack/bin", ".docker/bin", ".rd/bin"] {
                paths.push(PathBuf::from(home).join(suffix));
            }
        }
        paths.push(PathBuf::from(
            "/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin",
        ));
        paths
    }
    #[cfg(target_os = "windows")]
    {
        vec![PathBuf::from(
            environment
                .get("ProgramFiles")
                .cloned()
                .unwrap_or_else(|| OsString::from("C:\\Program Files")),
        )
        .join("Docker/Docker/resources/bin")]
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = environment;
        vec![PathBuf::from("/usr/bin"), PathBuf::from("/usr/local/bin")]
    }
}

fn resolve_docker_binary(environment: &Environment) -> Option<PathBuf> {
    if let Some(override_path) = environment
        .get("ORKBOT_DOCKER_BINARY")
        .filter(|value| !value.is_empty())
    {
        let path = PathBuf::from(override_path);
        return direct_executable(&path).then_some(path);
    }
    let mut paths = install_directories(environment);
    if let Some(path) = environment.get("PATH") {
        paths.extend(std::env::split_paths(path).filter(|path| !path.as_os_str().is_empty()));
    }
    let binary = if cfg!(windows) {
        "docker.exe"
    } else {
        "docker"
    };
    paths
        .into_iter()
        .map(|path| path.join(binary))
        .find(|path| direct_executable(path))
}

fn direct_executable(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    path.is_absolute()
        && path.is_file()
        && !extension.eq_ignore_ascii_case("bat")
        && !extension.eq_ignore_ascii_case("cmd")
}

fn docker_environment(
    source: &Environment,
    binary: &Path,
    url: &Url,
    image_tag: &str,
    token: Option<&str>,
    host: Option<&Connection>,
) -> Environment {
    let mut environment = Environment::new();
    let mut allowed = vec![
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "XDG_RUNTIME_DIR",
        "DOCKER_HOST",
        "DOCKER_CONFIG",
        "DOCKER_CONTEXT",
        "DOCKER_CERT_PATH",
        "DOCKER_TLS_VERIFY",
    ];
    if cfg!(windows) {
        allowed.extend([
            "SystemRoot",
            "SystemDrive",
            "APPDATA",
            "LOCALAPPDATA",
            "ProgramData",
            "ProgramFiles",
        ]);
    }
    for key in allowed {
        if let Some(value) = source.get(key).filter(|value| !value.is_empty()) {
            environment.insert(key.to_owned(), value.clone());
        }
    }
    let mut paths = binary
        .parent()
        .map(Path::to_path_buf)
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(path) = source.get("PATH") {
        paths.extend(std::env::split_paths(path).filter(|path| !path.as_os_str().is_empty()));
    }
    if cfg!(target_os = "macos") {
        paths.extend(install_directories(source));
    }
    let mut seen = std::collections::BTreeSet::new();
    paths.retain(|path| seen.insert(path.clone()));
    if let Ok(path) = std::env::join_paths(paths) {
        environment.insert("PATH".into(), path);
    }
    let origin = url.origin().ascii_serialization();
    for (key, value) in [
        (
            "SANDBOX_HOST_URL",
            host.map_or("", |host| host.url.as_str()).to_owned(),
        ),
        (
            "SANDBOX_HOST_TOKEN",
            host.map_or("", |host| host.token.as_str()).to_owned(),
        ),
        ("ORKBOT_IMAGE_TAG", image_tag.to_owned()),
        ("ORKBOT_COMPUTER_IMAGE_TAG", image_tag.to_owned()),
        ("SANDBOX_COMPUTER_EGRESS", "open".to_owned()),
        ("CONTENT_ENCRYPTION", "off".to_owned()),
        ("AUTH_PASSWORD_ENABLED", "false".to_owned()),
        ("MESSAGING_OPEN_SIGNUP", "false".to_owned()),
        ("AUTH_ACCOUNTS_ENABLED", "true".to_owned()),
        ("ORKBOT_WEB_BIND", "127.0.0.1".to_owned()),
        ("ORKBOT_WEB_PORT", url.port().unwrap_or(80).to_string()),
        ("ORKBOT_API_PORT", "0".to_owned()),
        ("BETTER_AUTH_URL", origin.clone()),
        ("WEB_ORIGIN", origin.clone()),
        ("API_URL", origin),
        ("COMPOSE_PROGRESS", "plain".to_owned()),
    ] {
        environment.insert(key.to_owned(), OsString::from(value));
    }
    if let Some(token) = token {
        environment.insert("ORKBOT_DESKTOP_STACK_TOKEN".into(), OsString::from(token));
    }
    environment
}

fn compose_supports_wait_timeout(version: &str) -> bool {
    version.split(|character: char| !character.is_ascii_digit() && character != '.').any(|part| {
        let mut numbers = part.split('.');
        let major = numbers.next().and_then(|value| value.parse::<u32>().ok());
        let minor = numbers.next().and_then(|value| value.parse::<u32>().ok());
        matches!((major, minor), (Some(major), Some(minor)) if major > 2 || (major == 2 && minor >= 17))
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DockerFailure {
    ComposeMissing,
    Daemon,
    Permission,
    ImageUnavailable,
    PortInUse,
    Network,
    AddressPool,
    Other,
}

fn failure_kind(result: &DockerResult) -> DockerFailure {
    let text = format!("{}\n{}", result.stdout, result.stderr).to_lowercase();
    for (kind, needles) in [
        (
            DockerFailure::Permission,
            &[
                "permission denied while trying to connect",
                "got permission denied",
                "connect: permission denied",
            ][..],
        ),
        (
            DockerFailure::Daemon,
            &[
                "cannot connect to the docker daemon",
                "is the docker daemon running",
                "error during connect",
                "docker desktop is starting",
                "the system cannot find the file specified",
            ][..],
        ),
        (
            DockerFailure::ComposeMissing,
            &[
                "'compose' is not a docker command",
                "unknown command: docker compose",
            ][..],
        ),
        (
            DockerFailure::PortInUse,
            &[
                "address already in use",
                "port is already allocated",
                "bind for 127.0.0.1",
                "ports are not available",
                "only one usage of each socket address",
                "socket in a way forbidden by its access permissions",
            ][..],
        ),
        (
            DockerFailure::ImageUnavailable,
            &[
                "manifest unknown",
                "pull access denied",
                "not found: manifest",
                "no matching manifest",
                "repository does not exist",
                "unauthorized",
                "denied: requested access",
            ][..],
        ),
        (
            DockerFailure::AddressPool,
            &[
                "all predefined address pools have been fully subnetted",
                "could not find an available, non-overlapping ipv4 address pool",
            ][..],
        ),
        (
            DockerFailure::Network,
            &[
                "no such host",
                "tls handshake timeout",
                "i/o timeout",
                "temporary failure in name resolution",
                "connection refused",
                "network is unreachable",
                "context deadline exceeded",
            ][..],
        ),
    ] {
        if needles.iter().any(|needle| text.contains(needle)) {
            return kind;
        }
    }
    if text.contains("failed to resolve reference") && text.contains(": not found") {
        return DockerFailure::ImageUnavailable;
    }
    DockerFailure::Other
}

fn failure_message(kind: DockerFailure, pulling: bool) -> &'static str {
    match kind {
        DockerFailure::ImageUnavailable => "The local server images are unavailable. Check registry access or the image version, then retry.",
        DockerFailure::PortInUse => "Could not open a local port. Retry to choose another port.",
        DockerFailure::AddressPool => "Docker has no free network address pools. Remove unused Docker networks or expand its address pools, then retry.",
        DockerFailure::Network => "Could not reach the image registry. Check the internet connection, then retry.",
        DockerFailure::Daemon => "Docker stopped answering. Start Docker, then retry.",
        DockerFailure::Permission => "This user cannot access Docker. Check Docker socket permissions, then retry.",
        DockerFailure::ComposeMissing => "Docker Compose is missing. Install Docker Desktop or the docker-compose-plugin, then retry.",
        DockerFailure::Other if pulling => "Downloading the local server images failed. Check Docker and registry access, then retry.",
        DockerFailure::Other => "The local server services did not start. Check Docker, then retry.",
    }
}

#[derive(Clone)]
struct DockerRequest {
    binary: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    environment: Environment,
    timeout: Duration,
}

#[derive(Clone)]
struct DockerResult {
    code: i32,
    stdout: String,
    stderr: String,
}

trait DockerRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        request: DockerRequest,
        cancel: watch::Receiver<bool>,
        on_line: LineListener,
    ) -> Pin<Box<dyn Future<Output = DockerResult> + Send + 'a>>;
}

struct SystemDocker;

impl DockerRunner for SystemDocker {
    fn run<'a>(
        &'a self,
        request: DockerRequest,
        mut cancel: watch::Receiver<bool>,
        on_line: LineListener,
    ) -> Pin<Box<dyn Future<Output = DockerResult> + Send + 'a>> {
        Box::pin(async move {
            let rejected = |code| DockerResult {
                code,
                stdout: String::new(),
                stderr: String::new(),
            };
            if *cancel.borrow() {
                return rejected(130);
            }
            if !direct_executable(&request.binary)
                || request.args.iter().any(|arg| arg.contains('\0'))
            {
                return rejected(1);
            }
            let mut command = Command::new(&request.binary);
            command
                .args(&request.args)
                .current_dir(&request.cwd)
                .env_clear()
                .envs(&request.environment)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                command.as_std_mut().process_group(0);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.as_std_mut().creation_flags(0x0800_0000);
            }
            let Ok(mut child) = command.spawn() else {
                return rejected(1);
            };
            let mut group = ProcessGroup {
                pid: child.id(),
                armed: true,
            };
            let stdout = child.stdout.take().expect("Docker stdout is piped");
            let stderr = child.stderr.take().expect("Docker stderr is piped");
            let mut output = tokio::spawn(read_output(stdout, Arc::clone(&on_line)));
            let mut errors = tokio::spawn(read_output(stderr, on_line));
            let code = tokio::select! {
                status = child.wait() => status.ok().and_then(|status| status.code()).unwrap_or(1),
                _ = tokio::time::sleep(request.timeout) => 124,
                _ = cancel.changed() => 130,
            };
            if matches!(code, 124 | 130) {
                group.kill();
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            let stdout = match tokio::time::timeout(Duration::from_secs(1), &mut output).await {
                Ok(Ok(value)) => value,
                _ => {
                    output.abort();
                    group.kill();
                    String::new()
                }
            };
            let stderr = match tokio::time::timeout(Duration::from_secs(1), &mut errors).await {
                Ok(Ok(value)) => value,
                _ => {
                    errors.abort();
                    group.kill();
                    String::new()
                }
            };
            group.armed = false;
            DockerResult {
                code,
                stdout,
                stderr,
            }
        })
    }
}

struct ProcessGroup {
    pid: Option<u32>,
    armed: bool,
}

impl ProcessGroup {
    fn kill(&mut self) {
        if !self.armed {
            return;
        }
        if let Some(pid) = self.pid {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                if let Some(system) = std::env::var_os("SystemRoot") {
                    let _ = std::process::Command::new(
                        PathBuf::from(system).join("System32/taskkill.exe"),
                    )
                    .args(["/pid", &pid.to_string(), "/t", "/f"])
                    .creation_flags(0x0800_0000)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                }
            }
        }
        self.armed = false;
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.kill();
    }
}

async fn read_output(
    mut stream: impl tokio::io::AsyncRead + Unpin,
    on_line: LineListener,
) -> String {
    let mut output = BoundedOutput::default();
    let mut buffer = [0; 4096];
    while let Ok(size) = stream.read(&mut buffer).await {
        if size == 0 {
            break;
        }
        for byte in &buffer[..size] {
            if matches!(byte, b'\n' | b'\r') {
                output.flush(&on_line);
            } else if !output.truncated {
                if output.pending.len() == LINE_BYTES {
                    output.pending.clear();
                    output.truncated = true;
                } else {
                    output.pending.push(*byte);
                }
            }
        }
    }
    output.flush(&on_line);
    output
        .capture
        .into_iter()
        .map(|line| format!("{line}\n"))
        .collect()
}

#[derive(Default)]
struct BoundedOutput {
    capture: VecDeque<String>,
    bytes: usize,
    pending: Vec<u8>,
    truncated: bool,
}

impl BoundedOutput {
    fn flush(&mut self, on_line: &LineListener) {
        if !self.truncated && self.pending.is_empty() {
            return;
        }
        // Never preserve a suffix whose secret prefix was discarded before redaction.
        let line = if self.truncated {
            "[truncated output]".to_owned()
        } else {
            String::from_utf8_lossy(&self.pending).into_owned()
        };
        self.pending.clear();
        self.truncated = false;
        on_line(line.clone());
        let bytes = line.len() + 1;
        while self.bytes + bytes > OUTPUT_BYTES {
            if let Some(oldest) = self.capture.pop_front() {
                self.bytes -= oldest.len() + 1;
            } else {
                break;
            }
        }
        self.bytes += bytes;
        self.capture.push_back(line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    enum Reply {
        Output(DockerResult),
        Healthy,
        UntilCancelled,
        UntilReleased(Arc<tokio::sync::Notify>),
    }

    struct FakeDocker {
        replies: Mutex<VecDeque<Reply>>,
        requests: Mutex<Vec<DockerRequest>>,
        servers: Mutex<Vec<tokio::task::JoinHandle<()>>>,
        blocked: tokio::sync::Notify,
    }

    impl FakeDocker {
        fn new(replies: Vec<Reply>) -> Arc<Self> {
            Arc::new(Self {
                replies: Mutex::new(replies.into()),
                requests: Mutex::new(Vec::new()),
                servers: Mutex::new(Vec::new()),
                blocked: tokio::sync::Notify::new(),
            })
        }
    }

    fn ok(stdout: &str) -> Reply {
        Reply::Output(DockerResult {
            code: 0,
            stdout: stdout.to_owned(),
            stderr: String::new(),
        })
    }

    fn error(stderr: &str) -> Reply {
        Reply::Output(DockerResult {
            code: 1,
            stdout: String::new(),
            stderr: stderr.to_owned(),
        })
    }

    impl DockerRunner for FakeDocker {
        fn run<'a>(
            &'a self,
            request: DockerRequest,
            mut cancel: watch::Receiver<bool>,
            on_line: LineListener,
        ) -> Pin<Box<dyn Future<Output = DockerResult> + Send + 'a>> {
            Box::pin(async move {
                let reply = self
                    .replies
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("An unexpected Docker command was issued");
                self.requests.lock().unwrap().push(request.clone());
                match reply {
                    Reply::Output(result) => {
                        for line in result.stdout.lines().chain(result.stderr.lines()) {
                            on_line(line.to_owned());
                        }
                        result
                    }
                    Reply::UntilCancelled => {
                        self.blocked.notify_one();
                        while !*cancel.borrow() {
                            if cancel.changed().await.is_err() {
                                break;
                            }
                        }
                        DockerResult {
                            code: 130,
                            stdout: String::new(),
                            stderr: String::new(),
                        }
                    }
                    Reply::UntilReleased(release) => {
                        assert_eq!(request.args.last().map(String::as_str), Some("stop"));
                        self.blocked.notify_one();
                        release.notified().await;
                        DockerResult {
                            code: 0,
                            stdout: String::new(),
                            stderr: String::new(),
                        }
                    }
                    Reply::Healthy => {
                        assert!(request.args.iter().any(|arg| arg == "up"));
                        let port = request.environment["ORKBOT_WEB_PORT"]
                            .to_str()
                            .unwrap()
                            .parse::<u16>()
                            .unwrap();
                        let token = request.environment["ORKBOT_DESKTOP_STACK_TOKEN"]
                            .to_str()
                            .unwrap()
                            .to_owned();
                        let owner = request
                            .environment
                            .get("ORKBOT_DESKTOP_ACCOUNT_KEY")
                            .and_then(|value| value.to_str())
                            .map(str::to_owned);
                        let tag = request.environment["ORKBOT_IMAGE_TAG"]
                            .to_str()
                            .unwrap()
                            .to_owned();
                        let listener =
                            tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
                                .await
                                .unwrap();
                        self.servers.lock().unwrap().push(tokio::spawn(async move {
                            let (mut stream, _) = listener.accept().await.unwrap();
                            let request = read_request(&mut stream).await;
                            assert!(request.starts_with("GET /.well-known/orkbot-desktop-stack HTTP/1.1\r\n"));
                            assert!(request.to_lowercase().contains(&format!("x-orkbot-desktop-stack-token: {token}\r\n")));
                            let body = serde_json::json!({"ok": true, "imageTag": tag}).to_string();
                            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                            if let Some(owner) = owner {
                                let (mut stream, _) = listener.accept().await.unwrap();
                                let request = read_request(&mut stream).await;
                                assert!(request.starts_with("GET /api/auth/capabilities HTTP/1.1\r\n"));
                                assert!(request.to_lowercase().contains(&format!("x-orkbot-desktop-stack-token: {token}\r\n")));
                                let body = serde_json::json!({"managedAccountKey": owner}).to_string();
                                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                            }
                        }));
                        DockerResult {
                            code: 0,
                            stdout: String::new(),
                            stderr: String::new(),
                        }
                    }
                }
            })
        }
    }

    async fn read_request(stream: &mut tokio::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut buffer = [0; 1024];
        while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            let read = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut buffer))
                .await
                .unwrap()
                .unwrap();
            assert!(read > 0);
            bytes.extend_from_slice(&buffer[..read]);
            assert!(bytes.len() <= 8192);
        }
        String::from_utf8(bytes).unwrap()
    }

    fn template() -> String {
        format!("{}\nORKBOT_IMAGE=registry.example.com/app\nORKBOT_COMPUTER_IMAGE=registry.example.com/computer\nORKBOT_IMAGE_TAG=stale\nORKBOT_COMPUTER_IMAGE_TAG=stale\n", SECRETS.iter().map(|(name, _)| format!("{name}=")).collect::<Vec<_>>().join("\n"))
    }

    fn fixture(replies: Vec<Reply>) -> (tempfile::TempDir, LocalStack, Arc<FakeDocker>) {
        let root = tempfile::tempdir().unwrap();
        let resources = root.path().join("resources");
        fs::create_dir(&resources).unwrap();
        fs::write(resources.join(COMPOSE_FILE), "services: {}\n").unwrap();
        fs::write(resources.join(ENV_TEMPLATE), template()).unwrap();
        let binary = root.path().join(if cfg!(windows) {
            "docker.exe"
        } else {
            "docker"
        });
        fs::write(&binary, "test process boundary").unwrap();
        let runner = FakeDocker::new(replies);
        let mut stack = LocalStack::new(
            root.path().join("stack"),
            resources,
            "edge".to_owned(),
            None,
            None,
        );
        stack.environment = Environment::from([
            ("ORKBOT_DOCKER_BINARY".to_owned(), binary.into_os_string()),
            (
                "ORK_ACCOUNTS_DESKTOP_CLIENT_ID".to_owned(),
                OsString::from("fake-public-client"),
            ),
        ]);
        stack.runner = runner.clone();
        (root, stack, runner)
    }

    #[test]
    fn workspace_registration_receipt_survives_restart_without_regranting_or_rebinding() {
        let (_root, stack, _) = fixture(vec![]);
        private_directory(&stack.directory).unwrap();
        let organization = "00000000-0000-4000-8000-000000000001";
        let server = "00000000-0000-4000-8000-000000000002";
        let first = stack
            .workspace_operation(organization, server, 1, &"a".repeat(64))
            .unwrap();
        let id = first.operation_id.clone();
        assert!(!first.completed);
        stack.complete_workspace_operation(first).unwrap();
        let restarted = LocalStack::new(
            stack.directory.clone(),
            stack.resources.clone(),
            stack.image_tag.clone(),
            None,
            None,
        );
        let receipt = restarted
            .workspace_operation(organization, server, 1, &"a".repeat(64))
            .unwrap();
        assert_eq!(receipt.operation_id, id);
        assert!(receipt.completed);
        assert!(restarted
            .workspace_operation(organization, server, 2, &"a".repeat(64))
            .is_err());
        assert!(restarted
            .workspace_operation(server, organization, 1, &"a".repeat(64))
            .is_err());
        assert!(restarted
            .workspace_operation(organization, server, 1, &"b".repeat(64))
            .is_err());
        fs::write(
            stack.directory.join(".desktop-workspace-operation"),
            " ".repeat(1025),
        )
        .unwrap();
        assert!(restarted
            .workspace_operation(organization, server, 1, &"a".repeat(64))
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_registration_never_reads_a_link_to_another_installation() {
        let (root, stack, _) = fixture(vec![]);
        private_directory(&stack.directory).unwrap();
        let outside = root.path().join("outside");
        fs::write(&outside, "{}").unwrap();
        std::os::unix::fs::symlink(
            &outside,
            stack.directory.join(".desktop-workspace-operation"),
        )
        .unwrap();
        assert!(stack
            .workspace_operation(
                "00000000-0000-4000-8000-000000000001",
                "00000000-0000-4000-8000-000000000002",
                1,
                &"a".repeat(64)
            )
            .is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "{}");
    }

    #[tokio::test]
    async fn a_retired_start_intent_never_calls_docker_or_creates_an_instance() {
        let (_root, stack, runner) = fixture(vec![]);
        let intent = stack.intent();
        stack.abort();
        assert_eq!(stack.start_for(intent).await.phase, LocalStackPhase::Idle);
        assert!(runner.requests.lock().unwrap().is_empty());
        assert!(!stack.directory.exists());
    }

    #[tokio::test]
    async fn two_scopes_keep_their_own_secrets_ports_projects_and_late_stop_target() {
        use crate::local_stack_scope::AccountStacks;
        let (root, template, runner) = fixture(vec![
            ok("2.24.0"),
            ok("29.0.0"),
            ok(""),
            Reply::Healthy,
            ok("2.24.0"),
            ok("29.0.0"),
            ok(""),
            Reply::Healthy,
            ok(""),
        ]);
        let mut scopes = AccountStacks::new(template);
        let first = scopes
            .select(root.path(), &"a".repeat(64), |_| None, |_| None, || true)
            .unwrap();
        assert_eq!(first.start().await.phase, LocalStackPhase::Ready);
        let original_env = fs::read(first.directory.join(ENV_FILE)).unwrap();
        let original_token = read_token(&first.directory).unwrap();
        let original_port = first.web_url();
        let second = scopes
            .select(root.path(), &"b".repeat(64), |_| None, |_| None, || true)
            .unwrap();
        assert_eq!(second.start().await.phase, LocalStackPhase::Ready);
        assert_ne!(first.directory, second.directory);
        assert_ne!(first.project_name, second.project_name);
        assert_ne!(
            original_env,
            fs::read(second.directory.join(ENV_FILE)).unwrap()
        );
        assert_ne!(original_token, read_token(&second.directory).unwrap());
        assert!(first.matches_saved_url(&original_port.origin().ascii_serialization()));
        assert!(!second.matches_saved_url(&original_port.origin().ascii_serialization()));
        assert_eq!(first.stop().await.phase, LocalStackPhase::Idle);
        assert!(scopes.is_selected(&second));
        assert_eq!(
            fs::read(first.directory.join(ENV_FILE)).unwrap(),
            original_env
        );
        assert_eq!(read_token(&first.directory).unwrap(), original_token);
        let requests = runner.requests.lock().unwrap();
        let stop = requests.last().unwrap();
        assert_eq!(stop.cwd, first.directory);
        let project = stop
            .args
            .iter()
            .position(|arg| arg == "--project-name")
            .unwrap();
        assert_eq!(stop.args[project + 1], first.project_name);
        assert_eq!(stop.args.last().map(String::as_str), Some("stop"));
        assert_eq!(
            stop.environment["ORKBOT_WEB_PORT"],
            OsString::from(original_port.port().unwrap().to_string())
        );
        assert!(requests.iter().all(|request| !request
            .args
            .iter()
            .any(|arg| matches!(arg.as_str(), "down" | "--volumes" | "rm"))));
    }

    #[test]
    fn image_tags_follow_release_versions_and_moving_development_images() {
        let revision = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(
            image_tag("0.7.0", true, Some(revision)),
            format!("sha-{revision}")
        );
        assert_eq!(image_tag("0.7.0", true, None), "v0.7.0");
        assert_eq!(image_tag("0.7.0", false, Some(revision)), "edge");
        for invalid in ["main", "", "0123456789abcdef0123456789abcdef0123456g"] {
            assert_eq!(image_tag("0.7.0", true, Some(invalid)), "v0.7.0");
        }
        for version in ["", "0.7", "0.7.0-beta.1", "v0.7.0", "0.7.0\n", "0..0"] {
            assert_eq!(image_tag(version, true, None), "edge");
        }
    }

    #[tokio::test]
    async fn native_login_needs_no_server_oidc_client_configuration() {
        let (_root, mut stack, runner) =
            fixture(vec![ok("2.24.0"), ok("29.0.0"), ok(""), Reply::Healthy]);
        stack.environment.remove("ORK_ACCOUNTS_DESKTOP_CLIENT_ID");
        assert_eq!(stack.start().await.phase, LocalStackPhase::Ready);
        let requests = runner.requests.lock().unwrap();
        let environment = &requests.last().unwrap().environment;
        assert_eq!(environment["AUTH_ACCOUNTS_ENABLED"], "true");
        assert_eq!(environment["AUTH_PASSWORD_ENABLED"], "false");
        assert!(environment.keys().all(|key| !key.starts_with("OIDC_")));
    }

    #[test]
    fn generated_environment_preserves_explicit_values_and_image_sources() {
        let template = template().replace("ENCRYPTION_KEY=\n", "ENCRYPTION_KEY='keep-this-key'\n");
        let rendered = render_environment(&template, |bytes| Ok("a".repeat(bytes * 2))).unwrap();
        let values = parse_environment(&rendered).unwrap();
        assert_eq!(values["POSTGRES_PASSWORD"], "a".repeat(32));
        assert_eq!(values["BETTER_AUTH_SECRET"], "a".repeat(64));
        assert_eq!(values["ENCRYPTION_KEY"], "keep-this-key");
        assert_eq!(values["ORKBOT_IMAGE"], "registry.example.com/app");
        assert_eq!(
            values["ORKBOT_COMPUTER_IMAGE"],
            "registry.example.com/computer"
        );
        assert!(!values.contains_key("ORKBOT_IMAGE_TAG"));
        assert!(!values.contains_key("ORKBOT_COMPUTER_IMAGE_TAG"));
    }

    #[test]
    fn shipped_environment_templates_parse_with_accounts_names_and_generated_secrets() {
        for template in [
            include_str!("../../../../infra/compose/.env.images.example"),
            include_str!("../../../../.env.example"),
        ] {
            let rendered = render_environment(template, |bytes| Ok("d".repeat(bytes * 2))).unwrap();
            let values = parse_environment(&rendered).unwrap();
            assert_eq!(values["OIDC_NAME"], "Ork Accounts");
            assert_eq!(values["OIDC_ISSUER"], "https://api.ork.run");
            assert_eq!(values["AUTH_PASSWORD_ENABLED"], "false");
            assert_eq!(values["POSTGRES_PASSWORD"], "d".repeat(32));
            assert_eq!(values["POSTGRES_APP_PASSWORD"], "d".repeat(32));
        }
    }

    #[test]
    fn existing_environment_is_preserved_and_invalid_files_are_never_regenerated() {
        let (root, stack, _) = fixture(Vec::new());
        private_directory(&stack.directory).unwrap();
        let original = render_environment(&template(), |bytes| Ok("b".repeat(bytes * 2))).unwrap();
        fs::write(stack.directory.join(ENV_FILE), &original).unwrap();
        ensure_environment(&stack.directory, &stack.resources.join(ENV_TEMPLATE)).unwrap();
        assert_eq!(
            fs::read_to_string(stack.directory.join(ENV_FILE)).unwrap(),
            original
        );
        let broken = "ENCRYPTION_KEY=keep-this-even-when-the-file-is-broken\n";
        fs::write(stack.directory.join(ENV_FILE), broken).unwrap();
        assert!(ensure_environment(&stack.directory, &stack.resources.join(ENV_TEMPLATE)).is_err());
        assert_eq!(
            fs::read_to_string(stack.directory.join(ENV_FILE)).unwrap(),
            broken
        );
        assert!(root.path().join("stack").is_dir());
    }

    #[test]
    fn environment_parser_handles_quoted_multiline_values_and_rejects_empty_secrets() {
        let env = render_environment(&template(), |bytes| Ok("c".repeat(bytes * 2))).unwrap();
        let env = format!("{env}PRIVATE_KEY='first\nPOSTGRES_PASSWORD=not-an-assignment\nlast'\n");
        let parsed = parse_environment(&env).unwrap();
        assert_eq!(parsed["POSTGRES_PASSWORD"], "c".repeat(32));
        assert!(parsed["PRIVATE_KEY"].contains("POSTGRES_PASSWORD=not-an-assignment"));
        assert!(parse_environment(&format!("{env}POSTGRES_PASSWORD=''\n")).is_err());
        assert!(parse_environment(&format!("{env}BROKEN='unterminated\n")).is_err());
    }

    #[test]
    fn private_token_and_web_origin_are_persisted_and_strictly_validated() {
        let directory = tempfile::tempdir().unwrap();
        let token = ensure_token(directory.path()).unwrap();
        assert_eq!(token.len(), 64);
        assert_eq!(ensure_token(directory.path()).unwrap(), token);
        assert_eq!(read_token(directory.path()), Some(token));
        for invalid in [
            "http://localhost:45173",
            "http://127.0.0.1:80",
            "http://127.0.0.1:45173/path",
            "http://127.0.0.1:45173\n",
            "http://127.0.0.1:045173",
            "http://127.0.0.1:65536",
        ] {
            write_private(&directory.path().join(WEB_URL_FILE), invalid.as_bytes()).unwrap();
            assert!(read_web_url(directory.path()).is_none(), "{invalid}");
        }
        write_private(
            &directory.path().join(WEB_URL_FILE),
            b"http://127.0.0.1:45173",
        )
        .unwrap();
        assert_eq!(
            read_web_url(directory.path()).unwrap().as_str(),
            "http://127.0.0.1:45173/"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(
                fs::metadata(directory.path().join(TOKEN_FILE))
                    .unwrap()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn environment_symlink_is_replaced_without_reading_or_overwriting_its_target() {
        use std::os::unix::fs::symlink;
        let (root, stack, _) = fixture(Vec::new());
        private_directory(&stack.directory).unwrap();
        let target = root.path().join("outside.env");
        fs::write(&target, "outside-private-value").unwrap();
        symlink(&target, stack.directory.join(ENV_FILE)).unwrap();
        ensure_environment(&stack.directory, &stack.resources.join(ENV_TEMPLATE)).unwrap();
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "outside-private-value"
        );
        assert!(read_environment(&stack.directory).is_ok());
    }

    #[test]
    fn docker_environment_drops_unrelated_credentials_and_forces_loopback_publishing() {
        let source = Environment::from([
            ("HOME".to_owned(), OsString::from("/example/home")),
            (
                "PATH".to_owned(),
                std::env::join_paths([Path::new("/example/tools")]).unwrap(),
            ),
            (
                "DOCKER_CONTEXT".to_owned(),
                OsString::from("example-context"),
            ),
            (
                "AWS_SECRET_ACCESS_KEY".to_owned(),
                OsString::from("must-not-forward"),
            ),
            ("COMPOSE_FILE".to_owned(), OsString::from("untrusted.yml")),
            (
                "ORKBOT_IMAGE".to_owned(),
                OsString::from("must-not-override-private-env"),
            ),
            ("ORKBOT_WEB_BIND".to_owned(), OsString::from("0.0.0.0")),
            (
                "ORK_ACCOUNTS_DESKTOP_CLIENT_ID".to_owned(),
                OsString::from("fake-public-client"),
            ),
        ]);
        let binary = Path::new("/example/docker");
        let url = Url::parse("http://127.0.0.1:45173").unwrap();
        let env = docker_environment(
            &source,
            binary,
            &url,
            "edge",
            Some("private-stack-token"),
            None,
        );
        for key in ["AWS_SECRET_ACCESS_KEY", "COMPOSE_FILE", "ORKBOT_IMAGE"] {
            assert!(!env.contains_key(key));
        }
        assert_eq!(env["DOCKER_CONTEXT"], "example-context");
        assert_eq!(env["ORKBOT_WEB_BIND"], "127.0.0.1");
        assert_eq!(env["ORKBOT_API_PORT"], "0");
        assert_eq!(env["ORKBOT_DESKTOP_STACK_TOKEN"], "private-stack-token");
        assert_eq!(env["WEB_ORIGIN"], "http://127.0.0.1:45173");
        assert_eq!(env["SANDBOX_HOST_TOKEN"], "");
        assert_eq!(env["AUTH_PASSWORD_ENABLED"], "false");
        assert_eq!(env["MESSAGING_OPEN_SIGNUP"], "false");
        assert_eq!(env["AUTH_ACCOUNTS_ENABLED"], "true");
        assert!(env.keys().all(|key| !key.starts_with("OIDC_")));
    }

    fn host_connection() -> Connection {
        Connection {
            url: "http://host.docker.internal:45001".into(),
            token: "a".repeat(64),
        }
    }

    #[tokio::test]
    async fn host_transport_is_injected_and_its_identity_is_saved_only_after_start() {
        let (_root, mut stack, runner) =
            fixture(vec![ok("2.24.0"), ok("29.0.0"), ok(""), Reply::Healthy]);
        stack.host = Some(host_connection());
        assert!(!stack.matches_host_config());
        assert_eq!(stack.start().await.phase, LocalStackPhase::Ready);
        assert!(stack.matches_host_config());
        let host = stack.host.as_ref().unwrap();
        for request in runner.requests.lock().unwrap().iter() {
            assert_eq!(
                request.environment["SANDBOX_HOST_URL"].to_str().unwrap(),
                host.url
            );
            assert_eq!(
                request.environment["SANDBOX_HOST_TOKEN"].to_str().unwrap(),
                host.token
            );
        }
        let identity = read_private(&stack.directory.join(HOST_CONFIG_FILE), 256).unwrap();
        assert!(!String::from_utf8(identity).unwrap().contains(&host.token));
        stack.host.as_mut().unwrap().token = "b".repeat(64);
        assert!(!stack.matches_host_config());
        stack.host = Some(host_connection());
        stack.host.as_mut().unwrap().url = "http://host.docker.internal:45002".into();
        assert!(!stack.matches_host_config());
        stack.host = None;
        assert!(!stack.matches_host_config());
    }

    #[tokio::test]
    async fn host_credentials_are_redacted_from_docker_output() {
        let host = host_connection();
        let (_root, mut stack, _runner) = fixture(vec![Reply::Output(DockerResult {
            code: 1,
            stdout: format!("stdout {}", host.token),
            stderr: format!("stderr {}", host.token),
        })]);
        stack.host = Some(host);
        stack.phase(LocalStackPhase::Pulling);
        let binary = PathBuf::from(stack.environment["ORKBOT_DOCKER_BINARY"].clone());
        let cancel = stack.begin_operation();
        let result = stack
            .docker(
                &binary,
                vec![],
                Duration::from_secs(1),
                None,
                cancel,
                vec![],
            )
            .await;
        assert_eq!(result.stdout, "stdout [redacted]");
        assert_eq!(result.stderr, "stderr [redacted]");
        assert_eq!(
            stack.state().output,
            vec!["stdout [redacted]", "stderr [redacted]"]
        );
    }

    #[tokio::test]
    async fn native_host_choice_uses_the_existing_private_capability_without_a_session() {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let serving = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = read_request(&mut stream).await;
            let boundary = request.find("\r\n\r\n").unwrap() + 4;
            let length = request[..boundary]
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|value| value.parse::<usize>().ok())
                })
                .unwrap();
            while request.len() < boundary + length {
                let mut buffer = [0; 1024];
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.push_str(std::str::from_utf8(&buffer[..read]).unwrap());
            }
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").await.unwrap();
            request
        });
        save_local_computer_host(&url, "private-fixture-token", "this-mac")
            .await
            .unwrap();
        let request = serving.await.unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        let headers = headers.to_ascii_lowercase();
        assert!(headers.starts_with("post /api/desktop-settings/computer-host http/1.1\r\n"));
        assert!(headers.contains("x-orkbot-local-settings-token: private-fixture-token\r\n"));
        assert!(!headers.contains("authorization:"));
        assert!(!headers.contains("cookie:"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(body).unwrap(),
            serde_json::json!({"computerHost": "this-mac"})
        );
    }

    #[tokio::test]
    async fn native_host_choice_rejects_redirects_errors_and_invalid_or_oversized_bodies() {
        for (status, body, extra) in [
            ("302 Found", "", "Location: http://127.0.0.1:1/private\r\n"),
            ("401 Unauthorized", "{\"ok\":true}", ""),
            ("200 OK", "{\"ok\":false}", ""),
            ("200 OK", "not JSON", ""),
            ("200 OK", &"x".repeat(1025), ""),
        ] {
            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap();
            let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
            let response = format!(
                "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let serving = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_request(&mut stream).await;
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            assert!(
                save_local_computer_host(&url, "private-fixture-token", "this-mac")
                    .await
                    .is_err()
            );
            serving.await.unwrap();
        }
        for origin in [
            "https://example.com",
            "http://localhost:45173",
            "http://192.168.1.2:45173",
        ] {
            assert!(save_local_computer_host(
                &Url::parse(origin).unwrap(),
                "private-fixture-token",
                "docker"
            )
            .await
            .is_err());
        }
    }

    #[test]
    fn an_explicit_missing_or_shell_script_binary_never_falls_back_to_installed_docker() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("does-not-exist");
        assert!(resolve_docker_binary(&Environment::from([(
            "ORKBOT_DOCKER_BINARY".to_owned(),
            missing.into_os_string()
        )]))
        .is_none());
        let script = root.path().join("docker.CMD");
        fs::write(&script, "not an executable").unwrap();
        assert!(resolve_docker_binary(&Environment::from([(
            "ORKBOT_DOCKER_BINARY".to_owned(),
            script.into_os_string()
        )]))
        .is_none());
    }

    #[tokio::test]
    async fn missing_docker_and_stopped_daemon_have_distinct_retryable_states() {
        let (root, mut stack, runner) = fixture(Vec::new());
        stack.environment.insert(
            "ORKBOT_DOCKER_BINARY".into(),
            root.path().join("missing").into_os_string(),
        );
        assert_eq!(stack.start().await.phase, LocalStackPhase::DockerMissing);
        assert!(runner.requests.lock().unwrap().is_empty());

        let (_root, stack, runner) = fixture(vec![
            ok("2.24.0"),
            error("Cannot connect to the Docker daemon"),
        ]);
        assert_eq!(stack.start().await.phase, LocalStackPhase::DockerNotRunning);
        assert_eq!(runner.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn compose_missing_does_not_attempt_to_start_or_install_anything() {
        let (_root, stack, runner) = fixture(vec![error("'compose' is not a docker command")]);
        assert_eq!(stack.start().await.phase, LocalStackPhase::DockerMissing);
        assert_eq!(runner.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn image_access_failure_is_retryable_and_does_not_run_compose_up() {
        let (_root, mut stack, runner) = fixture(vec![
            ok("2.24.0"),
            ok("29.0.0"),
            error("unauthorized: authentication required"),
            ok("registry.example.com/app:edge\nregistry.example.com/computer:edge\n"),
            error("No such image: registry.example.com/computer:edge"),
            ok("2.24.0"),
            ok("29.0.0"),
            error("pull access denied"),
            error("Could not resolve the Compose configuration"),
        ]);
        let phases = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&phases);
        stack.on_change = Some(Arc::new(move |state| {
            captured.lock().unwrap().push(state.phase)
        }));
        for _ in 0..2 {
            let state = stack.start().await;
            assert_eq!(state.phase, LocalStackPhase::Failed);
            assert!(state.message.unwrap().contains("images are unavailable"));
        }
        let requests = runner.requests.lock().unwrap();
        assert_eq!(requests.len(), 9);
        assert!(requests
            .iter()
            .all(|request| !request.args.iter().any(|arg| arg == "up")));
        assert_eq!(
            phases
                .lock()
                .unwrap()
                .iter()
                .filter(|phase| **phase == LocalStackPhase::CheckingDocker)
                .count(),
            2
        );
        assert!(stack.web_url().host_str() == Some("127.0.0.1"));
    }

    #[tokio::test]
    async fn ready_requires_the_owned_health_contract_and_stop_preserves_data() {
        let (_root, stack, runner) = fixture(vec![
            ok("2.24.0"),
            ok("29.0.0"),
            ok("layer Downloading 1.5 MB"),
            Reply::Healthy,
            ok(""),
        ]);
        let state = stack.start().await;
        assert_eq!(state.phase, LocalStackPhase::Ready);
        assert_eq!(state.layer_bytes["layer"], 1_500_000);
        let token = read_token(&stack.directory).unwrap();
        assert!(!state.output.iter().any(|line| line.contains(&token)));
        assert_eq!(stack.stop().await.phase, LocalStackPhase::Idle);
        assert!(stack.directory.join(ENV_FILE).is_file());
        assert_eq!(read_token(&stack.directory).unwrap(), token);
        let requests = runner.requests.lock().unwrap();
        assert_eq!(
            requests[3].args,
            strings(&[
                "compose",
                "--env-file",
                ".env",
                "-f",
                COMPOSE_FILE,
                "--project-name",
                LEGACY_PROJECT_NAME,
                "up",
                "-d",
                "--wait",
                "--wait-timeout",
                "300"
            ])
        );
        assert_eq!(requests[4].args.last().unwrap(), "stop");
        assert!(requests.iter().all(|request| !request
            .args
            .iter()
            .any(|arg| matches!(arg.as_str(), "down" | "--volumes" | "rm"))));
    }

    #[tokio::test]
    async fn stop_cancels_an_inflight_pull_and_serializes_the_stop_command() {
        let (_root, stack, runner) = fixture(vec![
            ok("2.24.0"),
            ok("29.0.0"),
            Reply::UntilCancelled,
            ok(""),
        ]);
        let stack = Arc::new(stack);
        let starting = {
            let stack = Arc::clone(&stack);
            tokio::spawn(async move { stack.start().await })
        };
        tokio::time::timeout(Duration::from_secs(2), runner.blocked.notified())
            .await
            .unwrap();
        assert_eq!(stack.start().await.phase, LocalStackPhase::Pulling);
        assert_eq!(stack.stop().await.phase, LocalStackPhase::Idle);
        assert_ne!(starting.await.unwrap().phase, LocalStackPhase::Ready);
        let requests = runner.requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[3].args.last().unwrap(), "stop");
    }

    #[tokio::test]
    async fn occupied_web_ports_are_reallocated_with_bounded_up_retries() {
        let (_root, stack, runner) = fixture(vec![
            ok("2.16.0"),
            ok("29.0.0"),
            ok(""),
            error("port is already allocated"),
            Reply::Healthy,
        ]);
        assert_eq!(stack.start().await.phase, LocalStackPhase::Ready);
        let requests = runner.requests.lock().unwrap();
        assert_ne!(
            requests[3].environment["ORKBOT_WEB_PORT"],
            requests[4].environment["ORKBOT_WEB_PORT"]
        );
        assert_eq!(
            &requests[4].args[requests[4].args.len() - 2..],
            &["up", "-d"]
        );
    }

    #[tokio::test]
    async fn concurrent_start_never_reports_ready_while_a_ready_server_is_stopping() {
        let release = Arc::new(tokio::sync::Notify::new());
        let (_root, stack, runner) = fixture(vec![
            ok("2.24.0"),
            ok("29.0.0"),
            ok(""),
            Reply::Healthy,
            Reply::UntilReleased(Arc::clone(&release)),
        ]);
        assert_eq!(stack.start().await.phase, LocalStackPhase::Ready);
        let stack = Arc::new(stack);
        let stopping = {
            let stack = Arc::clone(&stack);
            tokio::spawn(async move { stack.stop().await })
        };
        tokio::time::timeout(Duration::from_secs(2), runner.blocked.notified())
            .await
            .unwrap();
        assert_ne!(stack.state().phase, LocalStackPhase::Ready);
        assert_ne!(stack.start().await.phase, LocalStackPhase::Ready);
        assert_eq!(runner.requests.lock().unwrap().len(), 5);
        release.notify_one();
        assert_eq!(stopping.await.unwrap().phase, LocalStackPhase::Idle);
    }

    #[test]
    fn progress_only_increases_per_layer_and_private_values_are_redacted() {
        let mut layers = BTreeMap::new();
        for line in [
            "layer Downloading 1.2MB",
            "layer Downloading 100 kB",
            "other Downloading 3KB",
            "layer Downloading NaN MB",
            "layer Downloaded 5MB",
        ] {
            update_layer_bytes(&mut layers, line);
        }
        assert_eq!(layers["layer"], 1_200_000);
        assert_eq!(layers["other"], 3000);
        let secrets = redactions(
            &BTreeMap::from([
                ("MASTER_KEY_PROVIDER".into(), "local".into()),
                ("SECRET_STORE".into(), "encrypted".into()),
                ("ENCRYPTION_KEY".into(), "private-encryption-value".into()),
                (
                    "PRIVATE_KEY".into(),
                    "first-private-line\nsecond-private-line".into(),
                ),
            ]),
            "private-stack-token",
        );
        assert_eq!(
            redact_line("private-encryption-value private-stack-token", &secrets),
            "[redacted] [redacted]"
        );
        assert_eq!(redact_line("second-private-line", &secrets), "[redacted]");
        assert_eq!(
            redact_line("orkbot/local-app:edge encrypted", &secrets),
            "orkbot/local-app:edge encrypted"
        );
    }

    #[tokio::test]
    async fn cached_development_images_start_after_registry_failures_without_pulling_again() {
        for failure in ["pull access denied", "network is unreachable"] {
            let (_root, stack, runner) = fixture(vec![
                ok("2.24.0"),
                ok("29.0.0"),
                error(failure),
                ok("orkbot/local-app:edge\norkbot/local-computer:edge\npostgres:16\nbusybox:1\n"),
                ok("sha256:app\nsha256:computer\nsha256:postgres\nsha256:busybox\n"),
                Reply::Healthy,
            ]);
            fs::write(
                stack.resources.join(ENV_TEMPLATE),
                format!(
                    "{}\nMASTER_KEY_PROVIDER=local\nSECRET_STORE=encrypted\n",
                    template()
                ),
            )
            .unwrap();
            assert_eq!(stack.start().await.phase, LocalStackPhase::Ready);
            let requests = runner.requests.lock().unwrap();
            assert_eq!(requests.len(), 6);
            assert!(requests[2].args.iter().any(|arg| arg == "pull"));
            assert!(requests[5]
                .args
                .windows(2)
                .any(|args| args == ["--pull", "never"]));
            for image in [
                "orkbot/local-app:edge",
                "orkbot/local-computer:edge",
                "postgres:16",
                "busybox:1",
            ] {
                assert!(requests[4].args.iter().any(|arg| arg == image));
            }
        }
    }

    #[tokio::test]
    async fn cancelling_image_inspection_does_not_start_cached_services() {
        let (_root, stack, runner) = fixture(vec![
            ok("2.24.0"),
            ok("29.0.0"),
            error("pull access denied"),
            ok("registry.example.com/app:edge\n"),
            Reply::UntilCancelled,
        ]);
        let stack = Arc::new(stack);
        let starting = {
            let stack = Arc::clone(&stack);
            tokio::spawn(async move { stack.start().await })
        };
        tokio::time::timeout(Duration::from_secs(2), runner.blocked.notified())
            .await
            .unwrap();
        stack.abort();
        assert_ne!(starting.await.unwrap().phase, LocalStackPhase::Ready);
        let requests = runner.requests.lock().unwrap();
        assert_eq!(requests.len(), 5);
        assert!(requests
            .iter()
            .all(|request| !request.args.iter().any(|arg| arg == "up")));
    }

    #[tokio::test]
    async fn cached_release_images_start_without_a_registry_pull() {
        for tag in ["v0.7.0", "sha-0123456789abcdef0123456789abcdef01234567"] {
            let (_root, mut stack, runner) = fixture(vec![
                ok("2.24.0"),
                ok("29.0.0"),
                ok(&format!("registry.example.com/app:{tag}\nregistry.example.com/computer:{tag}\nregistry.example.com/app:{tag}\n")),
                ok("sha256:app\nsha256:computer\n"),
                Reply::Healthy,
            ]);
            stack.image_tag = tag.to_owned();
            assert_eq!(stack.start().await.phase, LocalStackPhase::Ready);
            let requests = runner.requests.lock().unwrap();
            assert_eq!(requests.len(), 5);
            assert!(requests[4]
                .args
                .windows(2)
                .any(|args| args == ["--pull", "never"]));
            assert!(!requests
                .iter()
                .any(|request| request.args.iter().any(|arg| arg == "pull")));
            assert_eq!(
                requests[3].args,
                strings(&[
                    "image",
                    "inspect",
                    "--format",
                    "{{.Id}}",
                    "--",
                    &format!("registry.example.com/app:{tag}"),
                    &format!("registry.example.com/computer:{tag}"),
                ])
            );
        }
    }

    #[tokio::test]
    async fn managed_account_probe_rejects_missing_or_different_owner_without_sending_accounts_tokens(
    ) {
        let owner = "a".repeat(64);
        for (value, expected) in [
            (serde_json::json!({"managedAccountKey":owner}), true),
            (
                serde_json::json!({"managedAccountKey":"b".repeat(64)}),
                false,
            ),
            (serde_json::json!({"passwordAuth":false}), false),
            (serde_json::Value::Null, false),
        ] {
            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap();
            let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
            let serving = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = read_request(&mut stream).await;
                assert!(request.starts_with("GET /api/auth/capabilities HTTP/1.1\r\n"));
                assert!(request
                    .to_lowercase()
                    .contains("x-orkbot-desktop-stack-token: private-fixture-token\r\n"));
                assert!(!request.to_lowercase().contains("authorization:"));
                let body = value.to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
            assert_eq!(
                probe_managed_account(&url, "private-fixture-token", &owner).await,
                expected
            );
            serving.await.unwrap();
        }
    }

    #[test]
    fn managed_owner_changes_the_recreation_identity_without_changing_legacy_files() {
        let (_root, template, _runner) = fixture(vec![]);
        let first = template.scoped(
            template.directory.join("a"),
            "project-a".into(),
            "a".repeat(64),
            None,
            None,
        );
        let second = template.scoped(
            template.directory.join("b"),
            "project-b".into(),
            "b".repeat(64),
            None,
            None,
        );
        assert_ne!(first.host_config_identity(), second.host_config_identity());
        assert_ne!(
            first.host_config_identity(),
            template.host_config_identity()
        );
    }

    #[tokio::test]
    async fn ownership_probe_rejects_other_versions_redirects_and_nonloopback_origins() {
        for (status, body, extra) in [
            ("200 OK", r#"{"ok":true,"imageTag":"another-version"}"#, ""),
            ("401 Unauthorized", "{}", ""),
            (
                "302 Found",
                "",
                "Location: http://127.0.0.1:1/untrusted\r\n",
            ),
        ] {
            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap();
            let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
            let serving = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_request(&mut stream).await;
                stream.write_all(format!("HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
            assert!(!probe_owned_stack(&url, "private-fixture-token", "edge").await);
            serving.await.unwrap();
        }
        for origin in [
            "https://example.com",
            "http://192.168.1.2:45173",
            "http://localhost:45173",
        ] {
            assert!(
                !probe_owned_stack(
                    &Url::parse(origin).unwrap(),
                    "private-fixture-token",
                    "edge"
                )
                .await
            );
        }
    }

    #[test]
    fn subprocess_fixture() {
        match std::env::var("ORKBOT_STACK_PROCESS_FIXTURE").as_deref() {
            Ok("output") => {
                std::io::stdout().write_all(b"first\rsecond\n").unwrap();
                std::io::stderr().write_all(b"diagnostic\n").unwrap();
            }
            Ok("block") => {
                std::io::stdout().write_all(b"ready\n").unwrap();
                std::io::stdout().flush().unwrap();
                std::thread::sleep(Duration::from_secs(10));
            }
            _ => {}
        }
    }

    fn process_fixture(directory: &Path, mode: &str, timeout: Duration) -> DockerRequest {
        let mut environment =
            Environment::from([("ORKBOT_STACK_PROCESS_FIXTURE".into(), OsString::from(mode))]);
        if let Some(system) = std::env::var_os("SystemRoot") {
            environment.insert("SystemRoot".into(), system);
        }
        DockerRequest {
            binary: std::env::current_exe().unwrap(),
            args: strings(&[
                "local_stack::tests::subprocess_fixture",
                "--exact",
                "--nocapture",
            ]),
            cwd: directory.to_path_buf(),
            environment,
            timeout,
        }
    }

    #[tokio::test]
    async fn native_runner_reads_both_streams_without_a_shell() {
        let directory = tempfile::tempdir().unwrap();
        let (_sender, cancel) = watch::channel(false);
        let lines = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&lines);
        let result = SystemDocker
            .run(
                process_fixture(directory.path(), "output", Duration::from_secs(5)),
                cancel,
                Arc::new(move |line| captured.lock().unwrap().push(line)),
            )
            .await;
        assert_eq!(result.code, 0);
        assert!(result.stdout.contains("first\nsecond\n"));
        assert!(result.stderr.contains("diagnostic"));
        for expected in ["first", "second", "diagnostic"] {
            assert!(lines.lock().unwrap().iter().any(|line| line == expected));
        }
    }

    #[tokio::test]
    async fn overlong_lines_are_discarded_whole_before_secret_redaction() {
        let secret = "0123456789abcdef".repeat(4);
        let input = format!(
            "{secret}{}\n{secret}\r{}{}",
            "x".repeat(4090),
            "y".repeat(LINE_BYTES),
            secret
        );
        let secrets = vec![secret.clone()];
        let lines = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&lines);
        let output_secrets = secrets.clone();
        let capture = read_output(
            input.as_bytes(),
            Arc::new(move |line| {
                captured
                    .lock()
                    .unwrap()
                    .push(redact_line(&line, &output_secrets))
            }),
        )
        .await;
        assert_eq!(
            *lines.lock().unwrap(),
            vec!["[truncated output]", "[redacted]", "[truncated output]"]
        );
        assert_eq!(
            redact_text(&capture, &secrets),
            "[truncated output]\n[redacted]\n[truncated output]\n"
        );
        assert!(!lines
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains(&secret[16..])));
    }

    #[tokio::test]
    async fn bounded_capture_discards_whole_lines_instead_of_secret_prefixes() {
        let secret = "0123456789abcdef".repeat(4);
        let input = (0..30)
            .map(|index| {
                let prefix = format!("line-{index:02}:{secret}");
                format!("{prefix}{}\n", "x".repeat(LINE_BYTES - prefix.len()))
            })
            .collect::<String>();
        let capture = read_output(input.as_bytes(), Arc::new(|_| {})).await;
        assert!(capture.len() <= OUTPUT_BYTES);
        assert!(capture
            .lines()
            .all(|line| line.starts_with("line-") && line.len() == LINE_BYTES));
        let redacted = redact_text(&capture, std::slice::from_ref(&secret));
        assert!(!redacted.contains(&secret));
        assert!(!redacted.contains(&secret[16..]));
    }

    #[tokio::test]
    async fn controller_redacts_captured_stdout_stderr_and_visible_output() {
        let secret = "private-fixture-secret";
        let (_root, stack, runner) = fixture(vec![Reply::Output(DockerResult {
            code: 1,
            stdout: format!("stdout {secret}"),
            stderr: format!("stderr {secret}"),
        })]);
        stack.phase(LocalStackPhase::Pulling);
        let cancel = stack.begin_operation();
        let binary = PathBuf::from(stack.environment["ORKBOT_DOCKER_BINARY"].clone());
        let result = stack
            .docker(
                &binary,
                strings(&["info"]),
                Duration::from_secs(1),
                Some(secret),
                cancel,
                vec![secret.to_owned()],
            )
            .await;
        stack.end_operation();
        assert_eq!(result.stdout, "stdout [redacted]");
        assert_eq!(result.stderr, "stderr [redacted]");
        assert!(stack
            .state()
            .output
            .iter()
            .all(|line| !line.contains(secret)));
        assert_eq!(runner.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn native_runner_terminates_its_process_on_timeout_and_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let (_sender, cancel) = watch::channel(false);
        let began = Instant::now();
        let result = SystemDocker
            .run(
                process_fixture(directory.path(), "block", Duration::from_millis(100)),
                cancel,
                Arc::new(|_| {}),
            )
            .await;
        assert_eq!(result.code, 124);
        assert!(began.elapsed() < Duration::from_secs(5));

        let (sender, cancel) = watch::channel(false);
        let output = Arc::new(tokio::sync::Notify::new());
        let observed = Arc::clone(&output);
        let command = process_fixture(directory.path(), "block", Duration::from_secs(10));
        let running = tokio::spawn(async move {
            SystemDocker
                .run(
                    command,
                    cancel,
                    Arc::new(move |line| {
                        if line == "ready" {
                            observed.notify_one();
                        }
                    }),
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), output.notified())
            .await
            .unwrap();
        sender.send_replace(true);
        assert_eq!(running.await.unwrap().code, 130);
    }
}
