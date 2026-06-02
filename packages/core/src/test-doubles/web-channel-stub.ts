/**
 * WebChannelStub — ChannelDriver test-double.
 *
 * Trivial driver that returns whatever was handed to `perceive` and
 * stores responses in a buffer for assertion.
 */

import type { IntentEnvelope } from "@adjudicate/core";
import type {
  ChannelDriver,
  ChannelKind,
  ChannelMessage,
  ParkedMatch,
  RenderedResponse,
  SignedEnvelope,
} from "../ports/channel.js";
import type { Session } from "../ports/session.js";

export class WebChannelStub implements ChannelDriver {
  public readonly kind: ChannelKind = "web";
  public readonly rendered: RenderedResponse[] = [];
  public readonly attested: SignedEnvelope[] = [];
  /**
   * Optional test override: tests that exercise the resume path inject a
   * matcher so the stub can return a `ParkedMatch`. Default `null` keeps every
   * other test (and all property tests) on the normal cognitive loop.
   */
  public matchToParkedImpl:
    | ((channelEvent: ChannelMessage, session: Session) => ParkedMatch | null)
    | null = null;

  async perceive(raw: unknown): Promise<ChannelMessage> {
    if (raw === null || typeof raw !== "object") {
      throw new Error("WebChannelStub.perceive expects an object.");
    }
    const candidate = raw as Partial<ChannelMessage>;
    return {
      channel: "web",
      customerId: candidate.customerId ?? "anon",
      conversationId: candidate.conversationId ?? "conv-1",
      text: candidate.text ?? "",
      receivedAt: candidate.receivedAt ?? new Date().toISOString(),
      ...(candidate.externalId !== undefined
        ? { externalId: candidate.externalId }
        : {}),
      ...(candidate.locale !== undefined ? { locale: candidate.locale } : {}),
      ...(candidate.attachments !== undefined
        ? { attachments: candidate.attachments }
        : {}),
      raw,
    };
  }

  async render(response: RenderedResponse): Promise<void> {
    this.rendered.push(response);
  }

  async attest(envelope: IntentEnvelope): Promise<SignedEnvelope> {
    const signed: SignedEnvelope = {
      envelope,
      signature: `stub-${envelope.intentHash.slice(0, 16)}`,
      keyId: "web-stub",
      alg: "stub",
    };
    this.attested.push(signed);
    return signed;
  }

  /** Defaults to no match (normal loop); tests opt in via `matchToParkedImpl`. */
  matchToParked(channelEvent: ChannelMessage, session: Session): ParkedMatch | null {
    return this.matchToParkedImpl
      ? this.matchToParkedImpl(channelEvent, session)
      : null;
  }
}
