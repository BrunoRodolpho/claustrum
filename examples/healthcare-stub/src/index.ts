/* eslint-disable no-console -- Example app writes user-facing stdout. */
/**
 * healthcare-stub — claustrum reference app demonstrating the
 * REQUEST_CONFIRMATION → resume flow on a healthcare-shaped tool surface.
 *
 * **NOT HIPAA-compliant — structural demo only.** No PHI handling, no
 * BAA, no audit retention policy, no data-residency boundary. The
 * example exists to show how a real adopter would compose claustrum
 * around a confirmation-gated workflow; production healthcare deployments
 * need every box on the HIPAA checklist.
 *
 * Capabilities (both flagged `requiresConfirmation: true`):
 *   - appointment.schedule
 *   - prescription.refill_request
 *
 * Flow:
 *   Turn 1: user asks to schedule. The custom adjudicator returns
 *           REQUEST_CONFIRMATION; the session parks the envelope.
 *   Turn 2: user replies "yes". The runtime re-adjudicates and the
 *           adjudicator returns EXECUTE; the tool runs.
 */

import {
  buildEnvelope,
  type AuditRecord,
  type Decision,
  type IntentEnvelope,
  type Refusal,
} from "@adjudicate/core";
import {
  createConductor as createConductorCore,
  createToolRegistry,
  handleTurn,
  type Adjudicator,
  type AuditVerification,
  type CapabilityId,
  type Conductor,
  type DraftResponse,
  type ExplainerPort,
  type HandoffPort,
  type IntentKind,
  type OutcomeFilter,
  type OutcomeRow,
  type Plan,
  type PlannerPort,
  type PolicyBundle,
  type ResponderPort,
  type SystemState,
  type TenantResolver,
  type ToolDefinition,
} from "@claustrum/core";
import {
  EmptyGroundingProvider,
  InMemoryMemoryProvider,
  InMemorySessionStore,
  RecordingTelemetrySink,
  WebChannelStub,
} from "@claustrum/core/test-doubles";
import { z } from "zod";

// ── Capabilities ────────────────────────────────────────────────────────────

const APPT_SCHEDULE = "appointment.schedule" as CapabilityId;
const RX_REFILL = "prescription.refill_request" as CapabilityId;
const APPT_INTENT = "appointment.schedule" as IntentKind;
const RX_INTENT = "prescription.refill_request" as IntentKind;

const AppointmentSchema = z.object({
  patientId: z.string().min(1),
  iso: z.string().min(1),
  reason: z.string().optional(),
});
const RefillSchema = z.object({
  patientId: z.string().min(1),
  rxId: z.string().min(1),
});

// ── A confirmation-gated Adjudicator stub ──────────────────────────────────

class ConfirmingAdjudicator implements Adjudicator {
  /** Set of intentHashes that have been confirmed by the user. */
  private readonly confirmed = new Set<string>();

  /** Mark an envelope as user-confirmed; subsequent adjudicate yields EXECUTE. */
  confirm(intentHash: string): void {
    this.confirmed.add(intentHash);
  }

  async adjudicate(
    envelope: IntentEnvelope,
    _state: SystemState,
    _policy: PolicyBundle,
  ): Promise<Decision> {
    void _state;
    void _policy;
    if (this.confirmed.has(envelope.intentHash)) {
      return { kind: "EXECUTE", basis: [] };
    }
    return {
      kind: "REQUEST_CONFIRMATION",
      prompt: `Please confirm: ${String(envelope.kind)}. Reply "yes" to proceed.`,
      basis: [],
    };
  }

  async adjudicatePlan(
    envelopes: ReadonlyArray<IntentEnvelope>,
    state: SystemState,
    policy: PolicyBundle,
  ): Promise<Decision> {
    // Plan adjudication delegates to the single-envelope path for the
    // first envelope. Real adopters check transactional all-or-nothing.
    const first = envelopes[0];
    if (first === undefined) return { kind: "EXECUTE", basis: [] };
    return this.adjudicate(first, state, policy);
  }

