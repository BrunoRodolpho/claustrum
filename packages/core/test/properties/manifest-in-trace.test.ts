/**
 * PROPERTY: the prompt manifest is present in every LLM trace.
 *
 * Per PART I §"Prompt synthesis architecture": every prompt the runtime
 * sends to the LLM is composed from versioned, content-addressed
 * fragments. The `fragmentManifest` is the replay key. Every
 * `LLMTrace.promptManifest` MUST be an array (possibly empty in
 * synthetic tests, but always present).
 *
 * Iterations: 150.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  createFragmentRegistry,
  createPromptComposer,
} from "../../src/index.js";

const ITERATIONS = 150;

describe("PROPERTY: prompt manifest always present", () => {
  it(`holds for at least ${ITERATIONS} composed prompts`, async () => {
    let iterations = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 20 }),
            priority: fc.integer({ min: 0, max: 5 }),
            tokens: fc.integer({ min: 1, max: 100 }),
            content: fc.string({ minLength: 1, maxLength: 30 }),
          }),
          { minLength: 0, maxLength: 8 },
        ),
        fc.integer({ min: 100, max: 1000 }),
        async (rawFragments, budget) => {
          iterations += 1;
          const registry = createFragmentRegistry();
          let seq = 0;
          for (const f of rawFragments) {
            seq += 1;
            registry.register({
              id: `${f.id}-${seq}`,
              hash: `hash-${seq}`,
              priority: f.priority,
              tokens: f.tokens,
              content: () => f.content,
              applies: () => true,
            });
          }
          const composer = createPromptComposer({ registry });
          const ctx = {
            cognition: {
              perception: {
                text: "ping",
                channel: "web",
                receivedAt: "2025-01-01T00:00:00.000Z",
              },
              memory: {
                customerId: "c",
                episodic: [],
                semantic: [],
                procedural: [],
                relational: [],
                assembledAt: "2025-01-01T00:00:00.000Z",
              },
              retrieval: {
                docs: [],
                retrievedAt: "2025-01-01T00:00:00.000Z",
                modelId: "test",
              },
              tenantId: "t",
              locale: "pt-BR",
              conversationId: "conv",
              turnId: "turn",
            },
          };
          const composed = await composer.compose(ctx, {
            maxTokens: budget,
          });
          if (!Array.isArray(composed.fragmentManifest)) return false;
          // Manifest entries must all be present in the registry list.
          for (const id of composed.fragmentManifest) {
            if (registry.byId(id) === undefined) return false;
          }
          return true;
        },
      ),
      { numRuns: ITERATIONS },
    );
    expect(iterations).toBeGreaterThanOrEqual(ITERATIONS);
  });
});
