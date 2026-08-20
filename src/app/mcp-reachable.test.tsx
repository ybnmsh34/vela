/**
 * **The MCP tool catalogue is reachable from the window.**
 *
 * `src/data/mcp-repository.ts` was written, documented, correct and tested, and
 * its only importer in the whole tree was its own test file. `mcp_list_tools`
 * was served by `src-tauri/src/ipc/mcp.rs`, registered in
 * `src-tauri/src/lib.rs`, allowlisted in `src-tauri/src/ipc/mod.rs` and proven
 * against a real child process over real pipes by
 * `src-tauri/crates/vela-mcp/tests/stdio_end_to_end.rs` — and nothing a user
 * could press reached any of it. The audit called that the governing finding of
 * the whole review: the Rust host is excellent and the renderer does not call
 * it. The fix for it is not a better repository. It is this file and what it
 * drives.
 *
 * ## Why these tests are here and not beside the pane
 *
 * `src/features/mcp/McpPanel.test.tsx` mounts the pane directly, so it passes
 * whether or not anything in the application mounts it. Every assertion below
 * goes through `<App />`: the real composition root, the real sidebar, the real
 * store seam. Delete `<McpSurface />` from `src/app/App.tsx`, delete the
 * sidebar control, or delete the repository's `listServers` arm, and these fail
 * — which is the whole point, and the property no test of the repository can
 * have. `src/app/skills-reachable.test.tsx` is the file this one is modelled on.
 *
 * ## The assertion that `src/runtime/reachable.test.ts` cannot make
 *
 * That guard went red the moment `src/data/mcp-repository.ts` appeared on the
 * import graph, and the only way back to green was to delete its
 * `AWAITING_A_SURFACE` entry. **That is one notch narrower than the question.**
 * An import walk cannot tell a module that is imported from a module that is
 * *used*: a wiring that imported the repository and called nothing would have
 * reddened it identically, and deleting the entry would then have recorded a
 * surface that does not exist.
 *
 * So the load-bearing assertion here is not "the pane renders". It is
 * `a tool the catalogue withheld is on screen saying why` — a fact about one
 * specific tool that **only `toolCatalogueOf` decides**. Nothing in the pane
 * re-runs `isSchemaObject`; the withheld marking is read back off the catalogue
 * that function produced. If the projection is not running on the real response,
 * that test cannot pass by accident.
 *
 * **Honesty (conventions §10):** VERIFIED-BY-FAKE, and only that.
 * `BrowserAdapter` answers `mcp_list_tools` from a canned response; a browser
 * tab cannot spawn a child process and this fake does not pretend to. Nothing
 * here starts an MCP server, reads an mcp-servers.json file or touches a real
 * application-data directory. What is proven is that the renderer's parts are
 * joined to each other and that the projection runs on whatever the host said.
 * Whether a human clicking the real window sees this is not established by this
 * file and is not claimed anywhere in it.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter } from '@/platform/browser-adapter';
import type { McpListToolsRes } from '@/platform/contract';
import { resetMcpStore } from '@/state/mcp-store';
import { resetMemoryStore } from '@/state/memory-store';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';
import { resetSkillsStore } from '@/state/skills-store';

type User = ReturnType<typeof userEvent.setup>;

/**
 * Two connected servers, one of them offering a tool the catalogue must refuse,
 * and one server that is not serving at all.
 *
 * `search` appears on both connected servers on purpose: it is the collision the
 * `mcp__<server>__<tool>` namespace exists for, and a pane that printed the
 * server's own `toolName` would show two rows with the same name.
 */
const FIXTURE: McpListToolsRes = {
  configFailure: null,
  servers: [
    {
      serverId: 'files',
      status: { kind: 'connected' },
      tools: [
        {
          name: 'mcp__files__search',
          toolName: 'search',
          description: 'Search the indexed files.',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
        {
          name: 'mcp__files__broken',
          toolName: 'broken',
          description: 'Describes its arguments with a string.',
          parameters: 'not a schema',
        },
      ],
    },
    {
      serverId: 'web',
      status: { kind: 'connected' },
      tools: [
        {
          name: 'mcp__web__search',
          toolName: 'search',
          description: 'Search the web.',
          parameters: { type: 'object' },
        },
      ],
    },
    {
      serverId: 'remote',
      status: { kind: 'unavailable', reason: 'transportNotSupported' },
      tools: [],
    },
  ],
};

/**
 * `delay: null` for the reason `src/app/modal-containment.test.tsx` records:
 * `userEvent`'s default yields once per simulated input step and a
 * `setTimeout(0)` turn costs a full Windows scheduler tick whether the box is
 * idle or loaded. Nothing here asserts how long a click took.
 */
function driver(): User {
  return userEvent.setup({ delay: null });
}

/** Open the pane the way a user does: the control in the sidebar. */
async function openMcp(user: User): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'MCP servers' }));
  return screen.findByRole('dialog');
}

