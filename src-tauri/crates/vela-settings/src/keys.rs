//! The setting key namespace.
//!
//! Keys are dotted and namespaced so that `list_settings(prefix)` is a usable
//! query and so that a future feature cannot collide with an existing one by
//! accident. They are also a storage contract: renaming one orphans the rows
//! users already have, so a rename is a migration, not an edit.

/// `appearance.theme` → [`crate::ThemePreference`].
pub const THEME: &str = "appearance.theme";

/// `privacy.telemetry` → [`crate::Telemetry`]. Written once, as `disabled`, so
/// that the row exists and a reader can see what the value is rather than
/// inferring it from absence.
pub const TELEMETRY: &str = "privacy.telemetry";

/// Prefix under which one row per configured provider lives.
pub const PROVIDER_PREFIX: &str = "provider.config.";

/// The key for one provider's configuration row.
pub fn provider(id: &str) -> String {
    format!("{PROVIDER_PREFIX}{id}")
}

/// The provider id inside a `provider.config.*` key, if it is one.
pub fn provider_id_of(key: &str) -> Option<&str> {
    key.strip_prefix(PROVIDER_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_keys_round_trip() {
        let key = provider("local-llamacpp");
        assert_eq!(key, "provider.config.local-llamacpp");
        assert_eq!(provider_id_of(&key), Some("local-llamacpp"));
        assert_eq!(provider_id_of(THEME), None);
    }

    #[test]
    fn namespaces_do_not_overlap() {
        assert!(!THEME.starts_with(PROVIDER_PREFIX));
        assert!(!TELEMETRY.starts_with(PROVIDER_PREFIX));
        assert_ne!(THEME, TELEMETRY);
    }
}
