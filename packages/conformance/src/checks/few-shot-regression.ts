/**
 * CC-006 — few-shot-regression.
 *
 * Few-shots are not static teaching data — they are a drift detector.
 * Each fixture in `fixtures/few-shots/*.json` records:
 *
 *   - a `conversation` of user/assistant messages (the user's last turn
 *     is the one we drive through `handleTurn`),
 *   - `expectedEnvelopeKinds` — the kernel-side `IntentEnvelope.kind`
 *     values the conductor's planner is expected to produce,
 *   - `expectedDecisionKind` — the Decision the kernel should return for
 *     the resulting envelope(s).
 *
 * Re-running every fixture through the current conductor + adjudicator
 * checks that policy edits, prompt-fragment edits, or planner edits have
 * not regressed teaching data. If a fixture diverges, the adopter either
 * intends the divergence (and updates the fixture) or doesn't (and rolls
 * back).
 *
 * Methodology:
 *  - Discover fixtures: `options.fixturesDir` or the package's bundled
 *    `fixtures/few-shots/` directory adjacent to `dist/`.
 *  - For each fixture, open a Capsule for a synthetic customer (named
 *    after the fixture id for traceability), drive the LAST user message
 *    of the conversation through `handleTurn`, and compare:
 *      - the set of envelope kinds the planner produced (deduplicated)
 *        against `expectedEnvelopeKinds`
 *      - the final Decision.kind against `expectedDecisionKind`
 *  - Mismatches are recorded; the suite passes when all fixtures match.
 *
 * Adopters with no fixtures: CC-006 passes vacuously with a note.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { handleTurn, type Conductor, type OpenCapsuleInput } from "@claustrum/core";
import type {
  ConformanceCheck,
  ConformanceOptions,
  ConformanceResult,
} from "../types.js";

interface FewShotFixture {
  readonly id: string;
  readonly scenario: string;
  readonly conversation: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: string;
  }>;
  readonly expectedEnvelopeKinds: ReadonlyArray<string>;
  readonly expectedDecisionKind: string;
  readonly tags?: ReadonlyArray<string>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function defaultFixturesDir(): string {
  // Source layout: packages/conformance/src/checks/few-shot-regression.ts
  //   → ../../fixtures/few-shots
  // Build layout: packages/conformance/dist/checks/few-shot-regression.js
  //   → ../../fixtures/few-shots
  return path.resolve(__dirname, "..", "..", "fixtures", "few-shots");
}

async function loadFixtures(dir: string): Promise<FewShotFixture[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: FewShotFixture[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const full = path.join(dir, entry);
    try {
      const raw = await fs.readFile(full, "utf8");
      const parsed = JSON.parse(raw) as FewShotFixture;
      // Defensive: skip malformed fixtures rather than throwing the whole suite.
      if (
        typeof parsed.id !== "string" ||
        !Array.isArray(parsed.conversation) ||
        !Array.isArray(parsed.expectedEnvelopeKinds) ||
        typeof parsed.expectedDecisionKind !== "string"
      ) {
        continue;
      }
      out.push(parsed);
    } catch {
      continue;
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function lastUserMessage(
  fixture: FewShotFixture,
): { content: string } | undefined {
  for (let i = fixture.conversation.length - 1; i >= 0; i--) {
    const m = fixture.conversation[i];
    if (m !== undefined && m.role === "user") {
      return { content: m.content };
    }
  }
  return undefined;
}

export const fewShotRegressionCheck: ConformanceCheck = {
  id: "CC-006",
  name: "Few-shot fixtures produce expected envelope kinds + Decision",
  async run(
    conductor: Conductor,
    options: ConformanceOptions,
  ): Promise<ConformanceResult> {
    const dir = options.fixturesDir ?? defaultFixturesDir();
    const fixtures = await loadFixtures(dir);

    if (fixtures.length === 0) {
      return {
        id: fewShotRegressionCheck.id,
        name: fewShotRegressionCheck.name,
        passed: true,
        details: `No few-shot fixtures discovered at ${dir}; invariant vacuously holds.`,
      };
    }

    const failures: string[] = [];
    let verified = 0;

    for (const fixture of fixtures) {
      const userMsg = lastUserMessage(fixture);
      if (userMsg === undefined) {
        failures.push(
          `fixture "${fixture.id}" has no user message in conversation; skipped`,
        );
        continue;
      }

      const inbound: OpenCapsuleInput = {
        channel: "web",
        customerId: `cc006-${fixture.id}`,
        inbound: {
          channel: "web",
          customerId: `cc006-${fixture.id}`,
          conversationId: `cc006-conv-${fixture.id}`,
          text: userMsg.content,
          receivedAt: "2026-05-18T00:00:00.000Z",
        },
      };

      let capsule;
      try {
        capsule = await conductor.openCapsule(inbound);
      } catch (err) {
        failures.push(
          `fixture "${fixture.id}": openCapsule threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      let result;
      try {
        result = await handleTurn(capsule, inbound.inbound);
      } catch (err) {
        await conductor.closeCapsule(capsule);
        failures.push(
          `fixture "${fixture.id}": handleTurn threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      await conductor.closeCapsule(capsule);

      const actualEnvelopeKinds = Array.from(
        new Set(result.plan.envelopes.map((e) => String(e.kind))),
      ).sort();
      const expectedEnvelopeKinds = Array.from(
        new Set(fixture.expectedEnvelopeKinds.map(String)),
      ).sort();

      if (
        actualEnvelopeKinds.length !== expectedEnvelopeKinds.length ||
        actualEnvelopeKinds.some((k, i) => k !== expectedEnvelopeKinds[i])
      ) {
        failures.push(
          `fixture "${fixture.id}": envelope kinds [${actualEnvelopeKinds.join(",")}] ≠ expected [${expectedEnvelopeKinds.join(",")}]`,
        );
        continue;
      }

      if (result.decision.kind !== fixture.expectedDecisionKind) {
        failures.push(
          `fixture "${fixture.id}": decision.kind=${result.decision.kind} ≠ expected ${fixture.expectedDecisionKind}`,
        );
        continue;
      }

      verified++;
    }

    if (failures.length > 0) {
      return {
        id: fewShotRegressionCheck.id,
        name: fewShotRegressionCheck.name,
        passed: false,
        details: `Few-shot regression: ${failures.join("; ")}`,
      };
    }

    return {
      id: fewShotRegressionCheck.id,
      name: fewShotRegressionCheck.name,
      passed: true,
      details: `Verified ${verified} few-shot fixture(s) against the current conductor.`,
    };
  },
};
