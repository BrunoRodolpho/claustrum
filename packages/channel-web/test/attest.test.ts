/**
 * attestWebEnvelope — deterministic HMAC-SHA256 over canonical envelope
 * for the web channel.
 */

import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { buildEnvelope, canonicalJson } from "@adjudicate/core";
import { attestWebEnvelope } from "../src/attest.js";

const SIGNING_KEY = "web-gateway-secret-32-chars-cafe";

function makeEnvelope() {
  return buildEnvelope({
    kind: "test.checkout",
    payload: { cartId: "c-1" },
    actor: { principal: "llm", sessionId: "web-sess-1" },
    taint: "UNTRUSTED",
    nonce: "nonce-w-1",
    createdAt: "2024-06-01T12:00:00.000Z",
  });
}

describe("attestWebEnvelope", () => {
  it("produces a deterministic signature", async () => {
    const env = makeEnvelope();
    const a = await attestWebEnvelope(env, SIGNING_KEY, {
      gateway: "api.example.com",
    });
    const b = await attestWebEnvelope(env, SIGNING_KEY, {
      gateway: "api.example.com",
    });
    expect(a.signature).toBe(b.signature);
    expect(a.alg).toBe("HMAC-SHA256");
  });

  it("matches an independently-computed HMAC over canonical bytes", async () => {
    const env = makeEnvelope();
    const signed = await attestWebEnvelope(env, SIGNING_KEY, {
      gateway: "api.example.com",
    });
    const expected = createHmac("sha256", SIGNING_KEY)
      .update(canonicalJson(signed.envelope), "utf8")
      .digest("hex");
    expect(signed.signature).toBe(expected);
  });

  it("enriches actor with channel='web' and the configured gateway", async () => {
    const env = makeEnvelope();
    const signed = await attestWebEnvelope(env, SIGNING_KEY, {
      gateway: "api.example.com",
    });
    const actor = signed.envelope.actor as Record<string, unknown>;
    expect(actor.channel).toBe("web");
    expect(actor.gateway).toBe("api.example.com");
    expect(actor.principal).toBe("llm");
  });

  it("rejects empty signing key", async () => {
    const env = makeEnvelope();
    await expect(
      attestWebEnvelope(env, "", { gateway: "api.example.com" }),
    ).rejects.toThrow(/empty signing key/);
  });

  it("honors custom keyId", async () => {
    const env = makeEnvelope();
    const signed = await attestWebEnvelope(env, SIGNING_KEY, {
      gateway: "api.example.com",
      keyId: "k-2",
    });
    expect(signed.keyId).toBe("k-2");
  });
});
