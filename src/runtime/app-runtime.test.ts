/**
 * **Does a project's instructions actually reach a run?**
 *
 * `createAgentRuntime` is the one place that turns an adapter into the services
 * a run is handed, and until now it had no test at all — its only importer was
 * `src/app/App.tsx`. That is how its `readProjectInstructions` came to be
 * `() => Promise.resolve(null)` for every project, under a comment claiming
 * `COMMAND_ALLOWLIST` had no command that reads a project. `project_get` had
 * been on that list; nothing re-read the comment, and nothing could have failed.
 *
 * ## Why two projects, and why that is the whole point
 *
 * A single-project test cannot tell a working reader from a broken one. With one
 * project in the store, "the run was handed instructions" is satisfied by any
 * implementation that reaches for *some* project — including the one that always
 * reached for the default. So every assertion here is a **difference between two
 * projects**: A's resolver yields A's words, B's yields B's, and a ref minted by
 * one does not load through the other.
 *
 * **Honesty (conventions §10): VERIFIED-BY-FAKE.** The host is `BrowserAdapter`,
 * whose project commands mirror `src-tauri/src/ipc/project.rs`. What is proved is
 * that the renderer's runtime issues `project_get` for the project it was asked
 * about and uses the answer. Nothing here is evidence about the packaged binary,
 * a real database, or a click.
 */

import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import type { CommandName, CommandReq, CommandRes } from '@/platform/contract';
import type { ProjectId } from '@/platform/contract-project';

import { createAgentRuntime } from './app-runtime';

interface TwoProjects {
  readonly adapter: BrowserAdapter;
  readonly a: ProjectId;
  readonly b: ProjectId;
}

async function twoProjects(): Promise<TwoProjects> {
  const adapter = new BrowserAdapter();
  const first = await adapter.invoke('project_create', { name: 'Sails' });
  const second = await adapter.invoke('project_create', { name: 'Rigging' });
  await adapter.invoke('project_update', {
    projectId: first.project.summary.id,
    instructions: 'always answer in French',
  });
  await adapter.invoke('project_update', {
    projectId: second.project.summary.id,
    instructions: 'always answer in Dutch',
  });
  return { adapter, a: first.project.summary.id, b: second.project.summary.id };
}

describe('the runtime the application runs on reads a project', () => {
  it('hands each project its own instructions, not one project’s to both', async () => {
    const { adapter, a, b } = await twoProjects();
    const runtime = createAgentRuntime(adapter);

    const refA = (await runtime.contextFor(a).index())[0];
    const refB = (await runtime.contextFor(b).index())[0];
    expect(refA, 'a project with instructions indexes one ref').toBeDefined();
    expect(refB).toBeDefined();
    if (refA === undefined || refB === undefined) return;

    expect((await runtime.contextFor(a).load(refA))?.text).toBe('always answer in French');
    expect((await runtime.contextFor(b).load(refB))?.text).toBe('always answer in Dutch');

    // The difference, stated as a difference. An implementation that answered
    // one project's instructions for every project passes both lines above only
    // if the two projects happen to agree — and here they do not.
    expect((await runtime.contextFor(a).load(refA))?.text).not.toBe(
      (await runtime.contextFor(b).load(refB))?.text,
    );
  });

  it('refuses a ref minted for another project rather than serving across the boundary', async () => {
    const { adapter, a, b } = await twoProjects();
    const runtime = createAgentRuntime(adapter);

    const refB = (await runtime.contextFor(b).index())[0];
    expect(refB).toBeDefined();
    if (refB === undefined) return;

    expect(await runtime.contextFor(a).load(refB)).toBeNull();
  });

  it('asks `project_get` for the project it was asked about', async () => {
    // The command and its payload, at the seam. The two tests above would also
    // pass against a runtime that read every project and picked by hand; this
    // one says which call went out.
    const { adapter, a, b } = await twoProjects();
    const asked: string[] = [];
    const recording = new Proxy(adapter, {
      get(target, property, receiver: unknown) {
        if (property !== 'invoke') return Reflect.get(target, property, receiver) as unknown;
        return async <C extends CommandName>(
          command: C,
          payload: CommandReq<C>,
        ): Promise<CommandRes<C>> => {
          if (command === 'project_get') {
            asked.push((payload as { readonly projectId: string }).projectId);
          }
          return target.invoke(command, payload);
        };
      },
    });
    const runtime = createAgentRuntime(recording);

    await runtime.contextFor(b).index();
    expect(asked).toEqual([b]);
    await runtime.contextFor(a).index();
    expect(asked).toEqual([b, a]);
  });

  it('reports a project it cannot read instead of running as though it were empty', async () => {
    // The failure direction at this seam. `project_get` refuses an id that names
    // no project, and the reader lets that rejection through — so the ref is
    // still indexed and `load` answers `null`, which is what the harness turns
    // into `contextUnavailable`.
    //
    // The alternative — a reader with its own `catch` answering `null` — indexes
    // nothing, and the run then carries no instructions with nothing said about
    // it. That is the shape this whole path exists to prevent, so it is asserted
    // here rather than left to the reader of `app-runtime.ts` to believe.
    const adapter = new BrowserAdapter();
    const runtime = createAgentRuntime(adapter);
    const missing = '00000000-0000-4000-8000-0000000000ff';

    await expect(adapter.invoke('project_get', { projectId: missing })).rejects.toThrow();

    const refs = await runtime.contextFor(missing).index();
    expect(refs).toHaveLength(1);
    const ref = refs[0];
    expect(ref).toBeDefined();
    if (ref === undefined) return;
    expect(await runtime.contextFor(missing).load(ref)).toBeNull();
  });

  it('indexes nothing for a project whose instructions box is empty', async () => {
    const adapter = new BrowserAdapter();
    const created = await adapter.invoke('project_create', { name: 'Untouched' });
    const runtime = createAgentRuntime(adapter);

    expect(created.project.instructions).toBe('');
    expect(await runtime.contextFor(created.project.summary.id).index()).toEqual([]);
  });
});
