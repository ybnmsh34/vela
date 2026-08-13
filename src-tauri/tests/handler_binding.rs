//! **The dispatch table and the allowlist, actually bound to each other.**
//!
//! `lib.rs` used to carry this sentence:
//!
//! > The `generate_handler!` list and [`ipc::COMMAND_ALLOWLIST`] must agree —
//! > `cargo test` enforces it.
//!
//! No test enforced it. `ipc/mod.rs` said the same thing in different words,
//! and `src/platform/contract.ts` repeated it to the renderer side. What
//! actually existed was a test comparing the Rust allowlist to the TypeScript
//! allowlist — two *declarations* agreeing with each other, neither of them the
//! thing that decides reachability. `generate_handler!` is the only list the
//! packaged binary consults: a command could sit in `COMMAND_ALLOWLIST`, have a
//! TypeScript type, satisfy the parity fixture, and still answer
//! `Command … not found` in the shipped app. That is this project's recurring
//! defect exactly — built, tested in isolation, never connected — and here it
//! wore a comment claiming the opposite.
//!
//! ## How this file decides, and why it is not another grep
//!
//! Reachability is not read out of the source at all. [`Probe`] builds the real
//! application with [`vela_lib::configure`] — the same function `run()` calls —
//! on `tauri::test`'s mock runtime, and asks the assembled `invoke_handler`
//! itself, one command name at a time, through `tauri://localhost`. The answer
//! comes from the macro's own dispatch table. Tauri rejects an unregistered
//! command with the exact string `Command {name} not found`
//! (`tauri::webview::Webview::on_message`), and
//! [`the_probe_can_tell_a_registered_command_from_an_unregistered_one`] pins
//! that signal in both directions so these tests cannot pass vacuously.
//!
//! That settles one direction — *allowlisted but unregistered* — with no source
//! reading whatsoever. The other direction, *registered but not allowlisted*,
//! needs the set of names worth probing, because nothing can enumerate a
//! `macro_rules!` argument list at runtime. So the candidate universe is
//! derived from the source, with `syn` — a real Rust parser, not a substring
//! scan. Anything named in `generate_handler!` must be a `#[tauri::command]`
//! function in this crate (nothing else compiles there), so *every*
//! `#[tauri::command]` in `src/` is a candidate, the handler is asked about
//! each, and the reachable set is compared to the allowlist. The verdict still
//! comes from the running app; the parser only decides what to ask about.
//!
//! Parsing rather than grepping is not fastidiousness — the substring answer is
//! **wrong on this tree**. `src/ipc/mod.rs` documents the command pattern with
//! a worked example that declares `thing_do`, inside a doc comment:
//!
//! ```text
//! //! #[tauri::command]
//! //! pub fn thing_do(state: State<'_, AppState>, payload: ThingDoReq) …
//! ```
//!
//! `grep -r '#\[tauri::command\]' src/` reports 29 commands here; 28 exist.
//! A guard built on that grep would have to be taught to ignore its own
//! documentation, and would quietly rot the next time someone wrote an example.
//! [`the_parser_reads_code_and_not_comments_or_string_literals`] proves the
//! parser is not fooled by either.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde_json::{json, Value};
use syn::visit::Visit;
use tauri::test::{mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindow};

use vela_lib::ipc::COMMAND_ALLOWLIST;

/* ========================================================================== */
/* the source-derived sets — a real parse, never a substring scan             */
/* ========================================================================== */

/// The crate root, so every path here is absolute and independent of the
/// directory `cargo test` happens to run from.
fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn parse(source: &str, what: &str) -> syn::File {
    syn::parse_file(source).unwrap_or_else(|e| panic!("{what} must be parseable Rust: {e}"))
}

/// Is this attribute `#[tauri::command]` (or `#[command]` under a `use
/// tauri::command`)? Deliberately narrow: an unrelated `#[foo::command]` is not
/// a Tauri command and must not widen the candidate set.
fn is_tauri_command(attr: &syn::Attribute) -> bool {
    let segments: Vec<String> = attr
        .path()
        .segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect();
    match segments.as_slice() {
        [only] => only == "command",
        [first, second] => first == "tauri" && second == "command",
        _ => false,
    }
}

