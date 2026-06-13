/**
 * Conductor — the process-wide runtime instance.
 *
 * Holds every port that the cognitive loop needs and mints a fresh
 * `Capsule` per inbound turn. `openCapsule` resolves tenant config,
 * loads the session, and assembles (state, policy) via the
 * adopter-supplied `TenantResolver`. `closeCapsule` flushes telemetry
 * and persists the session.
 *
 * The Conductor is intentionally framework-shaped: it does NOT decide
 * what packs to register or how to compose ports. Adopters wire
 * everything in their boot path (see PART I §"The Conductor (process-wide
 * runtime instance)").
 */

import { randomUUID } from "node:crypto";
import type { Decision, IntentEnvelope } from "@adjudicate/core";
import type { Capsule, ChannelMap } from "./capsule.js";
import type {
  Adjudicator,
  ConfirmationReceipt,
  SystemState,
} from "./ports/adjudicator.js";
import type { ChannelDriver, ChannelKind, ChannelMessage } from "./ports/channel.js";
import type { ExplainerPort } from "./ports/explainer.js";
import type { GroundingPort } from "./ports/grounding.js";
import type { HandoffPort } from "./ports/handoff.js";
import type { MemoryPort } from "./ports/memory.js";
import type { PlannerPort } from "./ports/planner.js";
import type { ResolverPort } from "./ports/resolver.js";
import type { ResponderPort } from "./ports/responder.js";
import type { SessionPort } from "./ports/session.js";
import type { SessionLock, SessionLockHandle } from "./ports/session-lock.js";
import { InMemorySessionLock } from "./test-doubles/in-memory-session-lock.js";
import type { TelemetryPort } from "./ports/telemetry.js";
import type { TenantResolver } from "./ports/tenant.js";
import type { Actor } from "./tools/types.js";
import type { ToolRegistry } from "./tools/registry.js";

export interface ConductorOptions {
  readonly adjudicator: Adjudicator;
  readonly memory: MemoryPort;
  readonly grounding: GroundingPort;
  readonly planner: PlannerPort;
  readonly responder: ResponderPort;
  readonly explainer: ExplainerPort;
  readonly handoff: HandoffPort;
  readonly telemetry: TelemetryPort;
  readonly session: SessionPort;
  readonly tools: ToolRegistry;
  readonly channels: ReadonlyArray<ChannelDriver>;
  readonly tenantResolver: TenantResolver;
  /**
   * Optional pre-adjudication resolve stage (plan → resolve → adjudicate). When
   * wired, `handleTurn` runs it to resolve envelope payloads + assemble per-
   * envelope state before the kernel adjudicates. Absent → legacy behavior.
   */
  readonly resolver?: ResolverPort;
  /** Optional ID seed for traces. Defaults to crypto.randomUUID. */
  readonly idFactory?: () => string;
  /**
   * Per-session lock that serializes concurrent turns for one session
   * (RC-R3 / Decision 1). Defaults to an in-process `InMemorySessionLock`,
   * which is correct for a SINGLE replica only. Multi-process deployments
   * MUST inject a distributed lock (e.g. `PostgresAdvisorySessionLock` from
   * @claustrum/memory-postgres) or two replicas will double-adjudicate the
   * same session.
   */
  readonly sessionLock?: SessionLock;
  /** Max time to wait for a contended session lock before failing the turn closed. Default 10s. */
  readonly sessionLockTimeoutMs?: number;
  /**
   * Lock-KEY derivation for the per-session lock (DR-4).
   *
   * Default: {@link defaultLockKey} — `` `${channel}:${customerId}` ``,
   * byte-identical to pre-0.3 behavior. See {@link LockKeyStrategy} for the
   * full contract and {@link sessionKeyAwareLockKey} for the opt-in
   * sessionKey-honoring strategy used by non-conversational trigger turns.
   */
  readonly lockKeyStrategy?: LockKeyStrategy;
}

