// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Adapted from the inherited desktop locale selection and placeholder formatting.
// Generated catalogs retain their upstream translations. Rust additions follow LICENSE.md.

use std::{
    collections::BTreeMap,
    fs::{self, DirBuilder, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
};

type Catalogs = BTreeMap<String, BTreeMap<String, String>>;
const CATALOGS_JSON: &str = include_str!("../../build/tauri-ui/desktop-locales.json");
const LOCALE_FILE: &str = "ui-locale.txt";

fn catalogs() -> &'static Catalogs {
    static CATALOGS: OnceLock<Catalogs> = OnceLock::new();
    CATALOGS.get_or_init(|| {
        serde_json::from_str(CATALOGS_JSON).expect("valid generated desktop catalogs")
    })
}

pub struct Locale {
    directory: PathBuf,
    tag: String,
    reported: Option<String>,
}

impl Locale {
    pub fn new(directory: PathBuf) -> Self {
        let reported = read_locale(&directory);
        let tag = resolve(reported.as_deref().unwrap_or("en"));
        Self {
            directory,
            tag,
            reported,
        }
    }

    /// Persist the reported BCP-47 tag while native menus use the nearest shipped catalog.
    pub fn set(&mut self, raw: &str) -> Result<bool, String> {
        if !valid_tag(raw) {
            return Err("Invalid language tag.".into());
        }
        if self.reported.as_deref() == Some(raw) {
            return Ok(false);
        }
        write_locale(&self.directory, raw)?;
        let next = resolve(raw);
        let changed = self.tag != next;
        self.tag = next;
        self.reported = Some(raw.to_owned());
        Ok(changed)
    }

    #[cfg(test)]
    pub fn tag(&self) -> &str {
        &self.tag
    }

    pub fn text(&self, message: &str) -> String {
        catalogs()
            .get(&self.tag)
            .and_then(|catalog| catalog.get(message))
            .cloned()
            .unwrap_or_else(|| message.to_owned())
    }

    pub fn format(&self, message: &str, values: &[(&str, &str)]) -> String {
        format_placeholders(&self.text(message), values)
    }
}

