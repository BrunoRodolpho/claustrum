/**
 * ToolRegistry — capability-indirected tool catalog.
 *
 * The registry holds ToolDefinitions by internal `id`. The runtime
 * exposes two read paths:
 *
 *   resolveCapabilities(ctx) -> CapabilityDescriptor[]
 *     What capabilities are visible this turn? Filtered by channel,
 *     role, and tenant (the planner uses this to advertise to the LLM).
 *
 *   resolveTool(capability, ctx) -> ToolDefinition
 *     Resolve LLM-emitted capability + tenant context -> implementation.
 *     The runtime calls this AFTER a Decision returns EXECUTE.
 *
 * Two tools with the same `capability` are allowed iff they discriminate
 * by tenant (or other axis baked into the resolution policy). The base
 * factory `createToolRegistry()` ships a last-write-wins resolver;
 * tenant-aware resolution is layered by the adopter.
 */

import type {
  CapabilityDescriptor,
  CapabilityId,
  ToolDefinition,
} from "./types.js";

export interface ToolRegistry {
  register<I, O>(tool: ToolDefinition<I, O>): void;

  /** Visible capability surface for a given context. */
  resolveCapabilities(ctx: unknown): ReadonlyArray<CapabilityDescriptor>;

  /**
   * Membership check: is at least one tool registered under this capability?
   *
   * Context-independent — it asks only "does this capability exist in the
   * catalog at all", NOT "is it visible/resolvable in the current ctx"
   * (that is {@link resolveTool}'s job). Used to validate an untrusted
   * `IntentEnvelope.kind` before branding it as a {@link CapabilityId}, so a
   * blind cast never mints a brand for a kind the registry has never heard of
   * (TypeReviewer-004). Visibility/tenant filtering still applies at
   * `resolveTool` time and can legitimately reject a capability that exists.
   */
  hasCapability(capability: string): boolean;

  /**
   * Resolve a capability + context to a concrete tool.
   * Throws when no matching tool is registered for the capability.
   */
  resolveTool(
    capability: CapabilityId,
    ctx: unknown,
  ): ToolDefinition<unknown, unknown>;

  /** All registered tools. Internal use (telemetry, conformance). */
  list(): ReadonlyArray<ToolDefinition<unknown, unknown>>;
}

interface RegistryOptions {
  /**
   * Optional tenant/channel/role-aware filter. Receives the registered
   * tool list + caller ctx; returns the subset visible right now.
   * Default: return all tools.
   */
  readonly visibility?: (
    tools: ReadonlyArray<ToolDefinition<unknown, unknown>>,
    ctx: unknown,
  ) => ReadonlyArray<ToolDefinition<unknown, unknown>>;

  /**
   * Optional tenant-aware capability resolution. Receives the candidates
   * (every tool registered for the capability) + ctx; returns the
   * winning tool. Default: last-registered wins.
   */
  readonly chooseImplementation?: (
    candidates: ReadonlyArray<ToolDefinition<unknown, unknown>>,
    ctx: unknown,
  ) => ToolDefinition<unknown, unknown> | undefined;
}

export function createToolRegistry(
  options: RegistryOptions = {},
): ToolRegistry {
  const byId = new Map<string, ToolDefinition<unknown, unknown>>();
  const byCapability = new Map<
    CapabilityId,
    Array<ToolDefinition<unknown, unknown>>
  >();

  const visibility =
    options.visibility ??
    ((tools) => tools);

  const chooseImplementation =
    options.chooseImplementation ??
    ((candidates) =>
      candidates.length === 0
        ? undefined
        : candidates[candidates.length - 1]);

  function descriptorOf(
    tool: ToolDefinition<unknown, unknown>,
  ): CapabilityDescriptor {
    return {
      capability: tool.capability,
      intentKind: tool.intentKind,
      description: tool.description,
      riskLevel: tool.riskLevel,
      ...(tool.requiresConfirmation !== undefined
        ? { requiresConfirmation: tool.requiresConfirmation }
        : {}),
      ...(tool.groundingRequirements !== undefined
        ? { groundingRequirements: tool.groundingRequirements }
        : {}),
    };
  }

  return {
    register<I, O>(tool: ToolDefinition<I, O>): void {
      const erased = tool as unknown as ToolDefinition<unknown, unknown>;
      byId.set(erased.id, erased);
      const list = byCapability.get(erased.capability) ?? [];
      list.push(erased);
      byCapability.set(erased.capability, list);
    },

    resolveCapabilities(ctx: unknown): ReadonlyArray<CapabilityDescriptor> {
      const visible = visibility(Array.from(byId.values()), ctx);
      // De-dupe by capability — surface one descriptor per capability.
      const seen = new Set<CapabilityId>();
      const out: CapabilityDescriptor[] = [];
      for (const tool of visible) {
        if (seen.has(tool.capability)) continue;
        seen.add(tool.capability);
        out.push(descriptorOf(tool));
      }
      return out;
    },

    hasCapability(capability: string): boolean {
      const candidates = byCapability.get(capability as CapabilityId);
      return candidates !== undefined && candidates.length > 0;
    },

    resolveTool(
      capability: CapabilityId,
      ctx: unknown,
    ): ToolDefinition<unknown, unknown> {
      const candidates = byCapability.get(capability) ?? [];
      const visible = visibility(candidates, ctx);
      const winner = chooseImplementation(visible, ctx);
      if (winner === undefined) {
        throw new Error(
          `No tool registered for capability "${capability}" in this context.`,
        );
      }
      return winner;
    },

    list(): ReadonlyArray<ToolDefinition<unknown, unknown>> {
      return Array.from(byId.values());
    },
  };
}
