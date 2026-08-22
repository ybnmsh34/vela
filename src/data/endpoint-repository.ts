/**
 * Local endpoint repository — the switch for Vela's own HTTP port.
 *
 * A thin, typed pass-through to the host, on the same terms as
 * `settings-repository.ts`:
 *
 *  1. **The key travels one way.** {@link EndpointRepository.enable} carries it
 *     to the host and nothing returns it: {@link EndpointStatus} has no field
 *     that could, and the host's request type cannot be serialised at all. What
 *     the caller learns afterwards is where the port is and what its tool
 *     policy resolved to.
 *  2. **Nothing here decides anything.** In particular the tool policy is not
 *     recomputed on this side. The host resolves it from the address the
 *     listener actually bound — not the one that was asked for — so a caller
 *     that inferred "loopback, so tools are on" from the string it typed could
 *     be describing a listener that bound something else. Read `toolsEnabled`
 *     and `toolPolicy`; never derive them.
 *  3. **No backend vocabulary.** The port answers more than one wire format and
 *     none of them is nameable here. The only string this file passes that
 *     identifies anything is a `providerId` the user configured, and it is
 *     carried, never inspected.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import type { EndpointEnableReq, EndpointStatus } from '@/platform/contract';

export interface EndpointRepository {
  /** What the endpoint is doing right now. Never throws for "off". */
  status(): Promise<EndpointStatus>;
  /**
   * Start serving, or move an already-running endpoint to a new address.
   *
   * The host stops whatever was listening before it binds the new address, and
   * re-resolves the tool policy from the new listener — so a rebind from
   * loopback to a wildcard comes back with tools **off**, whatever the previous
   * answer was. Rejects with a `PlatformError` when the address, the key or the
   * endpoint id is missing or malformed.
   */
  enable(request: EndpointEnableReq): Promise<EndpointStatus>;
  /** Stop serving. The port is closed by the time this resolves. */
  disable(): Promise<EndpointStatus>;
}

export function createEndpointRepository(adapter: PlatformAdapter): EndpointRepository {
  return {
    status(): Promise<EndpointStatus> {
      return adapter.invoke('endpoint_status', {});
    },

    enable(request: EndpointEnableReq): Promise<EndpointStatus> {
      return adapter.invoke('endpoint_enable', request);
    },

    disable(): Promise<EndpointStatus> {
      return adapter.invoke('endpoint_disable', {});
    },
  };
}

/**
 * Does this configuration need the user to answer the exposed-tools question
 * before it can do what they asked?
 *
 * The one state that surprises people: they asked for tools, the address is not
 * loopback, and they got none. Distinguished from "tools are off because the
 * address is exposed and nobody asked for them", which is the rule working as
 * intended and is not a question.
 */
export function awaitsExposureConfirmation(status: EndpointStatus): boolean {
  return status.toolPolicy === 'exposed-enable-unconfirmed';
}