fn valid_tag(value: &str) -> bool {
    if value.len() > 35 {
        return false;
    }
    let mut parts = value.split('-');
    let language = parts.next().unwrap_or("");
    if !(2..=3).contains(&language.len())
        || !language.bytes().all(|byte| byte.is_ascii_alphabetic())
    {
        return false;
    }
    let rest = parts.collect::<Vec<_>>();
    rest.len() <= 3
        && rest.iter().all(|part| {
            (2..=8).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

fn resolve(raw: &str) -> String {
    let normalized = raw.trim().to_ascii_lowercase().replace('_', "-");
    let parts = normalized.split('-').collect::<Vec<_>>();
    let candidate = match parts.first().copied().unwrap_or("") {
        "pt" => "pt-BR",
        "es" => "es",
        "iw" => "he",
        "zh" if matches!(parts.get(1).copied(), Some("hant" | "tw" | "hk" | "mo")) => "zh-TW",
        "zh" => "zh-CN",
        language => language,
    };
    if candidate == "en" || catalogs().contains_key(candidate) {
        candidate.to_owned()
    } else {
        "en".into()
    }
}

fn format_placeholders(template: &str, values: &[(&str, &str)]) -> String {
    let mut result = String::with_capacity(template.len());
    let mut remainder = template;
    while let Some(start) = remainder.find('{') {
        result.push_str(&remainder[..start]);
        let Some(end) = remainder[start + 1..]
            .find('}')
            .map(|offset| start + 1 + offset)
        else {
            result.push_str(&remainder[start..]);
            return result;
        };
        let key = &remainder[start + 1..end];
        let replacement = (!key.is_empty()
            && key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'))
        .then(|| {
            values
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| *value)
        })
        .flatten();
        if key.contains('{') {
            result.push('{');
            remainder = &remainder[start + 1..];
        } else {
            result.push_str(replacement.unwrap_or(&remainder[start..=end]));
            remainder = &remainder[end + 1..];
        }
    }
    result.push_str(remainder);
    result
}

fn reparse(metadata: &fs::Metadata) -> bool {
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

fn read_locale(directory: &Path) -> Option<String> {
    let directory_metadata = fs::symlink_metadata(directory).ok()?;
    if !directory_metadata.is_dir() || reparse(&directory_metadata) {
        return None;
    }
    let path = directory.join(LOCALE_FILE);
    let before = fs::symlink_metadata(&path).ok()?;
    if !before.is_file() || reparse(&before) || before.len() > 64 {
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
    if !after.is_file() || reparse(&after) {
        return None;
    }
    let mut value = String::new();
    file.take(65).read_to_string(&mut value).ok()?;
    if value.len() > 64 {
        return None;
    }
    let value = value.trim();
    valid_tag(value).then(|| value.to_owned())
}

fn write_locale(directory: &Path, value: &str) -> Result<(), String> {
    const ERROR: &str = "Could not save the interface language.";
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory).map_err(|_| ERROR)?;
    let metadata = fs::symlink_metadata(directory).map_err(|_| ERROR)?;
    if !metadata.is_dir() || reparse(&metadata) {
        return Err(ERROR.into());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(directory).map_err(|_| ERROR)?;
    temporary
        .write_all(format!("{value}\n").as_bytes())
        .map_err(|_| ERROR)?;
    temporary.as_file().sync_all().map_err(|_| ERROR)?;
    temporary
        .persist(directory.join(LOCALE_FILE))
        .map_err(|_| ERROR)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_resolution_matches_the_shared_ui_fallbacks() {
        for (raw, expected) in [
            ("pl-PL", "pl"),
            ("pt-PT", "pt-BR"),
            ("es-419", "es"),
            ("iw-IL", "he"),
            ("zh_Hant_CN", "zh-TW"),
            ("zh-Hans-TW", "zh-CN"),
            ("zh-HK", "zh-TW"),
            ("ar-SA", "en"),
            ("en-GB", "en"),
        ] {
            assert_eq!(resolve(raw), expected, "{raw}");
        }
        assert!(!catalogs().is_empty());
    }

    #[test]
    fn placeholders_preserve_unknown_keys_and_do_not_expand_replacements_twice() {
        assert_eq!(
            format_placeholders("About {name} {unknown}", &[("name", "Ork")]),
            "About Ork {unknown}"
        );
        assert_eq!(
            format_placeholders(
                "{name} {version}",
                &[("name", "{version}"), ("version", "1")]
            ),
            "{version} 1"
        );
        assert_eq!(
            format_placeholders("{not-a-key} {missing", &[]),
            "{not-a-key} {missing"
        );
        assert_eq!(format_placeholders("{{name}}", &[("name", "Ork")]), "{Ork}");
    }

    #[test]
    fn reported_tags_are_bounded_and_cannot_be_file_paths() {
        for valid in ["pl", "en-US", "pt-BR", "zh-Hant-TW", "iw", "es-419"] {
            assert!(valid_tag(valid));
        }
        for invalid in [
            "",
            "english",
            "pl/../../other",
            "en_US",
            "en--US",
            "en\nUS",
            "en-US-TW-CN-DE",
            "en-123456789",
        ] {
            assert!(!valid_tag(invalid), "{invalid}");
        }
    }

    #[test]
    fn language_choice_is_persisted_without_rebuilding_for_equivalent_tags() {
        let directory = tempfile::tempdir().unwrap();
        let mut locale = Locale::new(directory.path().to_owned());
        assert_eq!(locale.tag(), "en");
        assert!(locale.set("pl-PL").unwrap());
        assert_ne!(locale.text("File"), "File");
        assert!(!locale.set("pl").unwrap());
        assert_eq!(Locale::new(directory.path().to_owned()).tag(), "pl");
        let before = fs::read(directory.path().join(LOCALE_FILE)).unwrap();
        assert!(locale.set("../../invalid").is_err());
        assert_eq!(
            fs::read(directory.path().join(LOCALE_FILE)).unwrap(),
            before
        );
        assert_eq!(
            locale.text("missing catalog entry"),
            "missing catalog entry"
        );
        assert!(!locale
            .format("About {name}", &[("name", "Ork")])
            .contains("{name}"));
    }

    #[cfg(unix)]
    #[test]
    fn locale_file_symlinks_are_not_read_or_followed_during_writes() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("other");
        fs::write(&target, "pl\n").unwrap();
        symlink(&target, directory.path().join(LOCALE_FILE)).unwrap();
        let mut locale = Locale::new(directory.path().to_owned());
        assert_eq!(locale.tag(), "en");
        locale.set("de").unwrap();
        assert_eq!(fs::read_to_string(target).unwrap(), "pl\n");
    }
}