  async replayEnvelopesByCustomerId(): Promise<ReadonlyArray<AuditRecord>> {
    return [];
  }
  streamAuditByIntentHashPrefix(): AsyncIterable<AuditRecord> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<AuditRecord> {
        return {
          async next(): Promise<IteratorResult<AuditRecord>> {
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
  async getOutcomes(_filter: OutcomeFilter): Promise<ReadonlyArray<OutcomeRow>> {
    void _filter;
    return [];
  }
  verifyAuditRecord(_record: AuditRecord): AuditVerification {
    void _record;
    return { ok: true };
  }
}

// ── Ports ───────────────────────────────────────────────────────────────────

function makePlanner(sessionRef: { current: () => { pendingConfirmations: ReadonlyArray<{ envelope: IntentEnvelope }> } }): PlannerPort {
  return {
    async propose(state): Promise<Plan> {
      const text = state.perception.text.toLowerCase();
      // If the user says "yes" / "confirm", resurface the most recently
      // parked envelope verbatim. Real adopters match against the
      // session's pendingConfirmations using a richer matcher (see
      // @claustrum/channel-whatsapp/parked-match.ts for the production
      // pattern). The demo keeps it simple.
      const session = sessionRef.current();
      if (
        (text === "yes" || text.includes("confirm")) &&
        session.pendingConfirmations.length > 0
      ) {
        const last =
          session.pendingConfirmations[session.pendingConfirmations.length - 1];
        if (last !== undefined) {
          return {
            envelopes: [last.envelope],
            capabilities: [String(last.envelope.kind)],
            rationale: "resume-parked-confirmation",
          };
        }
      }

      let kind: string;
      let payload: unknown;
      if (text.includes("refill") || text.includes("prescription")) {
        kind = "prescription.refill_request";
        payload = { patientId: "demo-patient", rxId: "rx-12345" };
      } else {
        kind = "appointment.schedule";
        payload = {
          patientId: "demo-patient",
          iso: "2026-05-20T15:00:00Z",
          reason: "annual checkup",
        };
      }
      // Use a stable nonce keyed on the conversation, not the per-turn
      // turnId, so the resulting intentHash matches between the
      // confirmation-requesting turn and the confirmation-acknowledging
      // turn. Real adopters persist the nonce on first submission.
      const envelope = buildEnvelope({
        kind,
        payload,
        actor: { principal: "llm", sessionId: state.conversationId },
        taint: "TRUSTED",
        nonce: `nonce-${state.conversationId}-${kind}`,
      }) as IntentEnvelope;
      return {
        envelopes: [envelope],
        capabilities: [String(envelope.kind)],
      };
    },
  };
}

function makeResponder(): ResponderPort {
  return {
    async respond(input): Promise<DraftResponse> {
      switch (input.decision.kind) {
        case "EXECUTE":
          return { text: `Action confirmed and executed.` };
        case "REFUSE":
          return { text: input.decision.refusal.userFacing };
        case "REQUEST_CONFIRMATION":
          return { text: input.decision.prompt };
        case "DEFER":
          return { text: `Deferred (signal=${input.decision.signal}).` };
        case "ESCALATE":
          return { text: `Escalating to ${input.decision.to}.` };
        case "REWRITE":
          return { text: "Rewritten and executed." };
      }
    },
  };
}

function makeExplainer(): ExplainerPort {
  return { render: (refusal: Refusal): string => refusal.userFacing };
}

function makeHandoff(): HandoffPort {
  return {
    async queue(): Promise<void> {
      /* no-op */
    },
  };
}

function makeTenantResolver(): TenantResolver {
  return {
    async resolve() {
      return {
        tenant: {
          tenantId: "healthcare-stub",
          displayName: "Healthcare Stub",
          locale: "en-US",
          environment: "dev" as const,
        },
        state: {},
        policy: {},
      };
    },
  };
}

function makeAppointmentTool(): ToolDefinition<
  { patientId: string; iso: string; reason?: string },
  { scheduled: boolean; id: string }
> {
  return {
    id: "appointment.schedule.v1",
    capability: APPT_SCHEDULE,
    description: "Schedule a clinic appointment for a patient.",
    inputSchema: AppointmentSchema,
    outputSchema: z.object({ scheduled: z.boolean(), id: z.string() }),
    intentKind: APPT_INTENT,
    riskLevel: "medium",
    requiresConfirmation: true,
    async execute(input): Promise<{ scheduled: boolean; id: string }> {
      return { scheduled: true, id: `appt-${input.patientId}-${input.iso}` };
    },
  };
}

function makeRefillTool(): ToolDefinition<
  { patientId: string; rxId: string },
  { queued: boolean; id: string }
> {
  return {
    id: "prescription.refill_request.v1",
    capability: RX_REFILL,
    description: "Queue a prescription refill for clinician review.",
    inputSchema: RefillSchema,
    outputSchema: z.object({ queued: z.boolean(), id: z.string() }),
    intentKind: RX_INTENT,
    riskLevel: "high",
    requiresConfirmation: true,
    async execute(input): Promise<{ queued: boolean; id: string }> {
      return { queued: true, id: `rx-req-${input.patientId}-${input.rxId}` };
    },
  };
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

export interface HealthcareBundle {
  readonly conductor: Conductor;
  readonly adjudicator: ConfirmingAdjudicator;
}

export function createHealthcareConductor(): HealthcareBundle {
  const tools = createToolRegistry();
  tools.register(makeAppointmentTool());
  tools.register(makeRefillTool());

  const adjudicator = new ConfirmingAdjudicator();
  const session = new InMemorySessionStore();
  const conductor = createConductorCore({
    adjudicator,
    memory: new InMemoryMemoryProvider(),
    grounding: new EmptyGroundingProvider(),
    planner: makePlanner({
      current: () => session.current(),
    }),
    responder: makeResponder(),
    explainer: makeExplainer(),
    handoff: makeHandoff(),
    telemetry: new RecordingTelemetrySink(),
    session,
    tools,
    channels: [new WebChannelStub()],
    tenantResolver: makeTenantResolver(),
  });
  return { conductor, adjudicator };
}

/** Alias for the CLI loader (`claustrum conformance --conductor ...`). */
export function createConductor(): Conductor {
  return createHealthcareConductor().conductor;
}

async function main(): Promise<void> {
  const { conductor, adjudicator } = createHealthcareConductor();

  // ── Turn 1: ask to schedule; expect REQUEST_CONFIRMATION ──────────────
  const turn1Inbound = {
    channel: "web" as const,
    customerId: "demo-patient",
    conversationId: "hc-conv",
    text: "I'd like to schedule an appointment",
    receivedAt: new Date().toISOString(),
  };
  const capsule1 = await conductor.openCapsule({
    channel: turn1Inbound.channel,
    customerId: turn1Inbound.customerId,
    inbound: turn1Inbound,
  });
  const turn1 = await handleTurn(capsule1, turn1Inbound);
  await conductor.closeCapsule(capsule1);
  console.warn("turn 1");
  console.warn("  decision.kind :", turn1.decision.kind);
  console.warn("  response      :", turn1.response.text);

  const parkedHash = turn1.plan.envelopes[0]?.intentHash;
  if (parkedHash === undefined) {
    console.error("No envelope parked — aborting demo.");
    process.exit(1);
  }
  // Pre-confirm the parked envelope for turn 2 (the real adopter would
  // match the user's "yes" against the parked envelope via channel
  // logic; the stub adjudicator just trusts the hash here).
  adjudicator.confirm(parkedHash);

  // ── Turn 2: user replies "yes"; expect EXECUTE on the parked envelope ──
  const turn2Inbound = {
    channel: "web" as const,
    customerId: "demo-patient",
    conversationId: "hc-conv",
    text: "yes",
    receivedAt: new Date().toISOString(),
  };
  const capsule2 = await conductor.openCapsule({
    channel: turn2Inbound.channel,
    customerId: turn2Inbound.customerId,
    inbound: turn2Inbound,
  });
  // The "yes" planner re-proposes the same envelope shape; nonce reuse
  // by the planner is intentional so the intentHash matches the parked
  // envelope. Real adopters key off `session.pendingConfirmations` and
  // re-submit the parked envelope verbatim.
  const turn2 = await handleTurn(capsule2, turn2Inbound);
  await conductor.closeCapsule(capsule2);
  console.warn("turn 2");
  console.warn("  decision.kind :", turn2.decision.kind);
  console.warn("  response      :", turn2.response.text);
}

const isMain =
  import.meta.url ===
  ("file://" + (process.argv[1] ?? "").replace(/\\/g, "/"));
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
