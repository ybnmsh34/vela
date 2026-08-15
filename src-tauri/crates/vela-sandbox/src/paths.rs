//! Path resolution, and the three ways it is usually got wrong.
//!
//! 1. **Checking the string the caller sent.** `SANDBOX_PROTECTED_ROOTS` says
//!    the check happens against the *resolved* path — symlinks, `..`, `~`,
//!    Windows short names, the lot — because checking the unresolved string is
//!    the classic bypass and it is one line of code away at all times.
//!    [`resolve_host_directory`] canonicalises first and there is no path
//!    through this module that does not.
//! 2. **Comparing paths as strings.** `C:\Users\x` is not a prefix of
//!    `C:\Users\xylophone` in any sense that matters, but it is one to
//!    `starts_with` on a string. [`is_within`] compares components.
//! 3. **Comparing them case-sensitively on Windows.** `c:\users\x` and
//!    `C:\Users\X` are the same directory, and a protected-root check that
//!    missed that would be defeated by pressing shift.
//!
//! The window between resolving a path and using it is a real TOCTOU gap that
//! nothing in this module closes. What closes it is that the resolved path is
//! bind-mounted into a mount namespace once, at start-up, and the run never
//! names a path again — see [`crate::wsl`].

use std::path::{Component, Path, PathBuf};

/// Resolve a caller-supplied host path to a real, existing directory.
///
/// A path that does not resolve is not an `AbsolutePath` in the sense
/// `src/platform/contract-project.ts` defines, so the payload is malformed
/// rather than refusable: there is no member of `RefusalReason` for "that
/// directory is not there", and inventing one by reusing a neighbouring member
/// would put a wrong sentence in front of the user.
pub fn resolve_host_directory(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("mount hostPath is empty".into());
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(format!("mount hostPath is not absolute: {raw}"));
    }
    let resolved =
        std::fs::canonicalize(path).map_err(|_| format!("mount hostPath does not resolve"))?;
    if !resolved.is_dir() {
        return Err("mount hostPath is not a directory".into());
    }
    Ok(strip_verbatim(&resolved))
}

/// `\\?\C:\x` is what `canonicalize` answers on Windows. Every consumer here
/// wants `C:\x`, and the prefix leaks into the guest path translation if it is
/// left on.
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path.to_path_buf(),
    }
}

/// Is `child` the same directory as `ancestor`, or inside it?
///
/// Component-wise and case-insensitive, for the reasons in the module note.
pub fn is_within(child: &Path, ancestor: &Path) -> bool {
    let mut a = ancestor.components();
    let mut c = child.components();
    loop {
        match (a.next(), c.next()) {
            (None, _) => return true,
            (Some(_), None) => return false,
            (Some(x), Some(y)) => {
                if !components_equal(x, y) {
                    return false;
                }
            }
        }
    }
}

fn components_equal(a: Component<'_>, b: Component<'_>) -> bool {
    a.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
}

/// `C:\Users\x` → `/mnt/c/Users/x`, which is where WSL puts the Windows drives.
///
/// This is the *only* place a Windows path becomes a guest path, and the guest
/// script uses it exactly once — to bind the directory somewhere else — before
/// `/mnt` is replaced by an empty read-only tmpfs. After that point the path
/// this function produces does not exist inside the run.
pub fn windows_path_to_wsl(path: &Path) -> Result<String, String> {
    let text = path.to_string_lossy().replace('\\', "/");
    let bytes = text.as_bytes();
    if bytes.len() < 3 || bytes[1] != b':' || bytes[2] != b'/' || !bytes[0].is_ascii_alphabetic() {
        return Err(format!(
            "only local drive paths can be mounted; `{text}` is not one"
        ));
    }
    let drive = (bytes[0] as char).to_ascii_lowercase();
    let rest = &text[3..];
    Ok(format!("/mnt/{drive}/{rest}"))
}

