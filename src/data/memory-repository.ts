/**
 * Memory, as the renderer needs it.
 *
 * A plain factory over a {@link PlatformAdapter}, exactly like
 * `conversations-repository.ts`: every method is one host command and nothing
 * here reshapes, caches, or merges. In particular it does **not** offer a
 * "list everything" method, because the host does not have one — MEM-2's rule
 * is that one scope's entries are never returned alongside another's, and a
 * convenience method here would be the first place that rule quietly stopped
 * being true.
 *
 * Errors propagate as `PlatformError`. `NOT_FOUND` from an amend or a delete is
 * passed through rather than swallowed: the pane asked about a specific entry,
 * and "it is not there any more" is an answer it has to render.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import type { MemoryAddReq, MemoryEntry, MemoryScope, MemoryUpdateReq } from '@/platform/contract';

/** The global scope, as a shared constant so no caller spells it twice. */
export const GLOBAL_MEMORY: MemoryScope = { kind: 'global' };

export interface MemoryRepository {
  /** One scope's entries, pinned first, then most recently updated first. */
  list(scope: MemoryScope): Promise<readonly MemoryEntry[]>;
  add(request: MemoryAddReq): Promise<MemoryEntry>;
  update(request: MemoryUpdateReq): Promise<MemoryEntry>;
  remove(entryId: string): Promise<void>;
  /** Empties one scope and answers with how many entries went. */
  clear(scope: MemoryScope): Promise<number>;
}

export function createMemoryRepository(adapter: PlatformAdapter): MemoryRepository {
  return {
    async list(scope: MemoryScope): Promise<readonly MemoryEntry[]> {
      const response = await adapter.invoke('memory_list', { scope });
      return response.entries;
    },

    async add(request: MemoryAddReq): Promise<MemoryEntry> {
      const response = await adapter.invoke('memory_add', request);
      return response.entry;
    },

    async update(request: MemoryUpdateReq): Promise<MemoryEntry> {
      const response = await adapter.invoke('memory_update', request);
      return response.entry;
    },

    async remove(entryId: string): Promise<void> {
      await adapter.invoke('memory_delete', { entryId });
    },

    async clear(scope: MemoryScope): Promise<number> {
      const response = await adapter.invoke('memory_clear_scope', { scope });
      return response.removed;
    },
  };
}
