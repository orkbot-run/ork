// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Preserves the inherited window-options.ts warm-window timeout policy.

use std::time::Duration;

pub fn warm_window_ttl(raw: Option<&str>) -> Duration {
    let milliseconds = raw
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|value| value.is_finite() && (0.0..=2_147_483_647.0).contains(value))
        .unwrap_or(15.0 * 60.0 * 1000.0);
    Duration::from_millis(milliseconds as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warm_window_timeout_preserves_the_existing_bounded_environment_setting() {
        for (raw, expected) in [
            ("0", 0),
            ("900000", 900_000),
            ("2147483647", 2_147_483_647),
            (" 5000 ", 5000),
            ("1.5", 1),
        ] {
            assert_eq!(warm_window_ttl(Some(raw)).as_millis(), expected);
        }
        for raw in [
            None,
            Some(""),
            Some(" "),
            Some("-1"),
            Some("NaN"),
            Some("Infinity"),
            Some("2147483648"),
            Some("invalid"),
        ] {
            assert_eq!(warm_window_ttl(raw), Duration::from_secs(15 * 60));
        }
    }
}
