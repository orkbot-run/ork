// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use url::Url;

/// A connect link proposes an origin. It carries no authentication authority.
pub fn parse(input: &str) -> Option<String> {
    if input.len() > 4096 || input.trim() != input || input.chars().any(char::is_control) {
        return None;
    }
    let link = Url::parse(input).ok()?;
    if link.scheme() != "orkbot"
        || link.host_str() != Some("connect")
        || !link.username().is_empty()
        || link.password().is_some()
        || link.port().is_some()
        || !link.path().is_empty()
        || link.fragment().is_some()
    {
        return None;
    }
    let mut query = link.query_pairs();
    let (name, address) = query.next()?;
    if name != "server" || query.next().is_some() {
        return None;
    }
    let origin = crate::server::normalize_server_url(&address).ok()?;
    let canonical = origin.origin().ascii_serialization();
    if address.len() > 2048 || (address != canonical && address != format!("{canonical}/")) {
        return None;
    }
    Some(canonical)
}

/// A bootstrap credential stays native and is released once to the newly confirmed document.
pub struct Initialization {
    pub origin: String,
    secret: String,
    confirmed: Option<(String, String)>,
}

impl Initialization {
    pub fn confirm(&mut self, origin: &str, label: &str, account: &str) {
        if self.origin == origin {
            self.confirmed = Some((label.into(), account.into()));
        }
    }

    pub fn consume(&mut self, origin: &str, label: &str, account: &str) -> Option<String> {
        if self.origin != origin
            || self
                .confirmed
                .as_ref()
                .is_none_or(|(window, owner)| window != label || owner != account)
        {
            return None;
        }
        self.confirmed = None;
        Some(std::mem::take(&mut self.secret))
    }
}

pub fn parse_initialization(input: &str) -> Option<Initialization> {
    if input.len() > 4096 || input.trim() != input || input.chars().any(char::is_control) {
        return None;
    }
    let link = Url::parse(input).ok()?;
    if link.scheme() != "orkbot"
        || link.host_str() != Some("initialize")
        || !link.username().is_empty()
        || link.password().is_some()
        || link.port().is_some()
        || !link.path().is_empty()
        || link.fragment().is_some()
    {
        return None;
    }
    let mut address = None;
    let mut secret = None;
    for (name, value) in link.query_pairs() {
        match name.as_ref() {
            "server" if address.is_none() => address = Some(value.into_owned()),
            "secret" if secret.is_none() => secret = Some(value.into_owned()),
            _ => return None,
        }
    }
    let address = address?;
    let secret = secret?;
    if !crate::server_login::valid_challenge(&secret) {
        return None;
    }
    // Reuse the canonical, scheme and network policy of ordinary connection links.
    let mut connection = Url::parse("orkbot://connect").ok()?;
    connection.query_pairs_mut().append_pair("server", &address);
    let origin = parse(connection.as_str())?;
    Some(Initialization {
        origin,
        secret,
        confirmed: None,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bookmark {
    pub origin: String,
    pub account: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn initialization_link(origin: &str, secret: &str) -> String {
        let mut url = Url::parse("orkbot://initialize").unwrap();
        url.query_pairs_mut()
            .append_pair("server", origin)
            .append_pair("secret", secret);
        url.to_string()
    }

    #[test]
    fn bootstrap_secret_requires_confirmation_and_is_released_once_to_its_new_window_and_account() {
        let mut pending = parse_initialization(&initialization_link(
            "https://server.example.com",
            &"s".repeat(43),
        ))
        .unwrap();
        assert!(pending
            .consume("https://server.example.com", "server-old", "account-a")
            .is_none());
        pending.confirm("https://server.example.com", "server-new", "account-a");
        assert!(pending
            .consume("https://other.example.com", "server-new", "account-a")
            .is_none());
        assert!(pending
            .consume("https://server.example.com", "server-old", "account-a")
            .is_none());
        assert!(pending
            .consume("https://server.example.com", "server-new", "account-b")
            .is_none());
        assert_eq!(
            pending.consume("https://server.example.com", "server-new", "account-a"),
            Some("s".repeat(43))
        );
        assert!(pending
            .consume("https://server.example.com", "server-new", "account-a")
            .is_none());
    }

    #[test]
    fn initialize_links_reject_unsafe_addresses_extra_fields_and_ambiguous_secrets() {
        let good = initialization_link("https://server.example.com", &"s".repeat(43));
        assert!(parse_initialization(&good).is_some());
        for invalid in [
            initialization_link("http://server.example.com", &"s".repeat(43)),
            initialization_link("https://user:secret@server.example.com", &"s".repeat(43)),
            initialization_link("https://server.example.com/path", &"s".repeat(43)),
            initialization_link("https://server.example.com", "invalid"),
            format!("{good}&secret={}", "t".repeat(43)),
            format!("{good}&account=other"),
            format!("{good}#fragment"),
            good.replace("initialize?", "initialize/?"),
            good.replace("initialize?", "user@initialize?"),
        ] {
            assert!(parse_initialization(&invalid).is_none());
        }
        assert!(parse(&good).is_none());
    }

    #[test]
    fn links_only_propose_canonical_safe_origins() {
        for address in [
            "https://server.example.com",
            "http://192.168.1.2:8080",
            "http://localhost:45173",
        ] {
            let mut link = Url::parse("orkbot://connect").unwrap();
            link.query_pairs_mut().append_pair("server", address);
            assert_eq!(parse(link.as_str()).as_deref(), Some(address));
        }
    }

    #[test]
    fn links_reject_ambiguous_targets_and_credentials() {
        for input in [
            "https://connect?server=https%3A%2F%2Fexample.com",
            "orkbot://connect/?server=https%3A%2F%2Fexample.com",
            "orkbot://connect?server=https%3A%2F%2Fexample.com#secret",
            "orkbot://user@connect?server=https%3A%2F%2Fexample.com",
            "orkbot://connect?server=https%3A%2F%2Fexample.com&server=https%3A%2F%2Fother.example.com",
            "orkbot://connect?server=https%3A%2F%2Fexample.com&token=secret",
            "orkbot://connect?server=https%3A%2F%2Fuser%3Asecret%40example.com",
            "orkbot://connect?server=https%3A%2F%2Fexample.com%2Fpath",
            "orkbot://connect?server=http%3A%2F%2Fexample.com",
            "orkbot://connect?server=http%3A%2F%2F169.254.169.254",
            "orkbot://connect?server=https%3A%2F%2Fexample.com%3Ftoken%3Dsecret",
            " orkbot://connect?server=https%3A%2F%2Fexample.com",
        ] {
            assert_eq!(parse(input), None, "{input}");
        }
    }
}
