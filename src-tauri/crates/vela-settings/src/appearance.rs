//! Appearance settings.

use serde::{Deserialize, Serialize};

/// Which theme the user asked for.
///
/// `System` is the default and is *not* resolved here: the renderer follows
/// `prefers-color-scheme` when the preference is `System`, so the app tracks
/// the OS while the user is still deciding. Resolving it in Rust would freeze
/// the choice at startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    Light,
    Dark,
    #[default]
    System,
}

impl ThemePreference {
    /// The `data-theme` attribute value the renderer should set on `<html>`,
    /// or `None` to let `prefers-color-scheme` decide.
    ///
    /// Mirrors the token rules in `src/styles/tokens.css`: an explicit choice
    /// wins in both directions, absence means "follow the system".
    pub fn data_theme_attribute(self) -> Option<&'static str> {
        match self {
            ThemePreference::Light => Some("light"),
            ThemePreference::Dark => Some("dark"),
            ThemePreference::System => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_theme_follows_the_operating_system() {
        assert_eq!(ThemePreference::default(), ThemePreference::System);
        assert_eq!(ThemePreference::default().data_theme_attribute(), None);
    }

    #[test]
    fn theme_preferences_round_trip_as_camel_case_json() {
        for (preference, expected) in [
            (ThemePreference::Light, r#""light""#),
            (ThemePreference::Dark, r#""dark""#),
            (ThemePreference::System, r#""system""#),
        ] {
            let json = serde_json::to_string(&preference).unwrap();
            assert_eq!(json, expected);
            assert_eq!(
                serde_json::from_str::<ThemePreference>(&json).unwrap(),
                preference
            );
        }
    }

    #[test]
    fn an_explicit_choice_produces_a_data_theme_attribute() {
        assert_eq!(
            ThemePreference::Dark.data_theme_attribute(),
            Some("dark")
        );
        assert_eq!(
            ThemePreference::Light.data_theme_attribute(),
            Some("light")
        );
    }
}
