/**
 * SessionPort — long-lived conversation state.
 *
 * A Session survives across many turns — a WhatsApp conversation may
 * span weeks. The port owns:
 *  - working memory (compressed last-N-turn summary, fits in prompt)
 *  - parked envelopes (REQUEST_CONFIRMATION, DEFER) keyed by intentHash
 *  - active goals (the customer's current task tree)
 *
 * Parked envelopes are the load-bearing artifact for confirmation /
 * deferral resumption (PART I §"Long-lived session resumption"). A
 * reply matched to a parked envelope produces a re-adjudication with
 * `supersedes: { intentHash, reason: "confirmation_resolved" }`.
 */

import type { IntentEnvelope } from "@adjudicate/core";
import type { ChannelKind } from "./channel.js";

export interface WorkingMemoryFrame {
  /** Concise summary of the last ~20 turns. Updated each turn. */
  readonly summary: string;
  readonly facts: ReadonlyArray<string>;
  readonly updatedAt: string;
}

export interface Goal {
  readonly id: string;
  readonly kind: string;
  readonly status: "open" | "complete" | "abandoned";
  readonly description: string;
  readonly createdAt: string;
  readonly closedAt?: string;
}

export interface ParkedEnvelope {
  readonly envelope: IntentEnvelope;
  readonly confirmationToken: string;
  readonly userPrompt: string;
  readonly parkedAt: string;
  readonly expiresAt?: string;
}

export interface DeferredEnvelope {
  readonly envelope: IntentEnvelope;
  readonly signal: string;
  readonly deferUntil: string;
  readonly timeoutMs: number;
  readonly parkedAt: string;
}

export interface Session {
  readonly id: string;
  readonly customerId: string;
  readonly channel: ChannelKind;
  readonly agent?: string;
  readonly startedAt: string;
  readonly lastActivityAt: string;
  readonly pendingConfirmations: ReadonlyArray<ParkedEnvelope>;
  readonly deferredEnvelopes: ReadonlyArray<DeferredEnvelope>;
  readonly activeGoals: ReadonlyArray<Goal>;
  readonly workingMemory: WorkingMemoryFrame;
}

export interface SessionPort {
  load(customerId: string, channel: ChannelKind): Promise<Session>;
  save(session: Session): Promise<void>;

  /**
   * Park a REQUEST_CONFIRMATION envelope on a specific session.
   *
   * The target session is named explicitly by `sessionId` (===
   * `Session.id`) rather than implied by "whichever session was loaded
   * last". This removes the single-instance footgun (RC-R3): a port that
   * tracked a process-global "current" session could park the envelope on
   * the wrong customer's session under concurrent turns. No-op if no
   * session with `sessionId` is known.
   */
  parkPendingConfirmation(
    sessionId: string,
    envelope: IntentEnvelope,
    confirmationToken: string,
    userPrompt: string,
  ): Promise<void>;

  /** Park a DEFER envelope on the session named by `sessionId`. No-op if unknown. */
  parkDeferred(
    sessionId: string,
    envelope: IntentEnvelope,
    signal: string,
    deferUntil: string,
    timeoutMs: number,
  ): Promise<void>;

  /**
   * Remove a parked envelope by intentHash from the session named by
   * `sessionId`. Called on resumption. No-op if unknown.
   */
  unpark(sessionId: string, intentHash: string): Promise<void>;
}
