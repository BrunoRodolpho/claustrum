/**
 * Tool types — capability/id split that powers intent-gated execution.
 *
 * The LLM sees `capability` (e.g. "payment.refund"). The runtime resolves
 * to `id` (e.g. "stripe.refund.v2") via tenant config. Without this
 * split, every tool-use library (LangChain, OpenAI function calling,
 * Anthropic tool use) leaks tool identity to the LLM — breaking the
 * zero-authority invariant.
 *
 * The conformance check CC-001 enforces: the LLM-facing tool surface
 * is exactly `[express_intent]`. The capability graph is exposed via
 * the planner's plan-side prompt — never as a callable tool.
 */

import type { ChannelKind } from "../ports/channel.js";
import type { GroundingSpec } from "../ports/grounding.js";

/**
 * Branded string for capability identifiers. The brand prevents
 * accidental cross-assignment with internal tool ids.
 */
export type CapabilityId = string & { readonly __brand: "CapabilityId" };

/**
 * Branded string for intent kinds. Matches the kernel's
 * `IntentEnvelope<K>` parameter. Adopters declare a string union of
 * their intent kinds and cast as needed.
 */
export type IntentKind = string & { readonly __brand: "IntentKind" };

export type ActorRole =
  | "customer"
  | "staff"
  | "admin"
  | "system"
  | "support";

export interface Actor {
  readonly principal: "llm" | "user" | "system";
  readonly role?: ActorRole;
  readonly sessionId: string;
  readonly customerId?: string;
  readonly staffId?: string;
}

/**
 * Capability descriptor surfaced to the planner. NOT surfaced to the LLM
 * directly — the planner uses this to decide which capabilities to
 * advertise; the LLM still only calls `express_intent`.
 */
export interface CapabilityDescriptor {
  readonly capability: CapabilityId;
  readonly intentKind: IntentKind;
  readonly description: string;
  readonly riskLevel: "low" | "medium" | "high" | "irreversible";
  readonly requiresConfirmation?: boolean;
  readonly groundingRequirements?: GroundingSpec;
}

/**
 * A tool. `id` is internal — NEVER exposed to the LLM. `capability`
 * is what the LLM sees (via the planner's capability advertisement).
 * The runtime resolves `capability` -> tenant-appropriate `id` -> impl.
 */
export interface ToolDefinition<I = unknown, O = unknown> {
  /** Internal identifier — tenant-resolved. NEVER LLM-facing. */
  readonly id: string;

  /** Capability — what the LLM sees via express_intent payloads. */
  readonly capability: CapabilityId;

  readonly description: string;

  /**
   * Input schema. Adapters typically pass a Zod schema; the runtime
   * treats it opaquely (the adapter validates).
   */
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;

  /** Maps to the kernel's IntentEnvelope.kind. */
  readonly intentKind: IntentKind;

  readonly riskLevel: "low" | "medium" | "high" | "irreversible";
  readonly groundingRequirements?: GroundingSpec;
  readonly allowedChannels?: ReadonlyArray<ChannelKind>;
  readonly allowedRoles?: ReadonlyArray<ActorRole>;
  readonly requiresConfirmation?: boolean;

  /**
   * The actual execution. Runs ONLY after the kernel returns EXECUTE for
   * an envelope whose `kind` matches `intentKind` and whose payload
   * satisfies `inputSchema`. The ctx argument is the runtime's per-turn
   * Capsule (forward-declared as `unknown` here to avoid a cycle).
   */
  readonly execute: (input: I, ctx: unknown) => Promise<O>;
}
