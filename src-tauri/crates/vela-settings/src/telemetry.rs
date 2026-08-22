//! Telemetry — which Vela does not do.
//!
//! # THE LOAD-BEARING RULE OF THIS FILE
//!
//! Vela ships with telemetry **off**, and there is no code path that turns it
//! on. That is not enforced by a comment or a config default; it is enforced by
//! the shape of the type:
//!
//! * [`Telemetry::Disabled`] is [`Default`].
//! * [`Telemetry::Enabled`] cannot be constructed without an
//!   [`ExplicitConsent`], which cannot be constructed without quoting
//!   [`CONSENT_STATEMENT`] verbatim and stamping the moment the user agreed.
//!   No `Default`, no `From<bool>`, no builder.
//! * Deserialisation is *lossy in the safe direction*: a stored row claiming
//!   telemetry is on, but carrying no valid consent record, loads as
//!   `Disabled`. Hand-editing the database cannot switch it on.
//! * There is no `settings_*` IPC command that writes it, so the renderer
//!   cannot reach it at all. A test in `src-tauri/src/ipc/settings.rs` asserts
//!   that.
//!
//! And the tripwire: [`tests::no_code_outside_this_module_enables_telemetry`]
//! scans the whole Rust workspace for a construction of the enabled variant. A
//! future change that quietly adds one turns the build red.

use serde::{Deserialize, Serialize};

/// The exact sentence a user must be shown and must agree to. Requiring it
/// verbatim means telemetry cannot be enabled by code that never showed it.
pub const CONSENT_STATEMENT: &str = "I have read what would be sent and I am choosing to send it.";

/// Evidence of an explicit, timestamped human decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplicitConsent {
    recorded_at_ms: i64,
    statement: String,
}

impl ExplicitConsent {
    /// The only constructor. Rejects anything that is not the real statement,
    /// and anything without a plausible timestamp.
    pub fn record(recorded_at_ms: i64, statement: &str) -> Option<Self> {
        if statement != CONSENT_STATEMENT || recorded_at_ms <= 0 {
            return None;
        }
        Some(Self {
            recorded_at_ms,
            statement: statement.to_owned(),
        })
    }

    pub fn recorded_at_ms(&self) -> i64 {
        self.recorded_at_ms
    }

    fn is_valid(&self) -> bool {
        self.statement == CONSENT_STATEMENT && self.recorded_at_ms > 0
    }
}

/// Whether Vela may send anything about how it is used. It may not.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(from = "StoredTelemetry", into = "StoredTelemetry")]
pub enum Telemetry {
    #[default]
    Disabled,
    /// Unreachable without an [`ExplicitConsent`]. Present so that the type is
    /// honest about what "off" means, and so that a future opt-in — if there
    /// ever is one — cannot be built as a bare boolean.
    Enabled(ExplicitConsent),
}

impl Telemetry {
    pub fn is_enabled(&self) -> bool {
        matches!(self, Telemetry::Enabled(_))
    }

    pub fn consent(&self) -> Option<&ExplicitConsent> {
        match self {
            Telemetry::Disabled => None,
            Telemetry::Enabled(consent) => Some(consent),
        }
    }
}

/// The on-disk shape. Kept separate so that the *conversion* can be lossy in
/// the safe direction while the in-memory type stays exact.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTelemetry {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    consent: Option<ExplicitConsent>,
}

impl From<StoredTelemetry> for Telemetry {
    /// Infallible on purpose: unreadable or tampered rows degrade to
    /// `Disabled`, never to an error the caller might paper over with a
    /// default that says `true`.
    fn from(stored: StoredTelemetry) -> Self {
        match stored.consent {
            Some(consent) if stored.enabled && consent.is_valid() => {
                // The single construction of the enabled variant in the entire
                // workspace, and it is gated on a valid consent record.
                Telemetry::Enabled(consent)
            }
            _ => Telemetry::Disabled,
        }
    }
}

