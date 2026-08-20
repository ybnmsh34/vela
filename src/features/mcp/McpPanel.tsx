/**
 * The MCP servers pane: what the user's tool servers are offering, and what
 * they are not.
 *
 * ## Why this pane exists at all
 *
 * `mcp_list_tools` was served by `src-tauri/src/ipc/mcp.rs`, registered in
 * `src-tauri/src/lib.rs`, allowlisted in `src-tauri/src/ipc/mod.rs`, proven
 * against a real child process over real pipes — and **called by nothing a user
 * could press**. `src/data/mcp-repository.ts` was the renderer's door to it and
 * its only importer in the tree was its own test. This file is the other end.
 *
 * ## Three sections, because there are three different answers
 *
 * A configuration that could not be read, servers that are not serving, and
 * tools that are. They are separated because they are different work for the
 * user: the first is a typo in a file, the second is a list of things to fix,
 * the third is the thing they came to look at. `src/data/mcp-repository.ts`
 * makes the same split for the same reason and exports `unavailableServersOf`
 * to carry it.
 *
 * **A server that is not serving keeps its row.** Conventions §9: the forbidden
 * outcome is a reduction the user cannot see. That matters most for
 * `transportNotSupported`, which is this build saying it has not implemented
 * the transport their entry names — their file is correct and the client is
 * incomplete, and a user shown a shorter list would go and edit something that
 * has nothing wrong with it.
 *
 * ## A withheld tool is shown, with its reason
 *
 * The load-bearing behaviour of this file, and the counterpart of the broken-
 * skill row in `src/features/skills/SkillsPanel.tsx`. `toolCatalogueOf` drops a
 * tool whose `parameters` is not a JSON Schema object, because a backend that
 * receives one rejects the whole request and takes every other tool down with
 * it. That guard is right and it is silent: without this section a user whose
 * server describes one tool badly watches that tool never appear, with nothing
 * anywhere saying why. `isSchemaObject`'s own header says a guard nobody has
 * watched reject anything is a claim; this is where it is watched.
 *
 * The pane does not re-run the guard to find out. It reads
 * {@link McpSurvey.offered}, which *is* the catalogue's verdict — see
 * `use-mcp.ts` for why asking the question a second time would be the defect.
 *
 * ## What it does not print
 *
 * No command line, no argv, no environment, no process id, and not the path of
 * the configuration file. The first four never cross the boundary at all —
 * `ipc/mcp.rs` says why, and it is the right reason: a renderer that could read
 * the command line would eventually render it, and it is a path into the user's
 * machine, next to the `env` map where people put API tokens. The file's *name*
 * is printed because it is a constant of this build (`CONFIG_FILE_NAME` in
 * `ipc/mcp.rs`); its directory is not, because no command this pane calls
 * returns one and inventing it here would put a sentence on screen that nothing
 * verified against the directory the host actually read. `SkillsPanel.tsx`
 * makes the same omission for the same reason.
 */

import { useRef } from 'react';

import { ModalSurface } from '@/components/ModalSurface';
import type { McpFailureReason, McpServerTools, McpToolView } from '@/platform/contract';

import styles from './McpPanel.module.css';
import { useMcp, type McpController, type McpSurvey } from './use-mcp';

/**
 * What the user reads for each way a server can fail to serve.
 *
 * A `Record` rather than a `switch` with a default, for the reason
 * `PROBLEM_LABELS` in `src/features/skills/SkillsPanel.tsx` gives: the default
 * is what turns a new variant into the word "other" on somebody's screen, and
 * typing the map as total is what makes the compiler ask for the sentence
 * instead.
 *
 * **What that buys, measured rather than assumed.** A reason added to the
 * *TypeScript* union with no sentence here fails `pnpm typecheck`, naming this
 * file. A reason added in *Rust* does not widen the union, so this map stays
 * total and `pnpm typecheck` exits 0 — and then this lookup answers `undefined`
 * at runtime and the row carries an empty sentence. That direction is closed one
 * gate later by `src/platform/mcp-host-parity.test.ts`, which reads
 * `McpFailureCode` out of `src-tauri/crates/vela-mcp/src/error.rs` and compares
 * the wire names. Both halves are needed; neither alone is the guarantee.
 *
 * Each sentence is derived from the doc comment on the arm that produces it in
 * `error.rs`, not from the variant's spelling. Where a sentence tells the user
 * what to *do*, it is derived from `McpPool` in
 * `src-tauri/crates/vela-mcp/src/pool.rs` instead: the configuration is read
 * once when the pool is built and nothing reloads it, so a config problem needs
 * a restart — while a dead *connection* is replaced on the next call, so
 * `serverExited` really does clear on reopening this pane.
 */
const REASON_LABELS: Record<McpFailureReason, string> = {
  notConfigured: 'There is no entry with this name in mcp-servers.json.',
  configUnreadable:
    'The mcp-servers.json file itself could not be read or parsed. Fix it and restart Vela; it is read once at startup.',
  configInvalid: 'Its entry does not describe a server that can be launched.',
  transportNotSupported:
    'Its entry names a transport this build does not implement. Nothing is wrong with your file; remote (url) servers are not supported yet.',
  spawnFailed: 'The command could not be started — it may not be installed, or not on PATH.',
  handshakeFailed: 'It started, and then refused or bungled the MCP handshake.',
  serverExited: 'The process is no longer running. Reopening this pane starts it again.',
  protocolError: 'It answered with something that is not a legal MCP message.',
  timedOut: 'It is running and did not answer in time.',
  serverError: 'It answered the request with an error.',
};