/**
 * Derives the per-session lock KEY from an `openCapsule` input — i.e. the
 * serialization domain a turn runs in. Two turns serialize iff their derived
 * keys are equal (same `SessionLock` domain).
 *
 * Contract:
 * - The derived key MUST be a pure, deterministic function of the input
 *   (no clocks, no randomness) — retries of the same turn must contend on
 *   the same key.
 * - The derived key MUST cover the session-storage domain the turn mutates.
 *   The Conductor loads and saves the session by `(customerId, channel)`
 *   (see `SessionPort.load` / `closeCapsule`), so a strategy that derives
 *   keys NARROWER than `${channel}:${customerId}` for turns sharing a stored
 *   session reintroduces the RC-R3 race it exists to prevent. Widening (one
 *   key covering several storage domains) is always safe — merely coarser.
 *
 * Why this is configurable at all: the default key cannot serialize a
 * non-conversational trigger turn (channel `"system"`) against the chat
 * turns of the entity it acts on — `system:cust-1` and `web:cust-1` never
 * contend. The trigger path supplies an explicit `sessionKey` naming the
 * entity-scoped serialization domain and the conductor hosting it installs
 * {@link sessionKeyAwareLockKey}.
 */
export type LockKeyStrategy = (input: OpenCapsuleInput) => string;

/**
 * Default lock-key derivation: `` `${channel}:${customerId}` `` — exactly the
 * session-storage domain. `input.sessionKey` is deliberately IGNORED for
 * locking here (it still feeds `actor.sessionId` and the `TenantResolver`):
 * conversational callers commonly pass a per-conversation `sessionKey`, and
 * narrowing the lock to one conversation would let two conversations of the
 * same customer race on the shared `(customerId, channel)` session row.
 */
export function defaultLockKey(input: OpenCapsuleInput): string {
  return `${input.channel}:${input.customerId}`;
}

/**
 * DR-4 opt-in strategy: when the turn carries an explicit `sessionKey`, that
 * string IS the lock key — the caller owns the serialization domain. Without
 * a `sessionKey` it falls back to {@link defaultLockKey}, so conversational
 * turns through the same conductor are unchanged.
 *
 * Built for trigger turns (channel `"system"`): an agent acting on an entity
 * passes the entity-scoped domain as `sessionKey` — e.g. the chat lock key
 * `web:<customerId>` of the customer it remediates — so the agent turn and a
 * concurrent human chat turn for that customer strictly serialize across
 * processes (under a distributed `SessionLock`).
 *
 * Install ONLY on conductor compositions whose `sessionKey`-passing callers
 * mean "serialization domain" by it (e.g. a dedicated agent-host conductor).
 * Do NOT install on a conductor whose chat routes pass per-conversation
 * sessionKeys — that would narrow the lock below the session-storage domain
 * (see {@link LockKeyStrategy}).
 */
export function sessionKeyAwareLockKey(input: OpenCapsuleInput): string {
  return input.sessionKey !== undefined ? input.sessionKey : defaultLockKey(input);
}

export interface OpenCapsuleInput {
  readonly channel: ChannelKind;
  readonly customerId: string;
  readonly sessionKey?: string;
  readonly inbound: ChannelMessage;
  readonly actor?: Actor;
}

export interface Conductor {
  readonly adjudicator: Adjudicator;
  readonly channels: ChannelMap;
  readonly sessions: SessionPort;
  readonly memory: MemoryPort;
  readonly tools: ToolRegistry;

  openCapsule(input: OpenCapsuleInput): Promise<Capsule>;
  closeCapsule(capsule: Capsule): Promise<void>;
}

