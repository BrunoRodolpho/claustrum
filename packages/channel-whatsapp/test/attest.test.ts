/**
 * attestWithGatewayKey — deterministic HMAC-SHA256 over canonical envelope.
 *
 * Tests verify:
 *  - signature is deterministic for the same envelope + key
 *  - signature changes when envelope content changes (different payload)
 *  - signature changes when signing key changes
 *  - actor enrichment is reflected in signed envelope
 *  - SignedEnvelope shape conforms to ChannelDriver contract
 */

import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { buildEnvelope, canonicalJson } from "@adjudicate/core";
import { attestWithGatewayKey } from "../src/attest.js";

const SIGNING_KEY = "gateway-secret-key-32-chars-deadbeef";

function makeEnvelope() {
  return buildEnvelope({
    kind: "test.refund",
    payload: { amount: 1000, currency: "USD" },
    actor: { principal: "llm", sessionId: "sess-attest" },
    taint: "UNTRUSTED",
    nonce: "nonce-attest-1",
    createdAt: "2024-06-01T12:00:00.000Z",
  });
}

describe("attestWithGatewayKey", () => {
  it("produces a deterministic signature for the same input", async () => {
    const env = makeEnvelope();
    const s1 = await attestWithGatewayKey(env, SIGNING_KEY, {
      channel: "whatsapp",
      gateway: "whatsapp:+14155551234",
    });
    const s2 = await attestWithGatewayKey(env, SIGNING_KEY, {
      channel: "whatsapp",
      gateway: "whatsapp:+14155551234",
    });
    expect(s1.signature).toBe(s2.signature);
    expect(s1.alg).toBe("HMAC-SHA256");
    expect(s1.keyId).toBe("gateway-default");
  });

  it("matches an independently-computed HMAC over canonical bytes of enriched envelope", async () => {
    const env = makeEnvelope();
    const signed = await attestWithGatewayKey(env, SIGNING_KEY, {
      channel: "whatsapp",
      gateway: "whatsapp:+14155551234",
    });
    const expected = createHmac("sha256", SIGNING_KEY)
      .update(canonicalJson(signed.envelope), "utf8")
      .digest("hex");
    expect(signed.signature).toBe(expected);
  });

  it("changes signature when payload changes (envelope-bound)", async () => {
    const env1 = buildEnvelope({
      kind: "test.refund",
      payload: { amount: 1000 },
      actor: { principal: "llm", sessionId: "s" },
      taint: "UNTRUSTED",
      nonce: "n1",
    });
    const env2 = buildEnvelope({
      kind: "test.refund",
      payload: { amount: 2000 },
      actor: { principal: "llm", sessionId: "s" },
      taint: "UNTRUSTED",
      nonce: "n1",
    });
    const s1 = await attestWithGatewayKey(env1, SIGNING_KEY, {
      channel: "whatsapp",
      gateway: "wa:+1",
    });
    const s2 = await attestWithGatewayKey(env2, SIGNING_KEY, {
      channel: "whatsapp",
      gateway: "wa:+1",
    });
    expect(s1.signature).not.toBe(s2.signature);
  });

  it("changes signature when signing key changes", async () => {
    const env = makeEnvelope();
    const a = await attestWithGatewayKey(env, "key-a", {
      channel: "whatsapp",
      gateway: "wa:+1",
    });
    const b = await attestWithGatewayKey(env, "key-b", {
      channel: "whatsapp",
      gateway: "wa:+1",
    });
    expect(a.signature).not.toBe(b.signature);
  });

  it("enriches actor with channel + gateway in signed envelope", async () => {
    const env = makeEnvelope();
    const signed = await attestWithGatewayKey(env, SIGNING_KEY, {
      channel: "whatsapp",
      gateway: "whatsapp:+14155551234",
    });
    const actor = signed.envelope.actor as Record<string, unknown>;
    expect(actor.channel).toBe("whatsapp");
    expect(actor.gateway).toBe("whatsapp:+14155551234");
    // Original principal + sessionId preserved.
    expect(actor.principal).toBe("llm");
    expect(actor.sessionId).toBe("sess-attest");
  });

  it("honors custom keyId in SignedEnvelope", async () => {
    const env = makeEnvelope();
    const signed = await attestWithGatewayKey(env, SIGNING_KEY, {
      channel: "whatsapp",
      gateway: "wa:+1",
      keyId: "rotation-2024-06",
    });
    expect(signed.keyId).toBe("rotation-2024-06");
  });

  it("rejects empty signing key", async () => {
    const env = makeEnvelope();
    await expect(
      attestWithGatewayKey(env, "", { channel: "whatsapp", gateway: "wa:+1" }),
    ).rejects.toThrow(/empty signing key/);
  });
});