interface McpPanelProps {
  readonly onClose: () => void;
  /** Substituted in tests; defaults to one built over the platform adapter. */
  readonly controller?: McpController;
}

export function McpPanel({ onClose, controller }: McpPanelProps) {
  // Called unconditionally — hooks may not be skipped — and its result is
  // discarded when the caller supplied one. The alternative is two components.
  const own = useMcp();
  const mcp = controller ?? own;

  const closeRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalSurface
      labelledBy="mcp-title"
      describedBy="mcp-intro"
      scrimClassName={styles.scrim}
      className={styles.dialog}
      initialFocus={closeRef}
      onDismiss={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={styles.head}>
        <h2 id="mcp-title" className={styles.title}>
          MCP servers
        </h2>
        <button type="button" ref={closeRef} className={styles.close} onClick={onClose}>
          Close
        </button>
      </div>

      <p id="mcp-intro" className={styles.intro}>
        MCP servers are the tool servers you list in an mcp-servers.json file in Vela&rsquo;s data
        folder on this device. Opening this pane starts each one and asks it what tools it offers.
        That file is read once when Vela starts, so an edit to it needs a restart, not a reopen.
      </p>

      <McpBody mcp={mcp} />

      <p className={styles.footnote}>
        Vela can list these tools. It cannot call one yet — this build has no command that
        dispatches an MCP tool call — so nothing here is offered to a model.
      </p>
    </ModalSurface>
  );
}

function McpBody({ mcp }: { readonly mcp: McpController }) {
  const { state } = mcp;

  if (state.status === 'loading') {
    return (
      <p className={styles.note} data-testid="mcp-loading">
        Asking your MCP servers what they offer&hellip;
      </p>
    );
  }

  if (state.status === 'error') {
    // An empty answer and an answer that never came look identical drawn as an
    // empty list, and one of them is a lie.
    return (
      <p className={styles.error} role="status">
        MCP servers unavailable · {state.code}
      </p>
    );
  }

  return <McpSurveyView survey={state.survey} />;
}

function McpSurveyView({ survey }: { readonly survey: McpSurvey }) {
  const connected = survey.servers.filter((server) => server.status.kind === 'connected');

  return (
    <div className={styles.body}>
      {survey.configFailure !== null && (
        <p className={styles.error} role="status">
          Your mcp-servers.json could not be used · {REASON_LABELS[survey.configFailure]}
        </p>
      )}

      {survey.servers.length === 0 && survey.configFailure === null && (
        <p className={styles.note}>
          No MCP servers are configured. Add an mcp-servers.json file to Vela&rsquo;s data folder and
          restart Vela.
        </p>
      )}

      {survey.unavailable.length > 0 && (
        <section className={styles.section}>
          <p className={styles.sectionLabel}>Not serving</p>
          <ul className={styles.list} aria-label="Servers that are not serving">
            {survey.unavailable.map((server) => (
              <li key={server.serverId} className={`${styles.row} ${styles.rowBroken}`}>
                <span className={styles.rowName}>{server.serverId}</span>
                <span className={styles.rowProblem}>{REASON_LABELS[server.reason]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {connected.length > 0 && (
        <section className={styles.section}>
          <p className={styles.sectionLabel}>
            Tools · {String(survey.offered.size)} would be offered to a turn
          </p>
          {connected.map((server) => (
            <ServerTools key={server.serverId} server={server} offered={survey.offered} />
          ))}
        </section>
      )}
    </div>
  );
}

function ServerTools({
  server,
  offered,
}: {
  readonly server: McpServerTools;
  readonly offered: ReadonlySet<string>;
}) {
  return (
    <div className={styles.server}>
      <p className={styles.serverName}>{server.serverId}</p>
      {server.tools.length === 0 ? (
        <p className={styles.note}>This server is connected and offers no tools.</p>
      ) : (
        <ul className={styles.list} aria-label={`Tools from ${server.serverId}`}>
          {server.tools.map((tool) => (
            <li key={tool.name}>
              <ToolRow tool={tool} offered={offered.has(tool.name)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One tool.
 *
 * The **namespaced** name is what is shown, because that is the name a model
 * would have to call and the only one that is unique across servers. The
 * server's own `toolName` is deliberately not drawn beside it: it is already the
 * tail of what is on screen, and printing both would be two names for one thing.
 */
function ToolRow({ tool, offered }: { readonly tool: McpToolView; readonly offered: boolean }) {
  return (
    <div className={offered ? styles.row : `${styles.row} ${styles.rowBroken}`}>
      <span className={styles.toolName}>{tool.name}</span>
      {tool.description === '' ? (
        <span className={styles.rowDescription}>This server gave no description for it.</span>
      ) : (
        <span className={styles.rowDescription}>{tool.description}</span>
      )}
      {!offered && (
        <span className={styles.rowProblem}>
          Withheld · Its arguments are not described by a JSON Schema object, so offering it would
          risk every other tool in the same request.
        </span>
      )}
    </div>
  );
}
