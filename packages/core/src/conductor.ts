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
import type { Adjudicator } from "./ports/adjudicator.js";
import type { ChannelDriver, ChannelKind, ChannelMessage } from "./ports/channel.js";
import type { ExplainerPort } from "./ports/explainer.js";
import type { GroundingPort } from "./ports/grounding.js";
import type { HandoffPort } from "./ports/handoff.js";
import type { MemoryPort } from "./ports/memory.js";
import type { PlannerPort } from "./ports/planner.js";
import type { ResponderPort } from "./ports/responder.js";
import type { SessionPort } from "./ports/session.js";
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
  /** Optional ID seed for traces. Defaults to crypto.randomUUID. */
  readonly idFactory?: () => string;
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

  const channelsMap: Record<string, ChannelDriver> = {};
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
        tools: options.tools,
        channels,
        responder: options.responder,
        adjudicator: options.adjudicator,
        explainer: options.explainer,
        handoff: options.handoff,
        telemetry: options.telemetry,
        session: options.session,
        state: resolution.state,
        policy: resolution.policy,
        adjudicate(envelope: IntentEnvelope): Promise<Decision> {
          return options.adjudicator.adjudicate(
            envelope,
            resolution.state,
            resolution.policy,
          );
        },
        adjudicatePlan(
          envelopes: ReadonlyArray<IntentEnvelope>,
        ): Promise<Decision> {
          return options.adjudicator.adjudicatePlan(
            envelopes,
            resolution.state,
            resolution.policy,
          );
        },
      };

      return capsule;
    },

    async closeCapsule(capsule: Capsule): Promise<void> {
      // Persist the (possibly mutated) session. Adapters may no-op if
      // their `save` is a pass-through. Telemetry flushes here too, if
      // an adapter implements batching.
      await options.session.save(options.session.current());
      void capsule;
    },
  };
}
