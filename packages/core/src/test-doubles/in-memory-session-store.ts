/**
 * InMemorySessionStore — SessionPort test-double.
 *
 * Holds sessions keyed by `${channel}:${customerId}` (=== `Session.id`)
 * and mutates a named session via `park*`/`unpark`. There is deliberately
 * NO process-global "current" session: every park/unpark names its target
 * by `sessionId`, so a single store instance cannot misattribute a parked
 * envelope to whichever session happened to load last (RC-R3 footgun).
 */

import type { IntentEnvelope } from "@adjudicate/core";
import type { ChannelKind } from "../ports/channel.js";
import type {
  DeferredEnvelope,
  ParkedEnvelope,
  Session,
  SessionPort,
} from "../ports/session.js";

export class InMemorySessionStore implements SessionPort {
  private readonly byKey = new Map<string, Session>();

  async load(customerId: string, channel: ChannelKind): Promise<Session> {
    const key = `${channel}:${customerId}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: Session = {
      id: key,
      customerId,
      channel,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      pendingConfirmations: [],
      deferredEnvelopes: [],
      activeGoals: [],
      workingMemory: {
        summary: "",
        facts: [],
        updatedAt: new Date().toISOString(),
      },
    };
    this.byKey.set(key, fresh);
    return fresh;
  }

  async save(session: Session): Promise<void> {
    // A Session's id IS its byKey key; persist under it so save and the
    // sessionId-keyed park ops agree on where the session lives.
    this.byKey.set(session.id, session);
  }

  async parkPendingConfirmation(
    sessionId: string,
    envelope: IntentEnvelope,
    confirmationToken: string,
    userPrompt: string,
  ): Promise<void> {
    const target = this.byKey.get(sessionId);
    if (target === undefined) return;
    const parked: ParkedEnvelope = {
      envelope,
      confirmationToken,
      userPrompt,
      parkedAt: new Date().toISOString(),
    };
    this.byKey.set(sessionId, {
      ...target,
      pendingConfirmations: [...target.pendingConfirmations, parked],
    });
  }

  async parkDeferred(
    sessionId: string,
    envelope: IntentEnvelope,
    signal: string,
    deferUntil: string,
    timeoutMs: number,
  ): Promise<void> {
    const target = this.byKey.get(sessionId);
    if (target === undefined) return;
    const deferred: DeferredEnvelope = {
      envelope,
      signal,
      deferUntil,
      timeoutMs,
      parkedAt: new Date().toISOString(),
    };
    this.byKey.set(sessionId, {
      ...target,
      deferredEnvelopes: [...target.deferredEnvelopes, deferred],
    });
  }

  async unpark(sessionId: string, intentHash: string): Promise<void> {
    const target = this.byKey.get(sessionId);
    if (target === undefined) return;
    this.byKey.set(sessionId, {
      ...target,
      pendingConfirmations: target.pendingConfirmations.filter(
        (p) => p.envelope.intentHash !== intentHash,
      ),
      deferredEnvelopes: target.deferredEnvelopes.filter(
        (d) => d.envelope.intentHash !== intentHash,
      ),
    });
  }
}
