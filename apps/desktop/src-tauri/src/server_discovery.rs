// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::collections::HashSet;

use crate::server_directory::{Kind, Server};

/// A successful first read establishes the baseline for one authenticated session.
#[derive(Default)]
pub struct Discovery {
    scope: Option<(String, String, u64)>,
    known: HashSet<String>,
}

impl Discovery {
    pub fn has_baseline(&self) -> bool {
        self.scope.is_some()
    }

    pub fn reset(&mut self) {
        self.scope = None;
        self.known.clear();
    }

    pub fn observe(
        &mut self,
        identity: (&str, &str),
        generation: u64,
        servers: &[Server],
        active_origin: &str,
    ) -> bool {
        let next = servers
            .iter()
            .filter(|server| server.kind == Kind::Selfhosted)
            .map(|server| server.id.clone())
            .collect::<HashSet<_>>();
        let scope = (identity.0.to_owned(), identity.1.to_owned(), generation);
        let added = self.scope.as_ref() == Some(&scope)
            && servers.iter().any(|server| {
                server.kind == Kind::Selfhosted
                    && server.url != active_origin
                    && !self.known.contains(&server.id)
            });
        self.scope = Some(scope);
        self.known = next;
        added
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(id: &str, kind: Kind) -> Server {
        Server {
            id: id.into(),
            url: format!("https://{id}.example.test"),
            kind,
            device_id: None,
        }
    }

    #[test]
    fn only_new_selfhosted_servers_after_a_baseline_are_reported() {
        let mut discovery = Discovery::default();
        let account = ("https://accounts.example.test", "alice");
        let first = server("one", Kind::Selfhosted);
        let second = server("two", Kind::Selfhosted);
        let local = server("local", Kind::Local);
        assert!(!discovery.observe(account, 1, std::slice::from_ref(&first), ""));
        assert!(!discovery.observe(account, 1, &[first.clone(), local], ""));
        assert!(discovery.observe(account, 1, &[first.clone(), second.clone()], ""));
        assert!(!discovery.observe(account, 1, &[first.clone(), second.clone()], ""));
        assert!(!discovery.observe(account, 1, std::slice::from_ref(&first), ""));
        assert!(discovery.observe(account, 1, &[first, second], ""));
    }

    #[test]
    fn account_changes_and_logout_require_a_new_baseline() {
        let mut discovery = Discovery::default();
        let first = server("one", Kind::Selfhosted);
        let second = server("two", Kind::Selfhosted);
        assert!(!discovery.observe(("issuer", "alice"), 1, std::slice::from_ref(&first), ""));
        assert!(!discovery.observe(("issuer", "bob"), 1, &[first.clone(), second.clone()], ""));
        assert!(!discovery.observe(("issuer", "bob"), 2, std::slice::from_ref(&first), ""));
        discovery.reset();
        assert!(!discovery.observe(("issuer", "bob"), 2, &[first, second], ""));
    }

    #[test]
    fn current_server_is_added_to_the_baseline_without_a_notification() {
        let mut discovery = Discovery::default();
        let account = ("issuer", "alice");
        let first = server("one", Kind::Selfhosted);
        let second = server("two", Kind::Selfhosted);
        assert!(!discovery.observe(account, 1, std::slice::from_ref(&first), &first.url));
        assert!(!discovery.observe(account, 1, &[first.clone(), second.clone()], &second.url));
        assert!(!discovery.observe(account, 1, &[first, second], "https://other.example.test"));
    }
}
