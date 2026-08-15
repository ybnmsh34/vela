//! Making a failure that happens **before there is a window** reach the user.
//!
//! # The hole this fills
//!
//! `run()` used to end `.expect("error while running Vela")`. Every startup
//! failure — a database that will not open, a migration that will not apply, a
//! directory Vela refuses to keep conversations in — became a panic. On Linux
//! and macOS a panic prints to a terminal the user may well have. On Windows it
//! prints to a console that **does not exist**: `main.rs` carries
//!
//! ```text
//! #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! ```
//!
//! so a release build has no console attached, no stderr anyone will read, and
//! no dialog. The measured result was exit code 101 and nothing else. The
//! application simply vanished.
//!
//! That is bad for any fatal error and it is **specifically corrosive for a
//! deliberate refusal**. `DatabaseLocation::prepare` declines to open a
//! database whose directory it cannot make private, and defends that choice on
//! the grounds that refusing "fails loudly, immediately, and towards nothing
//! disclosed", with "the path and the offending principals named in the
//! message". None of that is true of a message nobody receives. A refusal the
//! user cannot distinguish from a crash is not a refusal, it is a crash with a
//! good conscience — and `docs/audit/REPORT.md` already grades this path FAIL
//! (Wave 1, B4).
//!
//! # What this is, and what it is not
//!
//! It is the minimum that makes a pre-window fatal observable: the whole error
//! chain, on stderr always, and in a native message box on Windows where stderr
//! goes nowhere. It is deliberately not a crash reporter, a log file, or a
//! recovery UI.
//!
//! It is **not** the whole of B4. B4 also covers fatals that happen after a
//! window exists, where a real dialog with a copyable body and a
//! "reveal the folder" affordance would be better than a modal `MessageBoxW`.
//! This closes the half that `prepare`'s decision rests on and no more; the
//! rest is still open and still owned by B4.

use std::error::Error;

/// Every message in an error's chain, outermost first, joined into one line.
///
/// Tauri wraps a `setup` failure in `tauri::Error::Setup`, whose own `Display`
/// is a summary; the sentence that names the folder and the accounts that can
/// reach it is further down the chain. Reporting only the outermost message
/// would show the user "setup failed" and discard the entire actionable part,
/// which is the failure mode this module exists to prevent — so the chain is
/// walked rather than trusted to have flattened itself.
///
/// A link whose text is already contained in something reported above it is
/// dropped: `Display` implementations that embed their source are common, and
/// printing the same sentence twice reads like two different faults.
pub fn describe_chain(error: &dyn Error) -> String {
    let mut parts: Vec<String> = vec![error.to_string()];
    let mut source = error.source();
    while let Some(inner) = source {
        let text = inner.to_string();
        if !parts.iter().any(|seen| seen.contains(&text)) {
            parts.push(text);
        }
        source = inner.source();
    }
    parts.join(": ")
}

/// Tell the user that Vela cannot start, and why.
///
/// Called on the way out. Never returns anything to act on: by the time this
/// runs the decision to stop has already been made, and a reporting channel
/// that could itself fail the startup would be worse than the silence it
/// replaces.
pub fn report(title: &str, body: &str) {
    // Always. On unix this is the whole mechanism, and a developer running the
    // Windows debug build from a terminal sees it too.
    eprintln!("vela: {title}\n{body}");
    show_dialog(title, body);
}

/// The Windows half. A modal box owned by no window, because there is no
/// window — that is the situation this exists for.
///
/// `MB_SETFOREGROUND | MB_TOPMOST` because the process is about to exit and a
/// dialog behind another application would be as invisible as the console.
#[cfg(windows)]
fn show_dialog(title: &str, body: &str) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_SYSTEMMODAL,
    };

    fn wide(text: &str) -> Vec<u16> {
        std::ffi::OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let caption = wide(title);
    let text = wide(body);
    // SAFETY: both pointers are NUL-terminated UTF-16 buffers that outlive the
    // call, and a null owner window is what this API takes for an unowned box.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_SYSTEMMODAL,
        );
    }
}

/// Everywhere else, `eprintln!` in [`report`] has already done the job: no
/// platform Vela ships to outside Windows detaches the process from its
/// standard error.
#[cfg(not(windows))]
fn show_dialog(_title: &str, _body: &str) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt;

    #[derive(Debug)]
    struct Layer {
        message: String,
        source: Option<Box<Layer>>,
    }

    impl fmt::Display for Layer {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(&self.message)
        }
    }

    impl Error for Layer {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            self.source.as_deref().map(|inner| inner as &dyn Error)
        }
    }

    fn layered(messages: &[&str]) -> Layer {
        let mut iter = messages.iter().rev();
        let mut current = Layer {
            message: (*iter.next().unwrap()).to_owned(),
            source: None,
        };
        for message in iter {
            current = Layer {
                message: (*message).to_owned(),
                source: Some(Box::new(current)),
            };
        }
        current
    }

    /// **The actionable sentence is at the bottom of the chain, and it is the
    /// only part worth showing.**
    ///
    /// This is the shape Tauri produces: a generic outer wrapper over the
    /// privacy refusal. What changes if `describe_chain` stops walking:
    /// the user is told "setup failed" and nothing about which folder or which
    /// account, which is the state this module was written to end.
    #[test]
    fn the_reported_text_keeps_the_innermost_cause_not_just_the_wrapper() {
        let error = layered(&[
            "setup failed",
            "the folder holding your conversations at `C:\\…\\dev.vela.desktop` \
             could not be made private to your account, so Vela did not open \
             the database",
            "windows reachable by: DESKTOP-298M5DU\\CodexSandboxUsers",
        ]);

        let reported = describe_chain(&error);

        assert!(reported.contains("setup failed"));
        assert!(reported.contains("dev.vela.desktop"), "{reported}");
        assert!(
            reported.contains("CodexSandboxUsers"),
            "the accounts that can reach the folder are the actionable half and \
             they were dropped: {reported}"
        );
    }

    /// A `Display` that already embeds its source must not be printed twice.
    #[test]
    fn a_cause_already_quoted_by_its_wrapper_is_not_repeated() {
        let error = layered(&["outer: inner detail", "inner detail"]);
        let reported = describe_chain(&error);
        assert_eq!(reported, "outer: inner detail");
    }

    #[test]
    fn an_error_with_no_source_reports_its_own_message() {
        let error = layered(&["the disk is full"]);
        assert_eq!(describe_chain(&error), "the disk is full");
    }
}