/// An absolute POSIX path with no traversal in it, and nothing a shell or a
/// mount table would misread.
///
/// `..` is rejected rather than normalised. Normalising it here would mean this
/// function and the kernel disagree about what the path names the moment a
/// symlink is involved, and the kernel is the one that decides.
pub fn validate_guest_path(raw: &str) -> Result<(), String> {
    if !raw.starts_with('/') {
        return Err(format!("guest path must be absolute POSIX: {raw}"));
    }
    if raw.len() > 1024 {
        return Err("guest path is too long".into());
    }
    if raw.contains('\0') || raw.contains('\n') || raw.contains('\r') {
        return Err("guest path contains a control character".into());
    }
    for segment in raw.split('/') {
        if segment == ".." {
            return Err(format!("guest path contains a `..` component: {raw}"));
        }
    }
    let trimmed = raw.trim_end_matches('/');
    // `/vela` is the run's own tmpfs and `/mnt` is the door the guest script
    // closes; the rest is the distribution the run borrows. A grant placed on
    // any of them would be mounted over by the setup that follows it, so the
    // caller would get a directory it named and did not receive — which is the
    // silently-ignored field this contract calls a lie in the shape of a
    // success. Refusing is the only honest answer, and it is a malformed
    // request rather than a refusal because no `RefusalReason` describes it.
    if trimmed.is_empty() || trimmed == "/vela" {
        return Err(format!("guest path is reserved by the host: {raw}"));
    }
    for reserved in RESERVED_GUEST_ROOTS {
        if trimmed == reserved || trimmed.starts_with(&format!("{reserved}/")) {
            return Err(format!("guest path is inside a reserved root: {raw}"));
        }
    }
    Ok(())
}

/// Guest roots a grant may not be placed on or inside.
const RESERVED_GUEST_ROOTS: [&str; 12] = [
    "/proc", "/sys", "/dev", "/mnt", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot",
    "/run",
];

/// Do two guest paths name the same subtree, or nest one inside the other?
///
/// Overlapping grants make "which mode applies here" a question with two
/// answers, and the answer picked under time pressure is the permissive one.
pub fn guest_paths_overlap(a: &str, b: &str) -> bool {
    let a = a.trim_end_matches('/');
    let b = b.trim_end_matches('/');
    if a == b {
        return true;
    }
    let nests = |outer: &str, inner: &str| {
        let outer = if outer.is_empty() { "/" } else { outer };
        inner.starts_with(outer)
            && (outer.ends_with('/') || inner.as_bytes().get(outer.len()) == Some(&b'/'))
    };
    nests(a, b) || nests(b, a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn containment_is_component_wise_and_not_a_string_prefix() {
        let root = Path::new(r"C:\Users\x");
        assert!(is_within(Path::new(r"C:\Users\x\deep\deeper"), root));
        assert!(is_within(Path::new(r"C:\Users\x"), root));
        // The bug this exists for: `C:\Users\xylophone` starts with `C:\Users\x`.
        assert!(!is_within(Path::new(r"C:\Users\xylophone"), root));
        assert!(!is_within(Path::new(r"C:\Users"), root));
    }

    #[test]
    fn containment_ignores_case_because_windows_does() {
        assert!(is_within(
            Path::new(r"c:\users\X\THING"),
            Path::new(r"C:\Users\x")
        ));
    }

    #[test]
    fn a_windows_drive_path_becomes_the_wsl_drive_mount() {
        assert_eq!(
            windows_path_to_wsl(Path::new(r"C:\Users\User\proj")).expect("translates"),
            "/mnt/c/Users/User/proj"
        );
        assert_eq!(
            windows_path_to_wsl(Path::new(r"D:\data")).expect("translates"),
            "/mnt/d/data"
        );
        assert!(windows_path_to_wsl(Path::new(r"\\server\share")).is_err());
    }

    #[test]
    fn guest_paths_reject_traversal_and_control_characters() {
        assert!(validate_guest_path("/vela/work").is_ok());
        assert!(validate_guest_path("relative").is_err());
        assert!(validate_guest_path("/vela/../etc").is_err());
        assert!(validate_guest_path("/vela/\nrm").is_err());
    }

    #[test]
    fn a_grant_may_not_be_placed_where_the_host_is_about_to_mount() {
        for reserved in ["/", "/vela", "/mnt", "/mnt/c", "/proc/self", "/etc"] {
            assert!(
                validate_guest_path(reserved).is_err(),
                "`{reserved}` would be mounted over by the guest setup, and the \
                 caller would get a directory it named and did not receive"
            );
        }
        assert!(validate_guest_path("/vela/work").is_ok());
        assert!(validate_guest_path("/work").is_ok());
    }

    #[test]
    fn overlap_catches_nesting_in_both_directions_but_not_siblings() {
        assert!(guest_paths_overlap("/a", "/a/b"));
        assert!(guest_paths_overlap("/a/b", "/a"));
        assert!(guest_paths_overlap("/a", "/a"));
        assert!(!guest_paths_overlap("/a", "/ab"));
        assert!(!guest_paths_overlap("/a/b", "/a/c"));
    }
}