/// One `#[tauri::command]` function as the parser found it: its name, and its
/// arguments as `(binding name, head of the type)`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CommandSignature {
    name: String,
    args: Vec<(String, String)>,
}

/// The head of a type — `State<'_, AppState>` → `State`, `&AppHandle<R>` →
/// `AppHandle`, `EmptyPayload` → `EmptyPayload`. Enough to tell a Tauri
/// extractor from the one argument that carries the renderer's JSON.
fn type_head(ty: &syn::Type) -> String {
    match ty {
        syn::Type::Reference(reference) => type_head(&reference.elem),
        syn::Type::Path(path) => path
            .path
            .segments
            .last()
            .map(|segment| segment.ident.to_string())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// Every function carrying `#[tauri::command]` in one file, at any nesting
/// depth — `syn::visit` descends into inline `mod` blocks for us.
#[derive(Default)]
struct DeclaredCommands {
    commands: Vec<CommandSignature>,
}

impl<'ast> Visit<'ast> for DeclaredCommands {
    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        if node.attrs.iter().any(is_tauri_command) {
            let args = node
                .sig
                .inputs
                .iter()
                .filter_map(|arg| match arg {
                    syn::FnArg::Typed(typed) => match typed.pat.as_ref() {
                        syn::Pat::Ident(ident) => {
                            Some((ident.ident.to_string(), type_head(&typed.ty)))
                        }
                        // A destructured or wildcard parameter cannot be named
                        // `payload`, so it is recorded as unnamed and the
                        // call-shape test rejects it.
                        _ => Some((String::new(), type_head(&typed.ty))),
                    },
                    syn::FnArg::Receiver(_) => None,
                })
                .collect();
            self.commands.push(CommandSignature {
                name: node.sig.ident.to_string(),
                args,
            });
        }
        syn::visit::visit_item_fn(self, node);
    }
}

fn command_sigs_in(source: &str, what: &str) -> Vec<CommandSignature> {
    let mut finder = DeclaredCommands::default();
    finder.visit_file(&parse(source, what));
    finder.commands
}

fn command_fns_in(source: &str, what: &str) -> BTreeSet<String> {
    command_sigs_in(source, what)
        .into_iter()
        .map(|command| command.name)
        .collect()
}

/// Every `.rs` file under a directory, sorted so failures read the same way
/// twice.
fn rust_sources(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("a readable directory entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}

/// Every command this crate *defines*. A command named in `generate_handler!`
/// must be one of these: `#[tauri::command]` needs the `tauri` crate, and
/// `vela-app` is the only crate in the workspace that depends on it.
fn declared_signatures() -> Vec<CommandSignature> {
    let mut commands = Vec::new();
    for file in rust_sources(&crate_dir().join("src")) {
        let source = std::fs::read_to_string(&file)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", file.display()));
        commands.extend(command_sigs_in(&source, &file.display().to_string()));
    }
    assert!(
        !commands.is_empty(),
        "the parser found no `#[tauri::command]` at all under src/ — it has \
         stopped matching what this crate writes, and every test in this file \
         would now pass without checking anything"
    );
    commands
}

fn declared_commands() -> BTreeSet<String> {
    declared_signatures()
        .into_iter()
        .map(|command| command.name)
        .collect()
}

/// The command names inside `generate_handler![…]`, extracted from the one
/// `invoke_handler` call in the composition root.
///
/// `visit_expr_method_call` reaches the call wherever it sits in the builder
/// chain, and the macro body is parsed as a punctuated list of Rust paths — so
/// `ipc::app::app_info` yields `app_info`, the same last segment
/// `#[tauri::command]` uses as the wire name.
#[derive(Default)]
struct RegisteredCommands {
    /// One entry per `invoke_handler` call site; more than one is itself a
    /// finding, so they are kept apart rather than merged.
    call_sites: Vec<BTreeSet<String>>,
}

impl<'ast> Visit<'ast> for RegisteredCommands {
    fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
        if node.method == "invoke_handler" {
            let mut args = node.args.iter();
            let (Some(syn::Expr::Macro(handler)), None) = (args.next(), args.next()) else {
                panic!(
                    "`invoke_handler` must be called with exactly one argument and that \
                     argument must be a `generate_handler![…]` invocation, or this test \
                     cannot see what the shipped binary registers"
                );
            };
            let macro_name = handler
                .mac
                .path
                .segments
                .last()
                .expect("a macro path has at least one segment")
                .ident
                .to_string();
            assert_eq!(
                macro_name, "generate_handler",
                "the argument to `invoke_handler` must be `generate_handler!`"
            );

            let paths = handler
                .mac
                .parse_body_with(
                    syn::punctuated::Punctuated::<syn::Path, syn::Token![,]>::parse_terminated,
                )
                .expect("the `generate_handler!` body must be a comma-separated path list");
            self.call_sites.push(
                paths
                    .iter()
                    .map(|path| {
                        path.segments
                            .last()
                            .expect("a command path has at least one segment")
                            .ident
                            .to_string()
                    })
                    .collect(),
            );
        }
        syn::visit::visit_expr_method_call(self, node);
    }
}

fn registered_in(source: &str, what: &str) -> Vec<BTreeSet<String>> {
    let mut finder = RegisteredCommands::default();
    finder.visit_file(&parse(source, what));
    finder.call_sites
}

fn composition_root() -> String {
    let path = crate_dir().join("src/lib.rs");
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// The single registered set, with the "exactly one call site" rule enforced on
/// the way past — two `invoke_handler` calls would mean a second, undeclared
/// surface, and the last one silently wins in Tauri.
fn registered_commands() -> BTreeSet<String> {
    let mut sites = registered_in(&composition_root(), "src/lib.rs");
    assert_eq!(
        sites.len(),
        1,
        "src/lib.rs must contain exactly one `invoke_handler(generate_handler![…])` \
         call — found {}. Commands registered anywhere else are reachable without \
         appearing in the list this test checks",
        sites.len()
    );
    sites.pop().expect("exactly one call site")
}

fn allowlist() -> BTreeSet<String> {
    COMMAND_ALLOWLIST.iter().map(|s| (*s).to_owned()).collect()
}

fn listed(names: &BTreeSet<String>) -> String {
    if names.is_empty() {
        "(none)".to_owned()
    } else {
        names.iter().cloned().collect::<Vec<_>>().join(", ")
    }
}

/* ========================================================================== */
/* the running app — reachability answered by the shipped dispatch table      */
/* ========================================================================== */

/// Serialises application construction: `setup` resolves the app-data directory
/// through `XDG_DATA_HOME`, which is process-global. Same reason as
/// `tests/gate_m_assembled_app.rs`.
fn build_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What the assembled application did with a command name.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Dispatch {
    /// The dispatch table owns this name. It ran, or it refused the payload —
    /// either way the renderer can reach it.
    Reached,
    /// The dispatch table has never heard of it. This is what an allowlisted
    /// command that nobody registered looks like to a user.
    NotFound,
}

/// One assembled Vela, built the way `run()` builds it.
struct Probe {
    /// Owns the runtime for as long as the probe lives; never read directly.
    _app: tauri::App<tauri::test::MockRuntime>,
    webview: WebviewWindow<tauri::test::MockRuntime>,
    /// Keeps the data directory alive for the app's lifetime.
    _home: tempfile::TempDir,
}

impl Probe {
    fn start() -> Self {
        let home = tempfile::tempdir().expect("a temporary data home");
        let app = {
            let _guard = build_lock();
            std::env::set_var("XDG_DATA_HOME", home.path());
            let mut app = vela_lib::configure(mock_builder())
                .build(tauri::generate_context!())
                .expect("the shipping composition root must assemble");
            // `build` does not run `setup`; one event-loop iteration does, and
            // that is what the shipping process does on its first turn.
            #[allow(deprecated)]
            app.run_iteration(|_, _| {});
            app
        };
        let webview = app
            .get_webview_window("main")
            .expect("the main window from tauri.conf.json");
        Self {
            _app: app,
            webview,
            _home: home,
        }
    }

    /// Asks the assembled `invoke_handler` about one name, from the app's own
    /// origin, in the renderer's own envelope.
    ///
    /// The payload is deliberately `{}` for every command: a registered command
    /// that wants fields rejects it with a deserialisation error, which is
    /// still [`Dispatch::Reached`]. The only answer that means *unregistered*
    /// is Tauri's own `Command {name} not found`.
    fn dispatch(&self, command: &str) -> Dispatch {
        let response = tauri::test::get_ipc_response(
            &self.webview,
            InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(json!({ "payload": {} })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        );
        match response {
            Ok(_) => Dispatch::Reached,
            Err(error) => {
                let rejection = serde_json::to_value(&error).unwrap_or(Value::Null);
                if rejection == Value::String(format!("Command {command} not found")) {
                    Dispatch::NotFound
                } else {
                    Dispatch::Reached
                }
            }
        }
    }
}

/* ========================================================================== */
/* 1 — the control, first: the probe must be able to say both words           */
/* ========================================================================== */

/// **Without this test the two below are decoration.** If `dispatch` returned
/// `Reached` for everything — a changed Tauri rejection message would do it —
/// "every allowlisted command is reachable" would pass on an app that
/// registered nothing at all.
#[test]
fn the_probe_can_tell_a_registered_command_from_an_unregistered_one() {
    let probe = Probe::start();

    // A name that is in the allowlist, in `generate_handler!`, and answers.
    assert_eq!(
        probe.dispatch("app_info"),
        Dispatch::Reached,
        "`app_info` is registered and must be seen as reachable"
    );

    // A name shaped exactly like a Vela command that nobody ever wrote.
    assert_eq!(
        probe.dispatch("secrets_get"),
        Dispatch::NotFound,
        "an unregistered command must be seen as unreachable — if this fails, \
         the probe has lost the ability to detect the defect it exists for"
    );

    // A registered command refusing a payload it cannot deserialise is still
    // reachable: the distinction under test is registration, not validity.
    assert_eq!(
        probe.dispatch("secrets_set"),
        Dispatch::Reached,
        "`secrets_set` rejects `{{}}` as a payload, but it is registered, and a \
         payload error must never be mistaken for an unregistered command"
    );
}

/* ========================================================================== */
/* 2 — the two directions                                                     */
/* ========================================================================== */

/// **Direction one: allowlisted but never registered.**
///
/// The failing shape this test exists for: a command is added to
/// `COMMAND_ALLOWLIST` and to `src/platform/contract.ts`, the parity test goes
/// green, the renderer calls it, and the packaged app answers `not found`.
/// Nothing here reads Rust source — the assembled application answers.
#[test]
fn every_allowlisted_command_is_reachable_in_the_assembled_app() {
    let probe = Probe::start();

    let unreachable: BTreeSet<String> = allowlist()
        .into_iter()
        .filter(|command| probe.dispatch(command) == Dispatch::NotFound)
        .collect();

    assert!(
        unreachable.is_empty(),
        "these commands are in COMMAND_ALLOWLIST but the assembled app answers \
         `Command … not found` for them: {}.\nThey are unreachable in the \
         packaged binary. Add them to `generate_handler!` in src/lib.rs — that \
         list, and only that list, decides what ships.",
        listed(&unreachable)
    );
}

/// **Direction two: registered but never allowlisted.**
///
/// A command reachable from the renderer without appearing in the list this
/// project calls "the security boundary", without a TypeScript type, and
/// without ever having been reviewed as part of the surface.
///
/// The candidate set is every `#[tauri::command]` in the crate — a superset of
/// anything `generate_handler!` can name — and each candidate's reachability is
/// decided by the running app, not by the parse.
#[test]
fn no_command_is_reachable_that_the_allowlist_does_not_declare() {
    let probe = Probe::start();
    let allowlist = allowlist();

    let undeclared: BTreeSet<String> = declared_commands()
        .into_iter()
        .filter(|command| !allowlist.contains(command))
        .filter(|command| probe.dispatch(command) == Dispatch::Reached)
        .collect();

    assert!(
        undeclared.is_empty(),
        "these commands are reachable from the renderer but absent from \
         COMMAND_ALLOWLIST: {}.\nThe allowlist is supposed to *be* the IPC \
         surface. A command registered in `generate_handler!` and left out of \
         it is an unreviewed, untyped door into the host.",
        listed(&undeclared)
    );
}

/* ========================================================================== */
/* 3 — the source-level cross-checks that keep the probe honest               */
/* ========================================================================== */

/// The same two directions again, at the source level, comparing the parsed
/// `generate_handler!` list to the allowlist as sets.
///
/// Not redundant with the two runtime tests: it names the *registration* as the
/// thing that drifted, in the file the fix belongs in, and it fails on a
/// machine where no app can be built.
#[test]
fn the_registered_handler_list_and_the_allowlist_are_the_same_set() {
    let registered = registered_commands();
    let allowlist = allowlist();

    let missing_from_handler: BTreeSet<String> =
        allowlist.difference(&registered).cloned().collect();
    let missing_from_allowlist: BTreeSet<String> =
        registered.difference(&allowlist).cloned().collect();

    assert!(
        missing_from_handler.is_empty(),
        "in COMMAND_ALLOWLIST but not in `generate_handler!` (so: unreachable \
         in the shipped app): {}",
        listed(&missing_from_handler)
    );
    assert!(
        missing_from_allowlist.is_empty(),
        "in `generate_handler!` but not in COMMAND_ALLOWLIST (so: reachable and \
         undeclared): {}",
        listed(&missing_from_allowlist)
    );
}

/// Guards the candidate universe that
/// [`no_command_is_reachable_that_the_allowlist_does_not_declare`] probes. If a
/// registered path named something the `#[tauri::command]` scan never found,
/// that scan has a blind spot, and the reverse direction would be checking a
/// set with a hole in it.
#[test]
fn every_registered_command_is_one_the_parser_also_found_declared() {
    let declared = declared_commands();
    let unknown: BTreeSet<String> = registered_commands()
        .into_iter()
        .filter(|command| !declared.contains(command))
        .collect();

    assert!(
        unknown.is_empty(),
        "`generate_handler!` registers {} which the `#[tauri::command]` scan of \
         src/ did not find. Either the command lives somewhere the scan does \
         not walk, or the scan no longer matches how commands are written — \
         both leave the reverse-direction test probing an incomplete set",
        listed(&unknown)
    );
}

/// A `#[tauri::command]` that is never registered is dead weight at best and a
/// half-connected feature at worst — this project's whole failure mode. There
/// is no third state: a command exists, or it does not.
#[test]
fn the_crate_declares_no_command_it_does_not_expose() {
    let allowlist = allowlist();
    let orphans: BTreeSet<String> = declared_commands()
        .into_iter()
        .filter(|command| !allowlist.contains(command))
        .collect();

    assert!(
        orphans.is_empty(),
        "these `#[tauri::command]` functions exist in src/ but are not in \
         COMMAND_ALLOWLIST: {}.\nEither expose them (allowlist + \
         `generate_handler!` + src/platform/contract.ts) or delete them; a \
         command nobody can call is the same defect this file exists to catch, \
         one step earlier",
        listed(&orphans)
    );
}

/* ========================================================================== */
/* 4 — the parser's own controls                                              */
/* ========================================================================== */

/// **Why this is a parse and not a grep.**
///
/// `src/ipc/mod.rs` really does contain the text `#[tauri::command]` followed
/// by `pub fn thing_do(…)` — in the module documentation, as the worked example
/// every new command is written against. A substring guard counts it. This one
/// must not, and must also ignore a name in a string literal, while still
/// seeing the real declaration underneath both.
#[test]
fn the_parser_reads_code_and_not_comments_or_string_literals() {
    let decoys = r##"
        //! #[tauri::command]
        //! pub fn thing_do(payload: ThingDoReq) -> IpcResult<ThingDoRes> {}

        /// #[tauri::command]
        /// pub fn from_a_doc_comment(payload: Req) {}
        pub fn ordinary(name: &str) -> &str {
            let _ = "#[tauri::command] pub fn from_a_string_literal() {}";
            // #[tauri::command] pub fn from_a_line_comment() {}
            name
        }

        #[tauri::command]
        pub fn genuinely_declared(payload: Req) -> IpcResult<Res> { todo!() }

        #[some_other::command]
        pub fn not_a_tauri_command(payload: Req) {}

        mod nested {
            #[tauri::command]
            pub fn declared_inside_a_module(payload: Req) {}
        }
    "##;

    let found = command_fns_in(decoys, "the decoy fixture");
    assert_eq!(
        found,
        ["declared_inside_a_module", "genuinely_declared"]
            .into_iter()
            .map(str::to_owned)
            .collect::<BTreeSet<_>>(),
        "the scan must see exactly the two real declarations — not the doc \
         comment, not the line comment, not the string literal, not the \
         attribute from another crate"
    );

    // And the live proof, on the tree itself: the documented example command is
    // absent from the parsed set even though its text is in the file.
    let mod_rs =
        std::fs::read_to_string(crate_dir().join("src/ipc/mod.rs")).expect("src/ipc/mod.rs");
    assert!(
        mod_rs.contains("pub fn thing_do("),
        "this control depends on ipc/mod.rs documenting `thing_do`; if the \
         example was renamed, re-point it rather than deleting the control"
    );
    assert!(
        !declared_commands().contains("thing_do"),
        "`thing_do` is a documentation example, not a command — a guard that \
         counts it is reading text, not code"
    );
}

/* ========================================================================== */
/* 5 — the OTHER claim in this repo that nothing was enforcing                 */
/* ========================================================================== */

/// **The second unenforced guarantee, found by sweeping for the first.**
///
/// `ipc/mod.rs` and `docs/architecture/conventions.md` §3.1 both say it, twice
/// each, in the strongest language either document uses:
///
/// > **One argument, always named `payload`.** The TS adapter wraps every call
/// > as `invoke(name, { payload })`, so a differently-named argument silently
/// > arrives as `undefined`. **There is no exception to this rule.**
///
/// Nothing enforced that either. It is the same defect class as the one this
/// file was opened for and it fails the same way — silently, at runtime, in the
/// user's hands. `#[tauri::command]` matches arguments by *name* against the
/// JSON object it is handed, so renaming `payload` to `req` compiles cleanly,
/// passes every unit test of the underlying plain function, and then hands the
/// command `undefined` for its one input in the shipped app.
///
/// The rule as checked here: every command takes exactly one argument that is
/// not a Tauri extractor, and that argument is named `payload`. Extractors are
/// matched by type head, so a new one Tauri gains — or a second domain
/// argument, which is just as broken — fails this test rather than slipping
/// through.
#[test]
fn every_command_takes_exactly_one_argument_and_it_is_named_payload() {
    /// Types Tauri fills in itself. Anything else is renderer-supplied JSON.
    const EXTRACTORS: &[&str] = &[
        "AppHandle",
        "Channel",
        "Request",
        "State",
        "Webview",
        "WebviewWindow",
        "Window",
    ];

    let mut wrong = Vec::new();
    for command in declared_signatures() {
        let from_the_renderer: Vec<&(String, String)> = command
            .args
            .iter()
            .filter(|(_, ty)| !EXTRACTORS.contains(&ty.as_str()))
            .collect();

        match from_the_renderer.as_slice() {
            [(name, _)] if name == "payload" => {}
            [(name, ty)] => wrong.push(format!(
                "`{}` takes its input as `{name}: {ty}` — Tauri matches command \
                 arguments by name, and the renderer sends `{{ payload }}`, so \
                 `{name}` arrives as `undefined`",
                command.name
            )),
            [] => wrong.push(format!(
                "`{}` takes no payload argument; every command takes one, \
                 `EmptyPayload` if it needs nothing",
                command.name
            )),
            many => wrong.push(format!(
                "`{}` takes {} renderer-supplied arguments ({}); exactly one is \
                 permitted, and the rest of them arrive as `undefined`",
                command.name,
                many.len(),
                many.iter()
                    .map(|(name, ty)| format!("{name}: {ty}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        }
    }

    assert!(
        wrong.is_empty(),
        "the call shape `ipc/mod.rs` and conventions.md §3.1 call \
         non-negotiable is broken:\n  {}",
        wrong.join("\n  ")
    );
}

/// The call-shape parser's own control: it must object to each broken shape and
/// accept the correct one, or the test above is decoration too.
#[test]
fn the_call_shape_parser_sees_the_argument_names_it_judges() {
    let source = r##"
        #[tauri::command]
        pub fn correct(state: State<'_, AppState>, payload: Req) -> IpcResult<Res> { todo!() }

        #[tauri::command]
        pub fn renamed(state: State<'_, AppState>, req: Req) -> IpcResult<Res> { todo!() }

        #[tauri::command]
        pub fn two_of_them(payload: Req, extra: String) -> IpcResult<Res> { todo!() }

        #[tauri::command]
        pub fn none_at_all(app: AppHandle<R>) -> IpcResult<Res> { todo!() }
    "##;

    let parsed = command_sigs_in(source, "the call-shape fixture");
    let shapes: Vec<(String, Vec<(String, String)>)> = parsed
        .into_iter()
        .map(|command| (command.name, command.args))
        .collect();

    assert_eq!(
        shapes,
        vec![
            (
                "correct".to_owned(),
                vec![
                    ("state".to_owned(), "State".to_owned()),
                    ("payload".to_owned(), "Req".to_owned())
                ]
            ),
            (
                "renamed".to_owned(),
                vec![
                    ("state".to_owned(), "State".to_owned()),
                    ("req".to_owned(), "Req".to_owned())
                ]
            ),
            (
                "two_of_them".to_owned(),
                vec![
                    ("payload".to_owned(), "Req".to_owned()),
                    ("extra".to_owned(), "String".to_owned())
                ]
            ),
            (
                "none_at_all".to_owned(),
                vec![("app".to_owned(), "AppHandle".to_owned())]
            ),
        ],
        "the parser must read both the binding name and the type head of every \
         command argument — the judgement above is only as good as this"
    );
}

/// The registration parser, shown catching each direction on synthetic sources,
/// so a failure of the real tests can be read as "the tree drifted" rather than
/// "the parser broke".
#[test]
fn the_registration_parser_reports_exactly_the_registered_paths() {
    let source = r#"
        pub fn configure<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
            builder
                .manage(State::new())
                // .invoke_handler(tauri::generate_handler![ipc::commented_out])
                .invoke_handler(tauri::generate_handler![
                    ipc::app::app_info,
                    ipc::secrets::secrets_set,
                ])
        }
    "#;

    let sites = registered_in(source, "the registration fixture");
    assert_eq!(sites.len(), 1, "the commented-out call must not be counted");
    assert_eq!(
        sites[0],
        ["app_info", "secrets_set"]
            .into_iter()
            .map(str::to_owned)
            .collect::<BTreeSet<_>>(),
        "the registered set is the last path segment of each entry — the name \
         the renderer sends on the wire"
    );

    // The real composition root, through the same code path.
    assert!(
        registered_commands().contains("chat_send"),
        "the parser must find the real handler list in src/lib.rs"
    );
}
