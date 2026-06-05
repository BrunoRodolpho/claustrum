/**
 * wrapAnthropicSdk — unit test (TypeReviewer-007).
 *
 * Verifies the helper returns the input object cast to AnthropicClientLike
 * so adopters never need to write `as unknown as AnthropicClientLike` in
 * their own code.
 */

import { describe, expect, it } from "vitest";
import { wrapAnthropicSdk, type AnthropicClientLike } from "../src/index.js";
import { FakeAnthropicClient } from "./fake-sdk.js";

describe("wrapAnthropicSdk", () => {
  it("returns the same object reference typed as AnthropicClientLike", () => {
    const fake = new FakeAnthropicClient();
    const wrapped: AnthropicClientLike = wrapAnthropicSdk(fake);
    // Identity: no wrapping/proxying — the reference is preserved.
    expect(wrapped).toBe(fake);
  });

  it("the wrapped value exposes the messages surface required by AnthropicProvider", () => {
    const fake = new FakeAnthropicClient();
    const wrapped: AnthropicClientLike = wrapAnthropicSdk(fake);
    expect(typeof wrapped.messages.create).toBe("function");
    expect(typeof wrapped.messages.stream).toBe("function");
  });

  it("passes a plain object through unchanged (structural typing test)", () => {
    // Build the minimal shape that satisfies AnthropicClientLike.
    const minimalClient = {
      messages: {
        create: async () => ({
          model: "test",
          stop_reason: "end_turn" as const,
          content: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
        stream: () => {
          throw new Error("not implemented");
        },
      },
    };
    const wrapped: AnthropicClientLike = wrapAnthropicSdk(minimalClient);
    expect(wrapped).toBe(minimalClient);
  });
});
