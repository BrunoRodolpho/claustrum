/**
 * WebChannel — sink invocation, perceive normalization, attestation
 * end-to-end through the ChannelDriver interface.
 */

import { describe, it, expect } from "vitest";
import { buildEnvelope } from "@adjudicate/core";
import type { RenderedResponse } from "@claustrum/core";
import { WebChannel } from "../src/web-channel.js";

const SIGNING_KEY = "web-sign-secret-32-chars-feedface";

function makeChannel(captured: RenderedResponse[]) {
  return new WebChannel({
    gatewaySigningKey: SIGNING_KEY,
    gateway: "api.example.com",
    sink: (response) => {
      captured.push(response);
    },
  });
}

describe("WebChannel", () => {
  it("perceive normalizes inbound JSON with defaults for missing fields", async () => {
    const ch = makeChannel([]);
    const msg = await ch.perceive({
      customerId: "user-42",
      text: "hello",
    });
    expect(msg.channel).toBe("web");
    expect(msg.customerId).toBe("user-42");
    expect(msg.text).toBe("hello");
    expect(msg.conversationId).toBe("web-user-42");
    expect(msg.externalId).toMatch(/^web-/);
    expect(typeof msg.receivedAt).toBe("string");
  });

  it("perceive preserves caller-supplied requestId as externalId", async () => {
    const ch = makeChannel([]);
    const msg = await ch.perceive({
      requestId: "req-xyz",
      customerId: "u",
      text: "x",
    });
    expect(msg.externalId).toBe("req-xyz");
  });

  it("perceive uses 'anonymous' when customerId is missing", async () => {
    const ch = makeChannel([]);
    const msg = await ch.perceive({ text: "hi" });
    expect(msg.customerId).toBe("anonymous");
  });

  it("perceive rejects non-object input", async () => {
    const ch = makeChannel([]);
    await expect(ch.perceive(null)).rejects.toThrow();
    await expect(ch.perceive("not an object")).rejects.toThrow();
  });

  it("render delivers to the injected sink callback", async () => {
    const captured: RenderedResponse[] = [];
    const ch = makeChannel(captured);
    const response: RenderedResponse = {
      channel: "web",
      customerId: "user-42",
      conversationId: "web-user-42",
      text: "Done.",
    };
    await ch.render(response);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual(response);
  });

  it("attest signs with HMAC-SHA256 and enriches actor", async () => {
    const ch = makeChannel([]);
    const env = buildEnvelope({
      kind: "test.kind",
      payload: { x: 1 },
      actor: { principal: "llm", sessionId: "s" },
      taint: "UNTRUSTED",
      nonce: "n",
    });
    const signed = await ch.attest(env);
    expect(signed.alg).toBe("HMAC-SHA256");
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
    const actor = signed.envelope.actor as Record<string, unknown>;
    expect(actor.channel).toBe("web");
    expect(actor.gateway).toBe("api.example.com");
  });

  it("constructor rejects missing config", () => {
    expect(
      () =>
        new WebChannel({
          gatewaySigningKey: "",
          gateway: "api.example.com",
          sink: () => undefined,
        }),
    ).toThrow();
    expect(
      () =>
        new WebChannel({
          gatewaySigningKey: "k",
          gateway: "",
          sink: () => undefined,
        }),
    ).toThrow();
  });
});
