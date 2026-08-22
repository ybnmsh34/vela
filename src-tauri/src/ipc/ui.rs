//! `ui_*` commands — the small amount of window layout that must survive a
//! restart.
//!
//! ## Why this is a command and not a browser `localStorage` write
//!
//! Vela is a desktop app whose system of record is the user's own SQLite file.
//! A sidebar the user dragged to 340px is part of how their workspace looks, and
//! putting it in webview storage would mean it lives somewhere the user cannot
//! back up, cannot inspect, and loses when the webview's profile is cleared.
//! Conventions §1: "a user-configurable setting … never a second database".
//!
//! ## Why a typed command and not a generic settings key/value pair
//!
//! Conventions §3.4 prefers a narrow command over a blanket grant. A
//! `settings_put(key, value)` reachable from the renderer would be an arbitrary
//! write primitive into the system of record; `ui_set_layout` can only ever
//! write two clamped numbers under one key.
//!
//! Out-of-range values are **clamped, not rejected**. A width is a preference,
//! not an assertion — and a renderer that reopens on a smaller display should
//! get a usable sidebar rather than an error dialog.

use serde::{Deserialize, Serialize};
use tauri::State;
use vela_store::{SettingEntry, VelaStore};

use super::{EmptyPayload, IpcResult};
use crate::store_host::StoreHandle;

/// The settings key this layout lives under. One row, one JSON object.
const LAYOUT_KEY: &str = "ui.layout";

pub const MIN_SIDEBAR_WIDTH: u32 = 200;
pub const MAX_SIDEBAR_WIDTH: u32 = 480;
pub const DEFAULT_SIDEBAR_WIDTH: u32 = 280;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLayout {
    pub sidebar_width: u32,
    /// Collapsed keeps the width: expanding restores what the user chose rather
    /// than snapping back to the default.
    pub sidebar_collapsed: bool,
}

impl Default for UiLayout {
    fn default() -> Self {
        Self {
            sidebar_width: DEFAULT_SIDEBAR_WIDTH,
            sidebar_collapsed: false,
        }
    }
}

impl UiLayout {
    pub fn clamped(self) -> Self {
        Self {
            sidebar_width: self
                .sidebar_width
                .clamp(MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
            sidebar_collapsed: self.sidebar_collapsed,
        }
    }
}

pub fn get(store: &dyn VelaStore, _payload: EmptyPayload) -> IpcResult<UiLayout> {
    let stored = store.get_setting(LAYOUT_KEY)?;
    let Some(setting) = stored else {
        return Ok(UiLayout::default());
    };
    // A row written by a different build, or edited by hand, must not stop the
    // window from opening. The default is always a usable answer.
    Ok(serde_json::from_value::<UiLayout>(setting.value)
        .map(UiLayout::clamped)
        .unwrap_or_default())
}

pub fn set(store: &dyn VelaStore, payload: UiLayout) -> IpcResult<UiLayout> {
    let layout = payload.clamped();
    let value = serde_json::to_value(layout).map_err(|error| {
        super::IpcError::new(
            super::IpcErrorCode::Internal,
            format!("layout is not serialisable: {error}"),
        )
    })?;
    store.put_setting(SettingEntry::new(LAYOUT_KEY, value))?;
    Ok(layout)
}

#[tauri::command]
pub fn ui_get_layout(store: State<'_, StoreHandle>, payload: EmptyPayload) -> IpcResult<UiLayout> {
    get(store.store(), payload)
}

#[tauri::command]
pub fn ui_set_layout(store: State<'_, StoreHandle>, payload: UiLayout) -> IpcResult<UiLayout> {
    set(store.store(), payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_store::{DatabaseLocation, SettingsRepository, SqliteStore};

    fn store() -> SqliteStore {
        SqliteStore::open(DatabaseLocation::InMemory).expect("in-memory store opens")
    }

    #[test]
    fn an_unconfigured_workspace_gets_a_usable_default() {
        let store = store();
        let layout = get(&store, EmptyPayload::default()).unwrap();
        assert_eq!(layout.sidebar_width, DEFAULT_SIDEBAR_WIDTH);
        assert!(!layout.sidebar_collapsed);
    }

    #[test]
    fn a_width_the_user_dragged_survives_a_restart() {
        let store = store();
        set(
            &store,
            UiLayout {
                sidebar_width: 340,
                sidebar_collapsed: false,
            },
        )
        .unwrap();

        assert_eq!(
            get(&store, EmptyPayload::default()).unwrap().sidebar_width,
            340
        );
    }

    #[test]
    fn collapsing_keeps_the_width_so_expanding_restores_it() {
        let store = store();
        set(
            &store,
            UiLayout {
                sidebar_width: 400,
                sidebar_collapsed: true,
            },
        )
        .unwrap();

        let layout = get(&store, EmptyPayload::default()).unwrap();
        assert!(layout.sidebar_collapsed);
        assert_eq!(layout.sidebar_width, 400);
    }

    #[test]
    fn an_out_of_range_width_is_clamped_rather_than_refused() {
        let store = store();
        assert_eq!(
            set(
                &store,
                UiLayout {
                    sidebar_width: 9999,
                    sidebar_collapsed: false
                }
            )
            .unwrap()
            .sidebar_width,
            MAX_SIDEBAR_WIDTH
        );
        assert_eq!(
            set(
                &store,
                UiLayout {
                    sidebar_width: 0,
                    sidebar_collapsed: false
                }
            )
            .unwrap()
            .sidebar_width,
            MIN_SIDEBAR_WIDTH
        );
    }

    #[test]
    fn a_layout_row_written_by_something_else_does_not_stop_the_window_opening() {
        let store = store();
        store
            .put_setting(SettingEntry::new(
                LAYOUT_KEY,
                serde_json::json!("not an object"),
            ))
            .unwrap();

        assert_eq!(
            get(&store, EmptyPayload::default()).unwrap(),
            UiLayout::default()
        );
    }
}
