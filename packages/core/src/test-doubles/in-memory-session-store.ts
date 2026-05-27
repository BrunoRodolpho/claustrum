/**
 * InMemorySessionStore — SessionPort test-double.
 *
 * Holds a single Session in memory and mutates it via `park*`/`unpark`.
 * `current()` returns the active Session for the most recent `load`.
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
  private active: Session | undefined;
  private readonly byKey = new Map<string, Session>();

  async load(customerId: string, channel: ChannelKind): Promise<Session> {
    const key = `${channel}:${customerId}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      this.active = existing;
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
    this.active = fresh;
    return fresh;
  }

  async save(session: Session): Promise<void> {
    const key = `${session.channel}:${session.customerId}`;
    this.byKey.set(key, session);
    this.active = session;
  }

  current(): Session {
    if (this.active === undefined) {
      throw new Error("InMemorySessionStore.current(): no session loaded yet.");
    }
    return this.active;
  }

  async parkPendingConfirmation(
    envelope: IntentEnvelope,
    confirmationToken: string,
    userPrompt: string,
  ): Promise<void> {
    if (this.active === undefined) return;
    const parked: ParkedEnvelope = {
      envelope,
      confirmationToken,
      userPrompt,
      parkedAt: new Date().toISOString(),
    };
    this.active = {
      ...this.active,
      pendingConfirmations: [...this.active.pendingConfirmations, parked],
    };
    this.byKey.set(
      `${this.active.channel}:${this.active.customerId}`,
      this.active,
    );
  }

  async parkDeferred(
    envelope: IntentEnvelope,
    signal: string,
    deferUntil: string,
    timeoutMs: number,
  ): Promise<void> {
    if (this.active === undefined) return;
    const deferred: DeferredEnvelope = {
      envelope,
      signal,
      deferUntil,
      timeoutMs,
      parkedAt: new Date().toISOString(),
    };
    this.active = {
      ...this.active,
      deferredEnvelopes: [...this.active.deferredEnvelopes, deferred],
    };
    this.byKey.set(
      `${this.active.channel}:${this.active.customerId}`,
      this.active,
    );
  }

  async unpark(intentHash: string): Promise<void> {
    if (this.active === undefined) return;
    this.active = {
      ...this.active,
      pendingConfirmations: this.active.pendingConfirmations.filter(
        (p) => p.envelope.intentHash !== intentHash,
      ),
      deferredEnvelopes: this.active.deferredEnvelopes.filter(
        (d) => d.envelope.intentHash !== intentHash,
      ),
    };
    this.byKey.set(
      `${this.active.channel}:${this.active.customerId}`,
      this.active,
    );
  }

  isStale(): boolean {
    return false;
  }
}
