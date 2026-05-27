/**
 * Twilio signature verification — must reject tampered bodies, missing
 * signatures, and length-mismatched attacker payloads without throwing.
 */

import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifyTwilioSignature } from "../src/twilio-signature.js";

const AUTH_TOKEN = "test-auth-token-32-chars-deadbeef";
const WEBHOOK_URL = "https://example.com/webhooks/twilio";

function sign(
  params: Record<string, string>,
  url: string = WEBHOOK_URL,
  token: string = AUTH_TOKEN,
): string {
  const keys = Object.keys(params).sort();
  let canonical = url;
  for (const k of keys) canonical += k + params[k];
  return createHmac("sha1", token).update(canonical, "utf8").digest("base64");
}

describe("verifyTwilioSignature", () => {
  it("accepts a correctly-signed canonical webhook", () => {
    const params = { From: "whatsapp:+14155551234", Body: "hello", MessageSid: "SM1" };
    const signature = sign(params);
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        signature,
        url: WEBHOOK_URL,
        params,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body (single character flip)", () => {
    const params = { From: "whatsapp:+14155551234", Body: "hello", MessageSid: "SM1" };
    const signature = sign(params);
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        signature,
        url: WEBHOOK_URL,
        params: { ...params, Body: "hellp" },
      }),
    ).toBe(false);
  });

  it("rejects an empty signature without throwing", () => {
    const params = { From: "whatsapp:+14155551234", Body: "hello" };
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        signature: "",
        url: WEBHOOK_URL,
        params,
      }),
    ).toBe(false);
  });

  it("rejects an empty auth token", () => {
    const params = { From: "whatsapp:+14155551234", Body: "hello" };
    expect(
      verifyTwilioSignature({
        authToken: "",
        signature: sign(params),
        url: WEBHOOK_URL,
        params,
      }),
    ).toBe(false);
  });

  it("rejects a signature of mismatched length (timing-safe-compare guard)", () => {
    const params = { From: "whatsapp:+14155551234", Body: "hello" };
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        signature: "short",
        url: WEBHOOK_URL,
        params,
      }),
    ).toBe(false);
    // Much-longer attacker-controlled signature.
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        signature: "A".repeat(500),
        url: WEBHOOK_URL,
        params,
      }),
    ).toBe(false);
  });

  it("is order-insensitive across params (canonical sort)", () => {
    const params = { Z: "last", A: "first", M: "middle" };
    const sig = sign(params);
    // Re-order the param object — sort should normalize.
    const reordered = { A: "first", Z: "last", M: "middle" };
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        signature: sig,
        url: WEBHOOK_URL,
        params: reordered,
      }),
    ).toBe(true);
  });

  it("ignores params with undefined values", () => {
    const params: Record<string, string | undefined> = {
      From: "whatsapp:+14155551234",
      Body: "hello",
      Optional: undefined,
    };
    // Recompute reference signature without Optional.
    const ref = sign({ From: "whatsapp:+14155551234", Body: "hello" });
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        signature: ref,
        url: WEBHOOK_URL,
        params,
      }),
    ).toBe(true);
  });

  it("rejects when the URL differs from what was signed", () => {
    const params = { From: "whatsapp:+14155551234", Body: "hello" };
    const sig = sign(params, "https://example.com/a");
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        signature: sig,
        url: "https://example.com/b",
        params,
      }),
    ).toBe(false);
  });
});