/** The row a tool is drawn in, so an assertion can be scoped to one tool. */
function rowFor(name: string): HTMLElement {
  const label = screen.getByText(name);
  const row = label.closest('li');
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

beforeEach(() => {
  resetMcpStore();
  resetMemoryStore();
  resetModelStore();
  resetNavigationStore();
  resetSkillsStore();
});

describe('a user can see what their MCP servers offer', () => {
  it('opens a tool list from the sidebar of the assembled application', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // Everything below the adapter seam already worked, and had done since the
    // crate was written. This asserts the one thing that did not exist: a path
    // from a control in the window to `mcp_list_tools`.
    const user = driver();
    render(<App adapter={new BrowserAdapter({ mcp: FIXTURE })} />);

    const dialog = await openMcp(user);

    expect(await screen.findByText('mcp__files__search')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Search the indexed files.');
    expect(within(dialog).getByText('mcp__web__search')).toBeInTheDocument();
  });

  it('does not ask the servers anything until the user asks for them', async () => {
    // Stronger here than for the other panes. `mcp_list_tools` is what *starts*
    // the user's servers — `McpPool` spawns on first connect, not at
    // construction — so a surface that read on mount would launch every
    // configured child process at every launch of Vela, whether or not the user
    // ever looked at them.
    const commands: string[] = [];
    class RecordingHost extends BrowserAdapter {
      constructor() {
        super({ mcp: FIXTURE });
      }
      override async invoke(command: never, payload: never): Promise<never> {
        commands.push(command as string);
        return super.invoke(command, payload);
      }
    }
    const user = driver();
    render(<App adapter={new RecordingHost() as BrowserAdapter} />);

    await screen.findByRole('button', { name: 'MCP servers' });
    expect(commands).not.toContain('mcp_list_tools');

    await openMcp(user);
    await screen.findByText('mcp__files__search');
    expect(commands).toContain('mcp_list_tools');
  });

  it('shows a tool the catalogue withheld, in the window, carrying its reason', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // The assertion no import walk can make. `mcp__files__broken` describes its
    // arguments with a string, so `toolCatalogueOf` drops it — correctly, because
    // a backend that receives that schema rejects the whole request and takes
    // every other tool down with it. That guard is right and it is silent:
    // without this row the user watches one tool never appear and nothing
    // anywhere says why.
    //
    // It is also the only assertion in this file that cannot be satisfied by a
    // pane that merely *imports* the repository. The withheld marking is read
    // back off the catalogue; nothing in `src/features/mcp/` re-runs
    // `isSchemaObject`.
    const user = driver();
    render(<App adapter={new BrowserAdapter({ mcp: FIXTURE })} />);

    await openMcp(user);
    await screen.findByText('mcp__files__search');

    expect(rowFor('mcp__files__broken')).toHaveTextContent(
      /Withheld · Its arguments are not described by a JSON Schema object/u,
    );
    // The control: the healthy tool in the same server must not be marked, or
    // the assertion above would pass on a pane that marks everything.
    expect(rowFor('mcp__files__search')).not.toHaveTextContent(/Withheld/u);
    // And it is a row *alongside* the good one, not a replacement for it —
    // which is what "does not vanish" means.
    expect(rowFor('mcp__files__broken')).toHaveTextContent('Describes its arguments with a string.');
  });

  it('counts only the tools a turn would actually be offered', async () => {
    // Two of the three tools on connected servers survive the projection. The
    // number comes from `toolCatalogueOf`, not from a length of `tools`, which
    // is the difference between what the servers said and what a turn could use.
    const user = driver();
    render(<App adapter={new BrowserAdapter({ mcp: FIXTURE })} />);

    const dialog = await openMcp(user);
    await screen.findByText('mcp__files__search');

    expect(dialog).toHaveTextContent('2 would be offered to a turn');
  });

  it('lists a server that is not serving, with the reason it is not', async () => {
    // Conventions §9: the forbidden outcome is a reduction the user cannot see.
    // `remote` is the sharpest case — their file is correct and this build has
    // not implemented the transport — so a user shown a shorter list would go
    // and edit something that has nothing wrong with it.
    const user = driver();
    render(<App adapter={new BrowserAdapter({ mcp: FIXTURE })} />);

    const dialog = await openMcp(user);
    const notServing = await within(dialog).findByRole('list', {
      name: 'Servers that are not serving',
    });

    expect(within(notServing).getByText('remote')).toBeInTheDocument();
    expect(notServing).toHaveTextContent(
      /Its entry names a transport this build does not implement/u,
    );
  });

  it('says so when the configuration file itself could not be read', async () => {
    // An empty pane and an unusable configuration file look identical unless
    // somebody keeps them apart, and only one of them is the user's to fix.
    const user = driver();
    render(
      <App
        adapter={new BrowserAdapter({ mcp: { configFailure: 'configUnreadable', servers: [] } })}
      />,
    );

    const dialog = await openMcp(user);

    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      /Your mcp-servers.json could not be used/u,
    );
    // And it must not also claim there is nothing configured: the file could not
    // be read, so this build does not know what is in it.
    expect(dialog).not.toHaveTextContent('No MCP servers are configured.');
  });

  it('says a machine with no MCP configuration is configured, not broken', async () => {
    // Where every user starts. Reporting the ordinary case as a fault is how a
    // user is trained past the reasons that matter.
    const user = driver();
    render(<App adapter={new BrowserAdapter()} />);

    const dialog = await openMcp(user);

    expect(await within(dialog).findByText(/No MCP servers are configured/u)).toBeInTheDocument();
    expect(within(dialog).queryByRole('status')).toBeNull();
  });

  it('closes the pane and gives the keyboard back to the control that opened it', async () => {
    const user = driver();
    render(<App adapter={new BrowserAdapter({ mcp: FIXTURE })} />);

    const dialog = await openMcp(user);
    // Scoped to the dialog: the title bar carries a window Close button too,
    // and an unscoped query would be ambiguous rather than wrong.
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement, 'focus was dropped to <body>').not.toBe(document.body);
    expect(screen.getByRole('button', { name: 'MCP servers' })).toHaveFocus();
  });
});