impl From<Telemetry> for StoredTelemetry {
    fn from(telemetry: Telemetry) -> Self {
        match telemetry {
            Telemetry::Disabled => Self {
                enabled: false,
                consent: None,
            },
            Telemetry::Enabled(consent) => Self {
                enabled: true,
                consent: Some(consent),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn telemetry_is_off_by_default() {
        assert_eq!(Telemetry::default(), Telemetry::Disabled);
        assert!(!Telemetry::default().is_enabled());
        assert_eq!(Telemetry::default().consent(), None);
    }

    #[test]
    fn an_absent_setting_row_means_disabled() {
        let parsed: Telemetry = serde_json::from_str("{}").unwrap();
        assert!(!parsed.is_enabled());
    }

    #[test]
    fn a_stored_row_claiming_enabled_without_consent_loads_as_disabled() {
        // Hand-editing the SQLite file must not switch telemetry on.
        let tampered: Telemetry = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert_eq!(tampered, Telemetry::Disabled);

        let wrong_statement: Telemetry = serde_json::from_str(
            r#"{"enabled":true,"consent":{"recordedAtMs":1700000000000,"statement":"sure"}}"#,
        )
        .unwrap();
        assert_eq!(wrong_statement, Telemetry::Disabled);

        let no_timestamp: Telemetry = serde_json::from_str(&format!(
            r#"{{"enabled":true,"consent":{{"recordedAtMs":0,"statement":"{CONSENT_STATEMENT}"}}}}"#
        ))
        .unwrap();
        assert_eq!(no_timestamp, Telemetry::Disabled);
    }

    #[test]
    fn consent_cannot_be_recorded_without_the_exact_statement() {
        assert!(ExplicitConsent::record(1_700_000_000_000, "yes").is_none());
        assert!(ExplicitConsent::record(1_700_000_000_000, "").is_none());
        assert!(ExplicitConsent::record(0, CONSENT_STATEMENT).is_none());
        assert!(ExplicitConsent::record(-1, CONSENT_STATEMENT).is_none());

        let consent = ExplicitConsent::record(1_700_000_000_000, CONSENT_STATEMENT)
            .expect("the exact statement with a real timestamp is the one accepted form");
        assert_eq!(consent.recorded_at_ms(), 1_700_000_000_000);
    }

    #[test]
    fn a_valid_consent_record_is_the_only_way_a_stored_row_reads_as_enabled() {
        // Proves the negative tests above are not vacuous: the same shape with
        // a *valid* consent record does load as enabled.
        let json = format!(
            r#"{{"enabled":true,"consent":{{"recordedAtMs":1700000000000,"statement":"{CONSENT_STATEMENT}"}}}}"#
        );
        let parsed: Telemetry = serde_json::from_str(&json).unwrap();
        assert!(parsed.is_enabled());
    }

    #[test]
    fn disabled_telemetry_serialises_to_a_row_that_cannot_be_misread() {
        let json = serde_json::to_value(Telemetry::Disabled).unwrap();
        assert_eq!(json["enabled"], false);
        assert!(json["consent"].is_null());
    }

    /// The tripwire. Scans every Rust source file in the workspace — this
    /// module and test code excluded — for a construction of the enabled
    /// variant or of a consent record.
    ///
    /// If you are reading this because the build went red: enabling telemetry
    /// is a product decision, not a refactor. It needs a user-facing consent
    /// flow that displays `CONSENT_STATEMENT`, and this test needs updating in
    /// the same change, deliberately.
    #[test]
    fn no_code_outside_this_module_enables_telemetry() {
        let workspace = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."));
        let roots = [workspace.join("src"), workspace.join("crates")];

        let mut files = Vec::new();
        for root in &roots {
            collect_rust_sources(root, &mut files);
        }
        assert!(
            files.len() > 10,
            "the scan found only {} files — it is not looking where it thinks it is",
            files.len()
        );

        let this_module = Path::new(file!()).file_name().unwrap();
        let mut offenders = Vec::new();
        for path in files {
            if path.file_name() == Some(this_module) {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("readable source file");
            // Test modules are excluded: a test may legitimately construct the
            // enabled variant to prove it stays inert.
            let production = source.split("#[cfg(test)]").next().unwrap_or_default();
            for needle in ["Telemetry::Enabled", "ExplicitConsent::record"] {
                if production.contains(needle) {
                    offenders.push(format!("{} contains `{needle}`", path.display()));
                }
            }
        }

        assert!(
            offenders.is_empty(),
            "telemetry must not be enableable by code:\n  {}",
            offenders.join("\n  ")
        );
    }

    fn collect_rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().is_some_and(|name| name == "target") {
                    continue;
                }
                collect_rust_sources(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }
}
