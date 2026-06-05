/**
 * WebChannel — HTTP/JSON `ChannelDriver` implementation.
 *
 * Render delivery is delegated to an injected sink callback (WebSocket,
 * SSE, etc.) so this adapter is transport-agnostic; the channel owns
 * envelope semantics, the host owns the wire.
 */

import type {
  ChannelDriver,
  ChannelKind,
  ChannelMessage,
  ParkedMatch,
  RenderedResponse,
  Session,
  SignedEnvelope,
} from "@claustrum/core";
import { resolveGatewaySigningKey } from "@claustrum/core";
import type { IntentEnvelope } from "@adjudicate/core";
import { attestWebEnvelope } from "./attest.js";
import { perceiveWebPayload } from "./perceive.js";
import type { WebChannelConfig, WebInboundPayload } from "./types.js";

export class WebChannel implements ChannelDriver {
  readonly kind: ChannelKind = "web";

  constructor(private readonly config: WebChannelConfig) {
    // Resolve to validate: catches a missing key and a `{current:""}` provider.
    try {
      resolveGatewaySigningKey(config.gatewaySigningKey);
    } catch {
      throw new Error("WebChannel: gatewaySigningKey required");
    }
    if (typeof config.sink !== "function") throw new Error("WebChannel: sink required");
    if (!config.gateway) throw new Error("WebChannel: gateway required");
  }

  async perceive(raw: unknown): Promise<ChannelMessage> {
    if (raw === null || typeof raw !== "object") {
      throw new Error("WebChannel.perceive: raw must be an object");
    }
    return perceiveWebPayload(raw as WebInboundPayload);
  }

  async render(response: RenderedResponse): Promise<void> {
    await this.config.sink(response);
  }

  async attest(envelope: IntentEnvelope): Promise<SignedEnvelope> {
    return attestWebEnvelope(envelope, this.config.gatewaySigningKey, {
      gateway: this.config.gateway,
      ...(this.config.gatewayKeyId !== undefined
        ? { keyId: this.config.gatewayKeyId }
        : {}),
    });
  }

  /**
   * The web channel has no parked-reply matching: a single-shot HTTP/JSON
   * request carries no "yes/no/tomorrow" resumption convention (a web client
   * resumes by re-submitting the intent, or addresses a parked envelope by an
   * explicit hash through a richer client protocol that is out of scope here).
   * Returns `null` so every inbound web message runs the normal cognitive
   * loop — satisfying the `ChannelDriver` port without inventing semantics.
   */
  matchToParked(_channelEvent: ChannelMessage, _session: Session): ParkedMatch | null {
    void _channelEvent;
    void _session;
    return null;
  }
}
