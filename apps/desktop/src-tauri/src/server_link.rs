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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bookmark {
    pub origin: String,
    pub account: String,
}

#[cfg(test)]
mod tests {
    use super::*;

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