export function createConductor(options: ConductorOptions): Conductor {
  const id = options.idFactory ?? randomUUID;
  const sessionLock: SessionLock = options.sessionLock ?? new InMemorySessionLock();
  const lockTimeoutMs = options.sessionLockTimeoutMs ?? 10_000;
  // Per-capsule lock handle, released in closeCapsule. WeakMap keeps the
  // Capsule type free of lock internals and lets a dropped capsule GC its lock.
  const lockHandles = new WeakMap<Capsule, SessionLockHandle>();

  const lockKeyOf: LockKeyStrategy = options.lockKeyStrategy ?? defaultLockKey;

  const channelsMap: Partial<Record<ChannelKind, ChannelDriver>> = {};
  for (const driver of options.channels) {
    channelsMap[driver.kind] = driver;
  }
  const channels: ChannelMap = channelsMap;

  return {
    adjudicator: options.adjudicator,
    channels,
    sessions: options.session,
    memory: options.memory,
    tools: options.tools,

    async openCapsule(input: OpenCapsuleInput): Promise<Capsule> {
      // Acquire the per-session lock FIRST and hold it for the whole turn
      // (released in closeCapsule). This serializes concurrent turns for the
      // same session so adjudicate() fires exactly once per turn (RC-R3).
      // Fail closed on contention timeout rather than proceed unserialized.
      // The key is derived by the configured LockKeyStrategy (default:
      // `${channel}:${customerId}` — see defaultLockKey / DR-4).
      const lockKey = lockKeyOf(input);
      const lockHandle = await sessionLock.acquire(lockKey, {
        timeoutMs: lockTimeoutMs,
      });
      if (lockHandle === null) {
        throw new Error(
          `Conductor.openCapsule: timed out acquiring session lock for ${lockKey} after ${lockTimeoutMs}ms; refusing to run an unserialized turn`,
        );
      }

      try {
        // Resolve tenant + state + policy.
        const resolution = await options.tenantResolver.resolve({
        channel: input.channel,
        customerId: input.customerId,
        ...(input.sessionKey !== undefined
          ? { sessionKey: input.sessionKey }
          : {}),
      });

      // Load (or open) the session for this channel + customer.
      const session = await options.session.load(
        input.customerId,
        input.channel,
      );

      const sessionId =
        input.sessionKey !== undefined ? input.sessionKey : session.id;

      const actor: Actor = input.actor ?? {
        principal: "user",
        sessionId,
        customerId: input.customerId,
        role: "customer",
      };

      const turnId = id();
      const traceId = id();
      const conversationId = input.inbound.conversationId;

      const capsule: Capsule = {
        tenant: resolution.tenant,
        customerId: input.customerId,
        actor,
        conversationId,
        turnId,
        traceId,
        channel: input.channel,
        locale: resolution.tenant.locale,
        environment: resolution.tenant.environment,
        memory: options.memory,
        grounding: options.grounding,
        planner: options.planner,
        ...(options.resolver !== undefined
          ? { resolver: options.resolver }
          : {}),
        tools: options.tools,
        channels,
        responder: options.responder,
        adjudicator: options.adjudicator,
        explainer: options.explainer,
        handoff: options.handoff,
        telemetry: options.telemetry,
        session: options.session,
        loadedSession: session,
        state: resolution.state,
        policy: resolution.policy,
        adjudicate(
          envelope: IntentEnvelope,
          stateOverride?: SystemState,
        ): Promise<Decision> {
          // The resolve stage may supply a per-envelope SystemState; when present
          // it supersedes this turn's resolution.state (which the kernel would
          // otherwise adjudicate the resolved envelope against).
          return options.adjudicator.adjudicate(
            envelope,
            stateOverride ?? resolution.state,
            resolution.policy,
          );
        },
        adjudicatePlan(
          envelopes: ReadonlyArray<IntentEnvelope>,
          perEnvelopeStates?: ReadonlyArray<SystemState>,
        ): Promise<Decision> {
          return options.adjudicator.adjudicatePlan(
            envelopes,
            resolution.state,
            resolution.policy,
            perEnvelopeStates,
          );
        },
        // Wire `resume` only when the adjudicator implements the optional verb.
        // Binds THIS turn's freshly-resolved state/policy, so a resumed parked
        // envelope is re-adjudicated against current state (money-safety).
        ...(options.adjudicator.resume !== undefined
          ? {
              resume(
                envelope: IntentEnvelope,
                receipt?: ConfirmationReceipt,
              ): Promise<Decision> {
                // Non-null asserted: guarded by the `!== undefined` check above,
                // and `options` is captured (not mutated) for the capsule's life.
                return options.adjudicator.resume!(
                  envelope,
                  resolution.state,
                  resolution.policy,
                  receipt,
                );
              },
            }
          : {}),
      };

        lockHandles.set(capsule, lockHandle);
        return capsule;
      } catch (err) {
        // Building the capsule failed — don't strand the lock.
        await lockHandle.release();
        throw err;
      }
    },

    async closeCapsule(capsule: Capsule): Promise<void> {
      try {
        // Persist THIS capsule's session. We re-read by this capsule's own
        // (customerId, channel) rather than any global "last loaded" handle —
        // the SessionPort has no such accessor (RC-R3 footgun removed). The
        // per-session lock is still held, so re-reading the session for this
        // key returns the state THIS turn mutated.
        const latest = await options.session.load(
          capsule.customerId,
          capsule.channel,
        );
        await options.session.save(latest);
      } finally {
        // Always release the per-session lock, even if save throws.
        await lockHandles.get(capsule)?.release();
        lockHandles.delete(capsule);
      }
    },
  };
}
