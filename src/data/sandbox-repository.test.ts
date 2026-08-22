/**
 * The renderer half of the sandbox seam, against the fake host.
 *
 * **VERIFIED-BY-FAKE.** Nothing here executes a program and nothing here is
 * evidence about isolation — the boundary is Rust and its escape battery is
 * `src-tauri/crates/vela-sandbox/tests/sandbox_boundary.rs`. What these
 * assertions hold is the part a renderer can get wrong on its own: that the
 * commands are reachable through the seam at all, that a run's terminal event
 * arrives on the stream rather than as a rejected promise, and that a refusal is
 * delivered with its closed reason intact so the UI can word a sentence about
 * it.
 *
 * The fake refuses every submit, and that is the honest mirror of the real host
 * on a machine with no WSL distribution rather than a shortcut — see the sandbox
 * section of `src/platform/browser-adapter.ts`.
 */

import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { DEFAULT_PROJECT_ID } from '@/platform/contract-project';
import {
  DEFAULT_PROCESS_LIMITS,
  isolationMeets,
  type SandboxEvent,
  type SandboxSubmitReq,
} from '@/platform/contract-sandbox';
import { PlatformError } from '@/platform/errors';

import { createSandboxRepository, type WatchedSandboxEvent } from './sandbox-repository';

function submitOf(runId: string, overrides: Partial<SandboxSubmitReq> = {}): SandboxSubmitReq {
  return {
    runId,
    projectId: DEFAULT_PROJECT_ID,
    program: {
      kind: 'process',
      language: 'bash',
      source: 'echo hi',
      workingDirectory: { kind: 'scratch' },
      environment: [],
      stdin: null,
    },
    filesystem: {
      mounts: [],
      scratch: { guestPath: null, retainAfterSettled: false },
      outsideMounts: 'denied',
    },
    network: { kind: 'denied' },
    limits: DEFAULT_PROCESS_LIMITS,
    minimumIsolation: { family: 'process', level: 'container' },
    ...overrides,
  };
}

/** Submit and collect this run's events up to and including `settled`. */
async function drive(
  adapter: BrowserAdapter,
  request: SandboxSubmitReq,
): Promise<readonly WatchedSandboxEvent[]> {
  const repository = createSandboxRepository(adapter);
  const seen: WatchedSandboxEvent[] = [];
  // Subscribe first: the first event can be emitted before the invoke settles.
  const stop = await repository.watch(request.runId, (event) => {
    seen.push(event);
  });
  await repository.submit(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  stop();
  return seen;
}

describe('the sandbox seam', () => {
  it('reports what the machine can do rather than making the caller guess', async () => {
    const policy = await createSandboxRepository(new BrowserAdapter()).policy();

    expect(policy.permission).toBe('ask');
    // The fake has no process backend, and says so per guarantee instead of
    // letting the word "sandbox" imply the rest.
    expect(policy.backends.process.isolation).toEqual({ family: 'process', level: 'none' });
    expect(policy.backends.process.filesystem).toBe('unenforced');
    expect(policy.backends.process.network).toBe('unenforced');
    expect(policy.languages).toEqual([]);
    expect(policy.guestPlatform).toBe('posix');
    // The shipped profile auto-approves nothing, and this is the clause that
    // decides it: no submit the fake can serve truthfully asks for `container`.
    expect(
      isolationMeets(policy.backends.process.isolation, {
        family: 'process',
        level: policy.profile.minimumIsolation.process,
      }),
    ).toBe(false);
  });

  it('settles a run it cannot serve on the stream, with the reason intact', async () => {
    const seen = await drive(new BrowserAdapter(), submitOf('run-1'));

    expect(seen.map((entry) => entry.event.type)).toEqual(['settled']);
    const settled = seen[0]?.event as Extract<SandboxEvent, { type: 'settled' }>;
    expect(settled.outcome).toEqual({
      kind: 'refused',
      // `container` is more than a browser tab has, and the floor is a refusal
      // rather than a quiet downgrade.
      reason: 'isolationUnavailable',
      mountIndex: null,
      protectedRoot: null,
    });
    // `null` is "not reported". A zero here would be a claim.
    expect(settled.usage.cpuMs).toBeNull();
    expect(seen[0]?.seq).toBe(0);
  });

  it('refuses a run for a project it has never heard of before it looks at anything else', async () => {
    const seen = await drive(new BrowserAdapter(), submitOf('run-2', { projectId: 'not-a-project' }));
    const settled = seen[0]?.event as Extract<SandboxEvent, { type: 'settled' }>;
    expect(settled.outcome).toMatchObject({ kind: 'refused', reason: 'unknownProject' });
  });

  it('keeps two runs on their own streams', async () => {
    const adapter = new BrowserAdapter();
    const repository = createSandboxRepository(adapter);
    const mine: WatchedSandboxEvent[] = [];
    const stop = await repository.watch('run-mine', (event) => {
      mine.push(event);
    });

    await repository.submit(submitOf('run-mine'));
    await repository.submit(submitOf('run-theirs'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();

    expect(mine).toHaveLength(1);
  });

  it('rejects a duplicate run id on the invoke instead of settling somebody else’s run', async () => {
    const adapter = new BrowserAdapter();
    const repository = createSandboxRepository(adapter);
    await repository.submit(submitOf('run-dup'));

    await expect(repository.submit(submitOf('run-dup'))).rejects.toBeInstanceOf(PlatformError);
  });

  it('cancels a run that has not settled, and answers `false` once it has', async () => {
    // The fake settles on the next frame, so a frame the test holds is what
    // makes "still running" observable at all.
    const frames: (() => void)[] = [];
    const adapter = new BrowserAdapter({
      scheduleFrame: (run) => {
        frames.push(run);
      },
    });
    const repository = createSandboxRepository(adapter);
    const seen: WatchedSandboxEvent[] = [];
    const stop = await repository.watch('run-cancel', (event) => {
      seen.push(event);
    });
    await repository.submit(submitOf('run-cancel'));

    expect(await repository.cancel('run-cancel', 'user')).toEqual({ cancelled: true });
    for (const frame of frames) frame();
    stop();

    // Cancelling a run that was waiting settles it `cancelled`, not `refused`:
    // nobody denied it, the caller withdrew it.
    const settled = seen[0]?.event as Extract<SandboxEvent, { type: 'settled' }>;
    expect(settled.outcome).toMatchObject({ kind: 'cancelled' });
    // `false` now — a race, not an error.
    expect(await repository.cancel('run-cancel', 'user')).toEqual({ cancelled: false });
    expect(await repository.release('run-cancel')).toEqual({ ok: true });
  });

  it('carries an observation about a frame the host cannot see, and reads nothing into the answer', async () => {
    // The sixth command, which had no caller in `src/` at all until Canvas was
    // wired: only a comment in `DocumentPreview.tsx` and this fake's own arm.
    // Both fakes and the real host answer `{ ok: true }` and do nothing with it
    // — `report_document` in the `vela-sandbox` crate is an empty body — so the
    // `Ack` is delivery, never a claim that an outcome was recorded.
    const repository = createSandboxRepository(new BrowserAdapter());
    await expect(
      repository.reportDocument('run-report', { kind: 'failed', reason: 'frameCrashed' }),
    ).resolves.toEqual({ ok: true });
  });

  it('treats an approval digest it was never handed as a bug, not a decision', async () => {
    const repository = createSandboxRepository(new BrowserAdapter());
    await expect(repository.approve('run-x', 'invented', 'allowOnce')).rejects.toBeInstanceOf(
      PlatformError,
    );
  });
});
