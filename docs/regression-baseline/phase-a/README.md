# Regression baseline — Phase A

The first working screen. Anything that breaks these must be caught.

| Screenshot | What it shows |
|---|---|
| `app-shell-light.png` | App shell, light theme, 1180×780 |
| `app-shell-dark.png` | App shell, dark theme (`prefers-color-scheme: dark`), 1180×780 |

**How they were produced — read this before citing them.**

`pnpm dev` (Vite on `127.0.0.1:1420`) rendered in headless Chromium
(playwright-core, `chromium-headless-shell` 151), waiting on the "Bridge ready"
status line. Zero console errors in both themes.

**What they are evidence of:** the renderer, the theme tokens, the layout, and a
completed round trip through the platform seam.

**What they are NOT evidence of:** the packaged Tauri application. This is the
web frontend running against `BrowserAdapter`, the in-memory fake host — which
is why the screen itself prints `browser` and
`memory-fake (not a real keychain)`. No native window chrome, no OS keychain, no
model endpoint was involved. See `docs/architecture/conventions.md` §10–§11.

Working flows as of Phase A:
1. App shell renders, light and dark, with theme cycling from the title bar.
2. `app_info` + `diagnostics_echo` round-trip through the adapter and are
   reported in the UI.
3. Host failure is surfaced as "Bridge unavailable · <code>" rather than an
   empty screen.
