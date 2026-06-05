/**
 * AuthReviewer-010: rotation-aware gateway attestation. Signing uses `current`;
 * verification accepts `current` OR `previous` so a key rollover keeps honoring
 * envelopes signed with the prior key during the overlap window.
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { buildEnvelope, canonicalJson } from "@adjudicate/core";
import type { SignedEnvelope } from "../src/index.js";
import {
  resolveGatewaySigningKey,
  verifyGatewayAttestation,
} from "../src/index.js";

const ENV = buildEnvelope({
  kind: "order.submit",
  payload: { sku: "X", qty: 1 },
  actor: { principal: "user", sessionId: "s-1" },
  taint: "UNTRUSTED",
  nonce: "n-1",
  createdAt: "2026-05-20T00:00:00.000Z",
});

function signWith(key: string): SignedEnvelope {
  const signature = createHmac("sha256", key)
    .update(canonicalJson(ENV), "utf8")
    .digest("hex");
  return { envelope: ENV, signature, keyId: "k", alg: "HMAC-SHA256" };
}

describe("resolveGatewaySigningKey", () => {
  it("returns a bare string verbatim", () => {
    expect(resolveGatewaySigningKey("key-a")).toBe("key-a");
  });
  it("returns the provider's current key (never previous)", () => {
    expect(
      resolveGatewaySigningKey({ current: "new", previous: "old" }),
    ).toBe("new");
  });
  it("throws on an empty string", () => {
    expect(() => resolveGatewaySigningKey("")).toThrow(/empty signing key/);
  });
  it("throws on a provider with an empty current key", () => {
    expect(() => resolveGatewaySigningKey({ current: "" })).toThrow(
      /empty signing key/,
    );
  });
});

describe("verifyGatewayAttestation", () => {
  it("accepts a signature made with a bare string key", () => {
    expect(verifyGatewayAttestation(signWith("key-a"), "key-a")).toBe(true);
  });

  it("accepts a signature made with the provider's current key", () => {
    const signed = signWith("new");
    expect(
      verifyGatewayAttestation(signed, { current: "new", previous: "old" }),
    ).toBe(true);
  });

  it("accepts a signature made with the provider's PREVIOUS key (rollover window)", () => {
    // Envelope was signed with "old" before rotation; after rotation the live
    // provider is {current:"new", previous:"old"} — verification must still pass.
    const signedBeforeRotation = signWith("old");
    expect(
      verifyGatewayAttestation(signedBeforeRotation, {
        current: "new",
        previous: "old",
      }),
    ).toBe(true);
  });

  it("rejects a signature made with a key that is neither current nor previous", () => {
    const signed = signWith("attacker");
    expect(
      verifyGatewayAttestation(signed, { current: "new", previous: "old" }),
    ).toBe(false);
  });

  it("rejects once the previous key ages out (provider drops it)", () => {
    const signedWithOld = signWith("old");
    expect(verifyGatewayAttestation(signedWithOld, { current: "new" })).toBe(
      false,
    );
  });

  it("rejects a tampered envelope (signature no longer matches the bytes)", () => {
    const signed = signWith("key-a");
    const tampered: SignedEnvelope = {
      ...signed,
      envelope: { ...signed.envelope, payload: { sku: "X", qty: 999 } },
    };
    expect(verifyGatewayAttestation(tampered, "key-a")).toBe(false);
  });

  it("rejects an unknown algorithm without throwing", () => {
    const signed = { ...signWith("key-a"), alg: "HMAC-SHA1" } as SignedEnvelope;
    expect(verifyGatewayAttestation(signed, "key-a")).toBe(false);
  });

  it("never widens acceptance to the empty key via previous:''", () => {
    // A signature forged with the empty key must NOT verify just because the
    // provider carries previous:"".
    const signedWithEmpty = signWith("");
    expect(
      verifyGatewayAttestation(signedWithEmpty, { current: "new", previous: "" }),
    ).toBe(false);
  });
});
