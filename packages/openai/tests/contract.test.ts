/**
 * Contract test — runs the shared ModelProvider conformance suite from
 * `@claustrum/core/test-doubles` against OpenAIProvider, backed by the
 * in-package SDK fake.
 *
 * OpenAI HAS native embeddings, so we exercise the full contract including
 * `embed()`.
 */

import { describe, expect, it } from "vitest";
import { runModelProviderContract } from "@claustrum/core/test-doubles";
import { OpenAIProvider } from "../src/provider.js";
import { FakeOpenAIClient } from "./fake-sdk.js";

runModelProviderContract({
  factory: () => new OpenAIProvider({ client: new FakeOpenAIClient() }),
  surface: {
    describe,
    it,
    expect: (actual) => ({
      toBeDefined: () => expect(actual).toBeDefined(),
      toBe: (expected) => expect(actual).toBe(expected),
      toBeGreaterThan: (expected) =>
        expect(actual as unknown as number).toBeGreaterThan(expected),
      toContain: (expected) =>
        expect(actual as unknown as Array<unknown> | string).toContain(
          expected as never,
        ),
    }),
  },
});
