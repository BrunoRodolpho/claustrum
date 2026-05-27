/**
 * Contract test — runs the shared ModelProvider conformance suite from
 * `@claustrum/core/test-doubles` against AnthropicProvider, backed by the
 * in-package SDK fake.
 *
 * If this test ever drifts from the InMemoryModelProvider baseline, the
 * port shape has shifted and we have to react — that's the entire point.
 */

import { describe, expect, it } from "vitest";
import { runModelProviderContract } from "@claustrum/core/test-doubles";
import { AnthropicProvider } from "../src/provider.js";
import { FakeAnthropicClient } from "./fake-sdk.js";

runModelProviderContract({
  factory: () =>
    new AnthropicProvider({ client: new FakeAnthropicClient() }),
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
  // No native embed; would throw not_implemented. The shared contract test
  // only enforces embed if `skipEmbed !== true`.
  skipEmbed: true,
});
