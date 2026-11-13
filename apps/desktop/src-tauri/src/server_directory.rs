// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{fs, io::Read, path::Path, time::Duration};

use reqwest::{Client, Method, Response, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use url::Url;

use crate::server::normalize_server_url;

const API: &str = "https://api.ork.run/api/servers";
const ERROR: &str = "Could not update your servers. Try again.";
const MAX_BODY: usize = 1024 * 1024;
const DEVICE_FILE: &str = "directory-device-id";

pub fn origin() -> Url {
    Url::parse("https://api.ork.run").expect("The Accounts directory origin is fixed")
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<WorkspaceTarget>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceTarget {
    pub organization_id: String,
    pub server_id: String,
    pub workspace_id: String,
    pub binding_version: u64,
    pub key_fingerprint: String,
}

impl WorkspaceTarget {
    pub fn validate(&self) -> Result<(), String> {
        if !uuid(&self.organization_id)
            || !uuid(&self.server_id)
            || !uuid(&self.workspace_id)
            || self.binding_version == 0
            || self.binding_version > 9_007_199_254_740_991
            || self.key_fingerprint.len() != 64
            || !self
                .key_fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ERROR.into());
        }
        Ok(())
    }
}

impl Workspace {
    fn validate(&self) -> Result<(), String> {
        let url = normalize_server_url(&self.url)?;
        if !uuid(&self.id)
            || self.name.trim() != self.name
            || self.name.is_empty()
            || self.name.chars().count() > if self.target.is_some() { 310 } else { 100 }
            || self.name.chars().any(char::is_control)
            || !(url.scheme() == "https"
                || (self.target.is_some()
                    && url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))))
            || self.url != url.origin().ascii_serialization()
        {
            return Err(ERROR.into());
        }
        if let Some(target) = &self.target {
            target.validate()?;
            if target.workspace_id != self.id {
                return Err(ERROR.into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCatalog {
    version: u64,
    default_organization_id: Option<String>,
    organizations: Vec<CatalogOrganization>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CatalogOrganization {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    role: String,
    servers: Vec<CatalogServer>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogServer {
    id: String,
    name: String,
    binding_version: u64,
    key_fingerprint: Option<String>,
    state: String,
    routes: Vec<CatalogRoute>,
    workspaces: Vec<CatalogWorkspace>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogRoute {
    id: String,
    kind: String,
    address: String,
    device_id: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogWorkspace {
    id: String,
    name: String,
    state: String,
    can_open: bool,
    role: Option<String>,
}

impl WorkspaceCatalog {
    pub fn relay_origin(
        &self,
        target: &WorkspaceTarget,
        origin: &Url,
    ) -> Result<Option<String>, String> {
        target.validate()?;
        let server = self
            .organizations
            .iter()
            .find(|row| row.id == target.organization_id)
            .and_then(|organization| {
                organization
                    .servers
                    .iter()
                    .find(|row| row.id == target.server_id)
            })
            .ok_or(ERROR)?;
        if server.state != "ready"
            || server.binding_version != target.binding_version
            || server.key_fingerprint.as_deref() != Some(&target.key_fingerprint)
            || !server
                .workspaces
                .iter()
                .any(|row| row.id == target.workspace_id && row.state == "ready" && row.can_open)
        {
            return Err(ERROR.into());
        }
        if origin.as_str().trim_end_matches('/')
            != format!("https://{}.installation.ork.invalid", target.server_id)
        {
            return Ok(None);
        }
        let route = server
            .routes
            .iter()
            .find(|row| row.kind == "tunnel" && row.device_id.is_none())
            .ok_or(ERROR)?;
        let parsed = normalize_server_url(&route.address)?;
        if parsed.scheme() != "https"
            || parsed.origin() == self::origin().origin()
            || parsed.origin().ascii_serialization() != route.address
            || !uuid(&route.id)
        {
            return Err(ERROR.into());
        }
        Ok(Some(route.address.clone()))
    }

    pub fn local_installation_routes(
        &self,
        target: &WorkspaceTarget,
        origin: &Url,
        device_id: &str,
    ) -> Result<Vec<serde_json::Value>, String> {
        target.validate()?;
        if !uuid(device_id) || !matches!(origin.host_str(), Some("127.0.0.1" | "[::1]")) {
            return Err(ERROR.into());
        }
        let server = self
            .organizations
            .iter()
            .find(|row| row.id == target.organization_id)
            .and_then(|row| {
                row.servers
                    .iter()
                    .find(|server| server.id == target.server_id)
            })
            .ok_or(ERROR)?;
        if server.state != "ready"
            || server.binding_version != target.binding_version
            || server.key_fingerprint.as_deref() != Some(&target.key_fingerprint)
            || !server
                .workspaces
                .iter()
                .any(|row| row.id == target.workspace_id)
        {
            return Err(ERROR.into());
        }
        let mut routes: Vec<_> = server.routes.iter()
            .filter(|row| !(row.kind == "local" && row.device_id.as_deref() == Some(device_id)))
            .map(|row| serde_json::json!({ "kind": row.kind, "address": row.address, "deviceId": row.device_id })).collect();
        routes.push(serde_json::json!({ "kind": "local", "address": origin.origin().ascii_serialization(), "deviceId": device_id }));
        if routes.len() > 8 {
            return Err(ERROR.into());
        }
        Ok(routes)
    }

    fn for_device(mut self, device_id: Option<&str>) -> Self {
        for organization in &mut self.organizations {
            for server in &mut organization.servers {
                server.routes.retain(|route| {
                    route.kind != "local"
                        || device_id.is_some_and(|id| route.device_id.as_deref() == Some(id))
                });
            }
        }
        self
    }

    pub fn local_organization(&self, selected: Option<&str>) -> Result<String, String> {
        let id = selected.or(self.default_organization_id.as_deref());
        let organization = self
            .organizations
            .iter()
            .find(|row| Some(row.id.as_str()) == id)
            .or_else(|| {
                (id.is_none() && self.organizations.len() == 1).then(|| &self.organizations[0])
            });
        let organization = organization.ok_or("Choose organization")?;
        if !matches!(organization.role.as_str(), "admin" | "manager") {
            return Err("Workspace unavailable".into());
        }
        Ok(organization.id.clone())
    }

    pub fn has_organizations(&self) -> bool {
        !self.organizations.is_empty()
    }

    pub fn discovery_servers(&self) -> Result<Vec<Server>, String> {
        let mut seen = std::collections::HashSet::new();
        Ok(self
            .clone()
            .workspaces()?
            .into_iter()
            .filter_map(|workspace| {
                let target = workspace.target?;
                seen.insert(target.server_id.clone()).then_some(Server {
                    id: target.server_id,
                    url: workspace.url,
                    kind: Kind::Selfhosted,
                    device_id: None,
                })
            })
            .collect())
    }

    pub fn initial_workspace(
        &self,
        directory: &Path,
        identity: (&str, &str),
    ) -> Result<Option<Workspace>, String> {
        let organization = self
            .organizations
            .iter()
            .find(|row| Some(&row.id) == self.default_organization_id.as_ref())
            .or_else(|| (self.organizations.len() == 1).then(|| &self.organizations[0]));
        let Some(organization) = organization else {
            return Ok(None);
        };
        let previous = workspace_history(directory, identity, &organization.id)?;
        let choices: Vec<_> = organization
            .servers
            .iter()
            .flat_map(|server| {
                server
                    .workspaces
                    .iter()
                    .filter(|workspace| workspace.can_open)
                    .map(move |workspace| (server, workspace))
            })
            .collect();
        let choice = choices
            .iter()
            .find(|(server, workspace)| {
                previous.as_ref().is_some_and(|prior| {
                    prior.server_id == server.id && prior.workspace_id == workspace.id
                })
            })
            .or_else(|| (choices.len() == 1).then(|| &choices[0]));
        let Some((server, workspace)) = choice else {
            return Ok(None);
        };
        self.clone()
            .workspaces()?
            .into_iter()
            .find(|row| {
                row.id == workspace.id
                    && row
                        .target
                        .as_ref()
                        .is_some_and(|target| target.server_id == server.id)
            })
            .map(Some)
            .ok_or_else(|| "Server unavailable. Try again or choose a workspace.".into())
    }

    fn workspaces(self) -> Result<Vec<Workspace>, String> {
        if self.version != 2
            || self
                .default_organization_id
                .as_deref()
                .is_some_and(|id| !uuid(id))
            || self.organizations.len() > 1000
        {
            return Err(ERROR.into());
        }
        let mut result = Vec::new();
        let mut ids = std::collections::HashSet::new();
        for organization in self.organizations {
            if !uuid(&organization.id)
                || !["personal", "shared"].contains(&organization.kind.as_str())
                || !["admin", "manager", "member"].contains(&organization.role.as_str())
            {
                return Err(ERROR.into());
            }
            for server in organization.servers {
                if !uuid(&server.id) || server.binding_version == 0 {
                    return Err(ERROR.into());
                }
                let route = server
                    .routes
                    .iter()
                    .find(|route| route.kind == "local" && route.device_id.is_some())
                    .or_else(|| {
                        server
                            .routes
                            .iter()
                            .find(|route| route.kind == "direct" && route.device_id.is_none())
                    })
                    .or_else(|| {
                        server
                            .routes
                            .iter()
                            .find(|route| route.kind == "tunnel" && route.device_id.is_none())
                    });
                if server.state != "ready" {
                    continue;
                }
                let Some(route) = route else {
                    continue;
                };
                if !uuid(&route.id) {
                    return Err(ERROR.into());
                }
                let route_url = normalize_server_url(&route.address)?;
                if (route.kind == "local"
                    && !matches!(route_url.host_str(), Some("127.0.0.1" | "[::1]")))
                    || (route.kind == "tunnel"
                        && (route_url.scheme() != "https"
                            || route_url.origin() == origin().origin()))
                    || (route.kind == "direct"
                        && (route_url.scheme() != "https"
                            || route_url.host_str().is_some_and(|host| {
                                host == "localhost"
                                    || host.ends_with(".localhost")
                                    || host
                                        .trim_matches(['[', ']'])
                                        .parse::<std::net::IpAddr>()
                                        .is_ok_and(|ip| ip.is_loopback())
                            })))
                {
                    return Err(ERROR.into());
                }
                for workspace in server.workspaces {
                    if !workspace.can_open || workspace.state != "ready" {
                        continue;
                    }
                    if !matches!(workspace.role.as_deref(), Some("admin" | "member")) {
                        return Err(ERROR.into());
                    }
                    let entry = Workspace {
                        id: workspace.id.clone(),
                        name: format!(
                            "{} / {} / {}",
                            organization.name, server.name, workspace.name
                        ),
                        url: if route.kind == "tunnel" {
                            format!("https://{}.installation.ork.invalid", server.id)
                        } else {
                            route.address.clone()
                        },
                        target: Some(WorkspaceTarget {
                            organization_id: organization.id.clone(),
                            server_id: server.id.clone(),
                            workspace_id: workspace.id,
                            binding_version: server.binding_version,
                            key_fingerprint: server.key_fingerprint.clone().ok_or(ERROR)?,
                        }),
                    };
                    entry.validate()?;
                    if !ids.insert(entry.id.clone()) || result.len() >= 10_000 {
                        return Err(ERROR.into());
                    }
                    result.push(entry);
                }
            }
        }
        Ok(result)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preference {
    pub server_id: Option<String>,
}

fn preference_path(directory: &Path, identity: (&str, &str)) -> std::path::PathBuf {
    directory.join(format!(
        "default-server-{}.json",
        crate::settings::account_key(identity)
    ))
}

/// Default choices belong to an Accounts identity on this device; they contain no credentials.
fn local_choice<T: DeserializeOwned>(
    directory: &Path,
    path: &Path,
    max_bytes: u64,
) -> Result<Option<T>, String> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.is_dir() && !reparse_point(&metadata) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        _ => return Err(ERROR.into()),
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        _ => return Err(ERROR.into()),
    };
    if !metadata.is_file() || reparse_point(&metadata) || metadata.len() > max_bytes {
        return Err(ERROR.into());
    }
    let mut options = fs::OpenOptions::new();
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
    let file = options.open(path).map_err(|_| ERROR)?;
    let after = file.metadata().map_err(|_| ERROR)?;
    if !after.is_file() || reparse_point(&after) || after.len() > max_bytes {
        return Err(ERROR.into());
    }
    let mut contents = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut contents)
        .map_err(|_| ERROR)?;
    if contents.len() as u64 > max_bytes {
        return Err(ERROR.into());
    }
    serde_json::from_slice(&contents)
        .map(Some)
        .map_err(|_| ERROR.into())
}

pub fn preference(directory: &Path, identity: (&str, &str)) -> Result<Option<Preference>, String> {
    let Some(preference) =
        local_choice::<Preference>(directory, &preference_path(directory, identity), 256)?
    else {
        return Ok(None);
    };
    if preference.server_id.as_deref().is_some_and(|id| !uuid(id)) {
        return Err(ERROR.into());
    }
    Ok(Some(preference))
}

fn workspace_history_path(
    directory: &Path,
    identity: (&str, &str),
    organization_id: &str,
) -> std::path::PathBuf {
    directory.join(format!(
        "workspace-history-{}-{organization_id}.json",
        crate::settings::account_key(identity)
    ))
}

pub fn workspace_history(
    directory: &Path,
    identity: (&str, &str),
    organization_id: &str,
) -> Result<Option<WorkspaceTarget>, String> {
    if !uuid(organization_id) {
        return Err(ERROR.into());
    }
    let target = local_choice::<WorkspaceTarget>(
        directory,
        &workspace_history_path(directory, identity, organization_id),
        1024,
    )?;
    if let Some(target) = &target {
        target.validate()?;
        if target.organization_id != organization_id {
            return Err(ERROR.into());
        }
    }
    Ok(target)
}

pub fn remember_workspace(
    directory: &Path,
    identity: (&str, &str),
    target: &WorkspaceTarget,
) -> Result<(), String> {
    target.validate()?;
    device_id(directory)?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|_| ERROR)?;
    serde_json::to_writer(&mut file, target).map_err(|_| ERROR)?;
    file.as_file().sync_all().map_err(|_| ERROR)?;
    file.persist(workspace_history_path(
        directory,
        identity,
        &target.organization_id,
    ))
    .map_err(|_| ERROR)?;
    Ok(())
}

pub fn save_preference(
    directory: &Path,
    identity: (&str, &str),
    server_id: Option<&str>,
) -> Result<(), String> {
    if server_id.is_some_and(|id| !uuid(id)) {
        return Err(ERROR.into());
    }
    // This also creates and validates the private application directory.
    device_id(directory)?;
    let value = Preference {
        server_id: server_id.map(str::to_owned),
    };
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|_| ERROR)?;
    serde_json::to_writer(&mut file, &value).map_err(|_| ERROR)?;
    file.as_file().sync_all().map_err(|_| ERROR)?;
    file.persist(preference_path(directory, identity))
        .map_err(|_| ERROR)?;
    Ok(())
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallationCode {
    id: String,
    url: Option<String>,
    code: String,
    expires_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationCommand {
    id: String,
    command: String,
    expires_at: String,
    url: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum InstallationPhase {
    Waiting,
    Preparing,
    Pulling,
    Starting,
    WaitingHealthy,
    Ready,
    Failed,
    Expired,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallationStatus {
    id: String,
    url: Option<String>,
    phase: InstallationPhase,
    expires_at: String,
}

impl InstallationStatus {
    fn validate(&self, expected: &str) -> Result<(), String> {
        if self.id != expected || !uuid(&self.id) || self.expires_at.len() > 64 {
            return Err(ERROR.into());
        }
        time::OffsetDateTime::parse(
            &self.expires_at,
            &time::format_description::well_known::Rfc3339,
        )
        .map_err(|_| ERROR)?;
        if let Some(raw) = &self.url {
            let url = normalize_server_url(raw)?;
            if !installation_origin(&url) || *raw != url.origin().ascii_serialization() {
                return Err(ERROR.into());
            }
        } else if self.phase == InstallationPhase::Ready {
            return Err(ERROR.into());
        }
        Ok(())
    }
}

fn installation_origin(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && matches!(url.host(), Some(url::Host::Domain(host)) if host.len() <= 253
        && host.contains('.') && host.split('.').all(|label| {
            !label.is_empty() && label.len() <= 63
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        }))
}

fn installation_command(
    value: InstallationCode,
    revision: &str,
) -> Result<InstallationCommand, String> {
    let expires = time::OffsetDateTime::parse(
        &value.expires_at,
        &time::format_description::well_known::Rfc3339,
    )
    .map_err(|_| ERROR)?;
    if !uuid(&value.id)
        || value.url.is_some()
        || value.code.len() != 43
        || !value
            .code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        || value.expires_at.len() > 64
        || expires <= time::OffsetDateTime::now_utc()
        || revision.len() != 40
        || !revision
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ERROR.into());
    }
    // Every interpolated field is validated before the shell command is constructed.
    let command = format!(
        "curl -fsSL https://install.ork.run | sudo -H sh -s -- --revision '{revision}' --code '{}'",
        value.code
    );
    Ok(InstallationCommand {
        id: value.id,
        command,
        expires_at: value.expires_at,
        url: value.url,
    })
}

impl Directory {
    #[cfg(test)]
    pub(crate) fn for_test(endpoint: Url) -> Self {
        Self {
            endpoint,
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
        }
    }
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

    pub async fn catalog(&self, token: &str) -> Result<WorkspaceCatalog, String> {
        let endpoint = self
            .endpoint
            .join("/api/identity/v2/catalog")
            .map_err(|_| ERROR)?;
        let catalog: WorkspaceCatalog =
            json(self.send(Method::GET, endpoint, token, None).await?).await?;
        catalog.clone().for_device(None).workspaces()?;
        Ok(catalog)
    }

    pub async fn catalog_for_device(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<WorkspaceCatalog, String> {
        if !uuid(device_id) {
            return Err(ERROR.into());
        }
        let catalog = self.catalog(token).await?.for_device(Some(device_id));
        catalog.clone().workspaces()?;
        Ok(catalog)
    }

    pub async fn identity_request<T: DeserializeOwned>(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: serde_json::Value,
    ) -> Result<T, String> {
        if !path.starts_with("/api/identity/v2/") {
            return Err(ERROR.into());
        }
        let endpoint = self.endpoint.join(path).map_err(|_| ERROR)?;
        json(self.send(method, endpoint, token, Some(body)).await?).await
    }

    pub async fn set_default_organization(
        &self,
        token: &str,
        organization_id: Option<&str>,
    ) -> Result<(), String> {
        if organization_id.is_some_and(|id| !uuid(id)) {
            return Err(ERROR.into());
        }
        let endpoint = self
            .endpoint
            .join("/api/organizations/preferences")
            .map_err(|_| ERROR)?;
        let value: serde_json::Value = json(
            self.send(
                Method::PATCH,
                endpoint,
                token,
                Some(serde_json::json!({ "defaultOrganizationId": organization_id })),
            )
            .await?,
        )
        .await?;
        if value.get("defaultOrganizationId") != Some(&serde_json::json!(organization_id)) {
            return Err(ERROR.into());
        }
        Ok(())
    }

    #[cfg(test)]
    pub async fn workspaces(&self, token: &str) -> Result<Vec<Workspace>, String> {
        self.catalog(token).await?.workspaces()
    }

    pub async fn workspaces_for_device(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<Vec<Workspace>, String> {
        self.catalog_for_device(token, device_id)
            .await?
            .workspaces()
    }

    pub async fn create_installation(&self, token: &str) -> Result<InstallationCommand, String> {
        let revision = option_env!("ORKBOT_INSTALLER_REVISION")
            .ok_or("This app build cannot prepare a server installer.")?;
        let endpoint = self
            .endpoint
            .join("/api/installations")
            .map_err(|_| ERROR)?;
        let code: InstallationCode = json(
            self.send(Method::POST, endpoint, token, Some(serde_json::json!({})))
                .await?,
        )
        .await?;
        installation_command(code, revision)
    }

    pub async fn installation_status(
        &self,
        token: &str,
        id: &str,
    ) -> Result<InstallationStatus, String> {
        if !uuid(id) {
            return Err(ERROR.into());
        }
        let mut endpoint = self
            .endpoint
            .join("/api/installations")
            .map_err(|_| ERROR)?;
        endpoint.path_segments_mut().map_err(|_| ERROR)?.push(id);
        let status: InstallationStatus =
            json(self.send(Method::GET, endpoint, token, None).await?).await?;
        status.validate(id)?;
        Ok(status)
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

pub(crate) fn uuid(value: &str) -> bool {
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

    const INSTALL_URL: &str = "https://server.example.com";
    const INSTALL_CODE: &str = "AbCdEf0123456789_-AbCdEf0123456789_-AbCdEf0";
    const INSTALL_REVISION: &str = "0123456789abcdef0123456789abcdef01234567";
    const INSTALL_EXPIRY: &str = "2999-01-01T00:00:00Z";
    const CENTRAL_BEARER: &str = "private-fixture-central-bearer";

    fn installation() -> InstallationCode {
        InstallationCode {
            id: DEVICE.into(),
            url: None,
            code: INSTALL_CODE.into(),
            expires_at: INSTALL_EXPIRY.into(),
        }
    }

    fn installation_body() -> serde_json::Value {
        serde_json::json!({ "id": DEVICE, "url": null, "code": INSTALL_CODE, "expiresAt": INSTALL_EXPIRY })
    }

    fn status_body() -> serde_json::Value {
        serde_json::json!({ "id": DEVICE, "url": null, "phase": "waiting", "expiresAt": INSTALL_EXPIRY })
    }

    #[test]
    fn installation_command_binds_only_the_one_time_code_expiry_and_pinned_revision() {
        let result = installation_command(installation(), INSTALL_REVISION).unwrap();
        assert_eq!(result.id, DEVICE);
        assert!(result.url.is_none());
        assert_eq!(result.expires_at, INSTALL_EXPIRY);
        assert!(result.command.contains(&format!("--code '{INSTALL_CODE}'")));
        assert!(!result.command.contains("--url"));
        assert!(!result.command.contains(INSTALL_URL));
        assert!(result
            .command
            .starts_with("curl -fsSL https://install.ork.run | sudo -H sh -s -- "));
        assert!(result
            .command
            .contains(&format!("--revision '{INSTALL_REVISION}'")));
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains(CENTRAL_BEARER));
        let mut value = installation();
        value.url = Some(INSTALL_URL.into());
        assert!(installation_command(value, INSTALL_REVISION).is_err());
        for id in ["", "../another", "11111111-1111-4111-8111-11111111111'"] {
            let mut value = installation();
            value.id = id.into();
            assert!(installation_command(value, INSTALL_REVISION).is_err());
        }
        for code in [
            String::new(),
            "A".repeat(42),
            "A".repeat(44),
            format!("{}'", "A".repeat(42)),
            format!("{}\n", "A".repeat(42)),
            format!("{}$(id)", "A".repeat(38)),
            format!("{}é", "A".repeat(41)),
        ] {
            let mut value = installation();
            value.code = code;
            assert!(installation_command(value, INSTALL_REVISION).is_err());
        }
        for revision in [
            "main",
            "",
            "0123456789abcdef0123456789abcdef0123456'",
            "0123456789abcdef0123456789abcdef0123456g",
            "0123456789ABCDEF0123456789ABCDEF01234567",
        ] {
            assert!(installation_command(installation(), revision).is_err());
        }
        for expiry in [
            "",
            "invalid",
            "2000-01-01T00:00:00Z",
            "2999-01-01T00:00:00Z\n'$(echo invalid)",
        ] {
            let mut value = installation();
            value.expires_at = expiry.into();
            assert!(installation_command(value, INSTALL_REVISION).is_err());
        }
    }

    #[tokio::test]
    async fn installation_creation_posts_no_domain_and_keeps_the_accounts_bearer_native() {
        assert_eq!(Directory::new().unwrap().endpoint.as_str(), API);
        let (directory, wire) = response("200 OK", installation_body().to_string(), "").await;
        let result = directory.create_installation(CENTRAL_BEARER).await.unwrap();
        let request = wire.await.unwrap();
        assert!(request.starts_with("POST /api/installations HTTP/1.1\r\n"));
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(headers
            .lines()
            .any(|line| line
                .eq_ignore_ascii_case(&format!("authorization: bearer {CENTRAL_BEARER}"))));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(body).unwrap(),
            serde_json::json!({})
        );
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains(CENTRAL_BEARER));
        assert!(serialized.contains(INSTALL_CODE));
    }

    #[tokio::test]
    async fn installation_polling_reads_only_the_selected_pairing_and_exposes_no_tokens() {
        for phase in [
            "waiting",
            "preparing",
            "pulling",
            "starting",
            "waiting-healthy",
            "ready",
            "failed",
            "expired",
        ] {
            let mut body = status_body();
            body["phase"] = serde_json::json!(phase);
            if phase == "ready" {
                body["url"] = serde_json::json!(INSTALL_URL);
            }
            if matches!(phase, "ready" | "failed" | "expired") {
                body["expiresAt"] = serde_json::json!("2000-01-01T00:00:00Z");
            }
            let (directory, wire) = response("200 OK", body.to_string(), "").await;
            let status = directory
                .installation_status(CENTRAL_BEARER, DEVICE)
                .await
                .unwrap();
            let request = wire.await.unwrap();
            assert!(request.starts_with(&format!("GET /api/installations/{DEVICE} HTTP/1.1\r\n")));
            let (headers, body) = request.split_once("\r\n\r\n").unwrap();
            assert!(headers.lines().any(|line| line
                .eq_ignore_ascii_case(&format!("authorization: bearer {CENTRAL_BEARER}"))));
            assert!(body.is_empty());
            let serialized = serde_json::to_string(&status).unwrap();
            assert!(!serialized.contains(CENTRAL_BEARER));
            assert!(!serialized.contains(INSTALL_CODE));
        }
    }

    #[tokio::test]
    async fn installation_requests_never_follow_redirects_with_the_native_bearer() {
        for polling in [false, true] {
            let destination = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let location = format!(
                "Location: http://{}/capture\r\n",
                destination.local_addr().unwrap()
            );
            let (mut directory, wire) =
                response("307 Temporary Redirect", String::new(), &location).await;
            directory.client = Directory::new().unwrap().client;
            let result = if polling {
                directory
                    .installation_status(CENTRAL_BEARER, DEVICE)
                    .await
                    .map(|_| ())
            } else {
                directory
                    .create_installation(CENTRAL_BEARER)
                    .await
                    .map(|_| ())
            };
            assert!(result.is_err());
            wire.await.unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(50), destination.accept())
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn installation_polling_rejects_malformed_ids_before_sending_credentials() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut directory = Directory::new().unwrap();
        directory.endpoint = Url::parse(&format!(
            "http://{}/api/servers",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        for id in [
            "",
            "../other",
            "https://different.example.test",
            "11111111-1111-4111-8111-11111111111'",
        ] {
            assert!(directory
                .installation_status(CENTRAL_BEARER, id)
                .await
                .is_err());
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn installation_creation_rejects_malformed_codes_and_unbounded_responses() {
        let mut invalid = Vec::new();
        for (key, value) in [
            ("id", serde_json::json!("invalid")),
            ("url", serde_json::json!(INSTALL_URL)),
            ("code", serde_json::json!("invalid")),
            ("expiresAt", serde_json::json!("2000-01-01T00:00:00Z")),
            ("unexpected", serde_json::json!(true)),
        ] {
            let mut body = installation_body();
            body[key] = value;
            invalid.push(body.to_string());
        }
        invalid.push(" ".repeat(MAX_BODY + 1));
        for body in invalid {
            let (directory, wire) = response("200 OK", body, "").await;
            assert!(directory.create_installation(CENTRAL_BEARER).await.is_err());
            wire.await.unwrap();
        }
        for status in ["401 Unauthorized", "403 Forbidden", "404 Not Found"] {
            let (directory, wire) = response(status, "{}".into(), "").await;
            assert!(directory.create_installation(CENTRAL_BEARER).await.is_err());
            wire.await.unwrap();
        }
    }

    #[tokio::test]
    async fn installation_polling_rejects_foreign_ids_unsafe_urls_and_invalid_phases() {
        let mut invalid = Vec::new();
        for (key, value) in [
            (
                "id",
                serde_json::json!("11111111-1111-4111-8111-111111111111"),
            ),
            ("phase", serde_json::json!("unknown")),
            ("expiresAt", serde_json::json!("invalid")),
            ("unexpected", serde_json::json!(true)),
        ] {
            let mut body = status_body();
            body[key] = value;
            invalid.push(body.to_string());
        }
        for url in [
            "http://server.example.com",
            "https://user:pass@server.example.com",
            "https://server.example.com/path",
            "https://server.example.com?next=other",
            "https://server.example.com#other",
            "https://server.example.com:8443",
            "https://127.0.0.1",
            "https://[::1]",
            "https://localhost",
        ] {
            let mut body = status_body();
            body["url"] = serde_json::json!(url);
            invalid.push(body.to_string());
        }
        let mut ready_without_url = status_body();
        ready_without_url["phase"] = serde_json::json!("ready");
        invalid.push(ready_without_url.to_string());
        invalid.push(" ".repeat(MAX_BODY + 1));
        for body in invalid {
            let (directory, wire) = response("200 OK", body, "").await;
            assert!(directory
                .installation_status(CENTRAL_BEARER, DEVICE)
                .await
                .is_err());
            wire.await.unwrap();
        }
        for status in ["401 Unauthorized", "403 Forbidden", "404 Not Found"] {
            let (directory, wire) = response(status, "{}".into(), "").await;
            assert!(directory
                .installation_status(CENTRAL_BEARER, DEVICE)
                .await
                .is_err());
            wire.await.unwrap();
        }
    }

    #[test]
    fn workspace_history_is_account_device_and_organization_scoped() {
        let directory = tempfile::tempdir().unwrap();
        let other_device = tempfile::tempdir().unwrap();
        let identity = ("https://accounts.example.test", "user-a");
        let target = WorkspaceTarget {
            organization_id: DEVICE.into(),
            server_id: DEVICE.into(),
            workspace_id: DEVICE.into(),
            binding_version: 1,
            key_fingerprint: "a".repeat(64),
        };
        remember_workspace(directory.path(), identity, &target).unwrap();
        assert_eq!(
            workspace_history(directory.path(), identity, DEVICE).unwrap(),
            Some(target.clone())
        );
        assert!(
            workspace_history(directory.path(), (identity.0, "user-b"), DEVICE)
                .unwrap()
                .is_none()
        );
        assert!(workspace_history(other_device.path(), identity, DEVICE)
            .unwrap()
            .is_none());
        assert!(workspace_history(
            directory.path(),
            identity,
            "00000000-0000-4000-8000-000000000002"
        )
        .unwrap()
        .is_none());
        assert!(workspace_history(directory.path(), identity, "../outside").is_err());
        let path = workspace_history_path(directory.path(), identity, DEVICE);
        assert!(!path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .contains("user-a"));
        fs::write(path, " ".repeat(1025)).unwrap();
        assert!(workspace_history(directory.path(), identity, DEVICE).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_history_rejects_links_and_writes_without_following_them() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), "unchanged").unwrap();
        let identity = ("https://accounts.example.test", "user-a");
        let path = workspace_history_path(directory.path(), identity, DEVICE);
        symlink(outside.path(), &path).unwrap();
        assert!(workspace_history(directory.path(), identity, DEVICE).is_err());
        let target = WorkspaceTarget {
            organization_id: DEVICE.into(),
            server_id: DEVICE.into(),
            workspace_id: DEVICE.into(),
            binding_version: 1,
            key_fingerprint: "a".repeat(64),
        };
        remember_workspace(directory.path(), identity, &target).unwrap();
        assert_eq!(fs::read_to_string(outside.path()).unwrap(), "unchanged");
        assert_eq!(
            workspace_history(directory.path(), identity, DEVICE).unwrap(),
            Some(target)
        );
    }

    #[test]
    fn startup_keeps_the_chosen_organization_and_an_unreachable_remembered_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let identity = ("https://accounts.example.test", "user-a");
        let mut value = workspace_catalog();
        let other = "00000000-0000-4000-8000-000000000002";
        value["organizations"].as_array_mut().unwrap().push(serde_json::json!({ "id": other, "name": "Empty", "type": "shared", "role": "admin", "servers": [] }));
        let decode =
            |value: serde_json::Value| serde_json::from_value::<WorkspaceCatalog>(value).unwrap();
        assert!(decode(value.clone())
            .initial_workspace(directory.path(), identity)
            .unwrap()
            .is_none());
        value["defaultOrganizationId"] = serde_json::json!(other);
        assert!(decode(value.clone())
            .initial_workspace(directory.path(), identity)
            .unwrap()
            .is_none());
        value["defaultOrganizationId"] = serde_json::json!(DEVICE);
        let target = decode(value.clone())
            .initial_workspace(directory.path(), identity)
            .unwrap()
            .unwrap()
            .target
            .unwrap();
        remember_workspace(directory.path(), identity, &target).unwrap();
        value["organizations"][0]["servers"][0]["routes"] = serde_json::json!([]);
        assert!(decode(value)
            .initial_workspace(directory.path(), identity)
            .is_err());
    }

    #[test]
    fn workspace_history_restores_the_last_authorized_choice_within_the_selected_organization() {
        let directory = tempfile::tempdir().unwrap();
        let identity = ("https://accounts.example.test", "user-a");
        let mut value = workspace_catalog();
        let mut second = value["organizations"][0]["servers"][0]["workspaces"][0].clone();
        second["id"] = serde_json::json!("00000000-0000-4000-8000-000000000002");
        value["organizations"][0]["servers"][0]["workspaces"]
            .as_array_mut()
            .unwrap()
            .push(second);
        let catalog: WorkspaceCatalog = serde_json::from_value(value).unwrap();
        assert!(catalog
            .initial_workspace(directory.path(), identity)
            .unwrap()
            .is_none());
        let selected = catalog.clone().workspaces().unwrap().pop().unwrap();
        remember_workspace(
            directory.path(),
            identity,
            selected.target.as_ref().unwrap(),
        )
        .unwrap();
        assert_eq!(
            catalog
                .initial_workspace(directory.path(), identity)
                .unwrap()
                .unwrap()
                .id,
            selected.id
        );
        assert!(catalog
            .initial_workspace(directory.path(), (identity.0, "other-account"))
            .unwrap()
            .is_none());
        assert_eq!(catalog.discovery_servers().unwrap().len(), 1);
        let mut denied = workspace_catalog();
        denied["organizations"][0]["servers"][0]["workspaces"][0]["canOpen"] =
            serde_json::json!(false);
        assert!(serde_json::from_value::<WorkspaceCatalog>(denied)
            .unwrap()
            .discovery_servers()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn organization_preferences_keep_the_account_bearer_native_and_verify_the_saved_value() {
        let (directory, wire) = response(
            "200 OK",
            serde_json::json!({ "defaultOrganizationId": DEVICE }).to_string(),
            "",
        )
        .await;
        directory
            .set_default_organization(CENTRAL_BEARER, Some(DEVICE))
            .await
            .unwrap();
        let request = wire.await.unwrap();
        assert!(request.starts_with("PATCH /api/organizations/preferences HTTP/1.1\r\n"));
        assert!(request.to_lowercase().contains(&format!(
            "authorization: bearer {}",
            CENTRAL_BEARER.to_lowercase()
        )));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(request.split_once("\r\n\r\n").unwrap().1)
                .unwrap(),
            serde_json::json!({ "defaultOrganizationId": DEVICE })
        );
        let (directory, wire) = response(
            "200 OK",
            serde_json::json!({ "defaultOrganizationId": null }).to_string(),
            "",
        )
        .await;
        assert!(directory
            .set_default_organization(CENTRAL_BEARER, Some(DEVICE))
            .await
            .is_err());
        wire.await.unwrap();
        assert!(Directory::new()
            .unwrap()
            .set_default_organization(CENTRAL_BEARER, Some("bad"))
            .await
            .is_err());
    }

    fn workspace_catalog() -> serde_json::Value {
        serde_json::json!({"version": 2, "defaultOrganizationId": null, "organizations": [{
            "id": DEVICE, "name": "Company", "type": "shared", "role": "member", "servers": [{
                "id": DEVICE, "name": "Server", "bindingVersion": 1, "keyFingerprint": "a".repeat(64), "state": "ready",
                "routes": [{"id": DEVICE, "kind": "direct", "address": "https://team.example.com", "deviceId": null}],
                "workspaces": [{"id": DEVICE, "name": "Studio", "state": "ready", "canOpen": true, "role": "member"}]
            }]
        }]})
    }

    #[test]
    fn tunnel_only_workspaces_use_a_virtual_origin_and_a_separate_exact_relay_route() {
        let mut value = workspace_catalog();
        value["organizations"][0]["servers"][0]["routes"][0]["kind"] = serde_json::json!("tunnel");
        value["organizations"][0]["servers"][0]["routes"][0]["address"] =
            serde_json::json!("https://relay.example.test");
        let catalog: WorkspaceCatalog = serde_json::from_value(value.clone()).unwrap();
        let workspace = catalog.clone().workspaces().unwrap().pop().unwrap();
        let target = workspace.target.unwrap();
        let virtual_origin = Url::parse(&workspace.url).unwrap();
        assert_eq!(
            workspace.url,
            format!("https://{DEVICE}.installation.ork.invalid")
        );
        assert_eq!(
            catalog
                .relay_origin(&target, &virtual_origin)
                .unwrap()
                .as_deref(),
            Some("https://relay.example.test")
        );
        let mut wrong = target.clone();
        wrong.key_fingerprint = "b".repeat(64);
        assert!(catalog.relay_origin(&wrong, &virtual_origin).is_err());
        value["organizations"][0]["servers"][0]["routes"][0]["address"] =
            serde_json::json!(origin().origin().ascii_serialization());
        let catalog: WorkspaceCatalog = serde_json::from_value(value).unwrap();
        assert!(catalog.clone().workspaces().is_err());
        assert!(catalog.relay_origin(&target, &virtual_origin).is_err());
    }

    #[test]
    fn local_workspace_routes_are_only_available_on_the_registered_device() {
        let mut value = workspace_catalog();
        let local = "http://127.0.0.1:45173";
        value["organizations"][0]["servers"][0]["routes"] = serde_json::json!([
            {"id": DEVICE, "kind": "local", "address": local, "deviceId": DEVICE}
        ]);
        let catalog: WorkspaceCatalog = serde_json::from_value(value).unwrap();
        assert!(catalog
            .clone()
            .for_device(None)
            .workspaces()
            .unwrap()
            .is_empty());
        assert!(catalog
            .clone()
            .for_device(Some("00000000-0000-4000-8000-000000000002"))
            .workspaces()
            .unwrap()
            .is_empty());
        let workspaces = catalog.for_device(Some(DEVICE)).workspaces().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].url, local);
    }

    #[test]
    fn refreshing_a_local_route_preserves_other_routes_and_requires_the_exact_installation() {
        let mut value = workspace_catalog();
        value["organizations"][0]["servers"][0]["routes"].as_array_mut().unwrap().push(serde_json::json!({
            "id": DEVICE, "kind": "local", "address": "http://127.0.0.1:45174", "deviceId": DEVICE
        }));
        let catalog: WorkspaceCatalog = serde_json::from_value(value).unwrap();
        let target = catalog
            .clone()
            .workspaces()
            .unwrap()
            .pop()
            .unwrap()
            .target
            .unwrap();
        let origin = Url::parse("http://127.0.0.1:45173").unwrap();
        let routes = catalog
            .local_installation_routes(&target, &origin, DEVICE)
            .unwrap();
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0]["kind"], "direct");
        assert_eq!(routes[1]["address"], "http://127.0.0.1:45173");
        assert_eq!(routes[1]["deviceId"], DEVICE);
        let mut stale = target.clone();
        stale.binding_version += 1;
        assert!(catalog
            .local_installation_routes(&stale, &origin, DEVICE)
            .is_err());
        stale = target.clone();
        stale.key_fingerprint = "b".repeat(64);
        assert!(catalog
            .local_installation_routes(&stale, &origin, DEVICE)
            .is_err());
        assert!(catalog
            .local_installation_routes(
                &target,
                &Url::parse("http://elsewhere.example.test").unwrap(),
                DEVICE
            )
            .is_err());
    }

    #[test]
    fn local_installation_requires_an_explicit_or_default_administrable_organization() {
        let mut value = workspace_catalog();
        value["organizations"][0]["role"] = serde_json::json!("admin");
        let first = value["organizations"][0]["id"].as_str().unwrap().to_owned();
        let mut second = value["organizations"][0].clone();
        second["id"] = serde_json::json!("00000000-0000-4000-8000-000000000002");
        value["organizations"].as_array_mut().unwrap().push(second);
        let catalog: WorkspaceCatalog = serde_json::from_value(value.clone()).unwrap();
        assert!(catalog.local_organization(None).is_err());
        assert_eq!(catalog.local_organization(Some(&first)).unwrap(), first);
        assert!(catalog.local_organization(Some("unknown")).is_err());
        value["defaultOrganizationId"] = serde_json::json!(first);
        value["organizations"][0]["role"] = serde_json::json!("member");
        let catalog: WorkspaceCatalog = serde_json::from_value(value).unwrap();
        assert!(catalog.local_organization(None).is_err());
    }

    #[tokio::test]
    async fn workspace_directory_validates_membership_response_before_exposing_servers() {
        let catalog = workspace_catalog();
        let (directory, wire) = response("200 OK", catalog.to_string(), "").await;
        let list = directory.workspaces("private-fixture-token").await.unwrap();
        assert_eq!(list[0].name, "Company / Server / Studio");
        assert_eq!(list[0].target.as_ref().unwrap().workspace_id, DEVICE);
        assert_eq!(
            list[0].target.as_ref().unwrap().key_fingerprint,
            "a".repeat(64)
        );
        let request = wire.await.unwrap();
        assert!(request.starts_with("GET /api/identity/v2/catalog HTTP/1.1\r\n"));
        let mut invalid = Vec::new();
        let mut duplicate = catalog.clone();
        duplicate["organizations"][0]["servers"][0]["workspaces"] = serde_json::json!([
            catalog["organizations"][0]["servers"][0]["workspaces"][0],
            catalog["organizations"][0]["servers"][0]["workspaces"][0]
        ]);
        invalid.push(duplicate);
        for (field, value) in [("id", "bad"), ("name", "Studio\nAdmin")] {
            let mut item = catalog.clone();
            item["organizations"][0]["servers"][0]["workspaces"][0][field] =
                serde_json::json!(value);
            invalid.push(item);
        }
        let mut credential_url = catalog.clone();
        credential_url["organizations"][0]["servers"][0]["routes"][0]["address"] =
            serde_json::json!("https://user@team.example.com");
        invalid.push(credential_url);
        let mut wrong_pin = catalog.clone();
        wrong_pin["organizations"][0]["servers"][0]["keyFingerprint"] =
            serde_json::json!("invalid");
        invalid.push(wrong_pin);
        for body in invalid {
            let (directory, wire) = response("200 OK", body.to_string(), "").await;
            assert!(directory.workspaces("private-fixture-token").await.is_err());
            wire.await.unwrap();
        }
        let mut blocked = catalog;
        blocked["organizations"][0]["servers"][0]["workspaces"][0]["canOpen"] =
            serde_json::json!(false);
        let (directory, wire) = response("200 OK", blocked.to_string(), "").await;
        assert!(directory
            .workspaces("private-fixture-token")
            .await
            .unwrap()
            .is_empty());
        wire.await.unwrap();
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

    #[test]
    fn default_preferences_are_private_account_scoped_and_independent_of_last_opened_settings() {
        let root = tempfile::tempdir().unwrap();
        let identity = ("https://accounts.example.test", "subject-a");
        assert_eq!(preference(root.path(), identity).unwrap(), None);
        save_preference(root.path(), identity, Some(DEVICE)).unwrap();
        assert_eq!(
            preference(root.path(), identity)
                .unwrap()
                .unwrap()
                .server_id
                .as_deref(),
            Some(DEVICE)
        );
        assert_eq!(
            preference(root.path(), (identity.0, "subject-b")).unwrap(),
            None
        );
        assert_eq!(
            preference(root.path(), ("https://other.example.test", identity.1)).unwrap(),
            None
        );
        let contents = fs::read_to_string(preference_path(root.path(), identity)).unwrap();
        assert!(!contents.contains(identity.0));
        assert!(!contents.contains(identity.1));
        crate::settings::save(
            root.path(),
            &crate::settings::Setup {
                workspace: None,
                mode: crate::settings::InstanceMode::Existing,
                server_url: Url::parse("https://different.example.test").unwrap(),
                account: Some(crate::settings::account_key(identity)),
            },
        )
        .unwrap();
        assert_eq!(
            preference(root.path(), identity)
                .unwrap()
                .unwrap()
                .server_id
                .as_deref(),
            Some(DEVICE)
        );
        assert!(save_preference(root.path(), identity, Some("../another")).is_err());
        assert_eq!(
            fs::read_to_string(preference_path(root.path(), identity)).unwrap(),
            contents
        );
        save_preference(root.path(), identity, None).unwrap();
        assert_eq!(
            preference(root.path(), identity).unwrap(),
            Some(Preference { server_id: None })
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(
                fs::metadata(preference_path(root.path(), identity))
                    .unwrap()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn default_preferences_reject_malformed_oversized_or_nonregular_files() {
        let root = tempfile::tempdir().unwrap();
        let identity = ("https://accounts.example.test", "subject-a");
        let path = preference_path(root.path(), identity);
        for value in [
            "not json",
            "{\"serverId\":\"invalid\"}",
            "{\"serverId\":null,\"other\":true}",
        ] {
            fs::write(&path, value).unwrap();
            assert!(preference(root.path(), identity).is_err());
        }
        fs::write(&path, vec![b' '; 257]).unwrap();
        assert!(preference(root.path(), identity).is_err());
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(preference(root.path(), identity).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn default_preferences_do_not_follow_file_or_directory_links() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("private");
        let identity = ("https://accounts.example.test", "subject-a");
        save_preference(&directory, identity, Some(DEVICE)).unwrap();
        let original = root.path().join("original.json");
        let contents = fs::read(preference_path(&directory, identity)).unwrap();
        fs::write(&original, &contents).unwrap();
        fs::remove_file(preference_path(&directory, identity)).unwrap();
        symlink(&original, preference_path(&directory, identity)).unwrap();
        assert!(preference(&directory, identity).is_err());
        save_preference(&directory, identity, None).unwrap();
        assert_eq!(fs::read(&original).unwrap(), contents);
        let link = root.path().join("linked");
        symlink(&directory, &link).unwrap();
        assert!(preference(&link, identity).is_err());
        assert!(save_preference(&link, identity, Some(DEVICE)).is_err());
    }
}
