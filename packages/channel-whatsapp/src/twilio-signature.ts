/**
 * Twilio inbound webhook signature verification.
 *
 * Algorithm (per Twilio "Validating Signatures from Twilio" docs):
 *  1. Take the full URL Twilio POSTed to (including query string), exactly
 *     as Twilio constructed it. Behind a proxy use `X-Original-URL`.
 *  2. Sort POST parameter keys alphabetically.
 *  3. Append each `key + value` to the URL with no separator.
 *  4. HMAC-SHA1 with the auth token; Base64-encode the digest.
 *  5. Timing-safe-compare against `X-Twilio-Signature`.
 *
 * Reference: https://www.twilio.com/docs/usage/security#validating-requests
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyTwilioSignatureInput {
  readonly authToken: string;
  readonly signature: string;
  readonly url: string;
  readonly params: Record<string, string | undefined>;
}

/**
 * Returns true iff the supplied X-Twilio-Signature matches an HMAC-SHA1 over
 * the canonical Twilio string with the configured auth token.
 *
 * Designed to be safe against:
 *  - tampered body (a single character flip in any param fails)
 *  - empty signatures (false fast, no compare)
 *  - mismatched-length attacker control (timingSafeEqual rejects without
 *    leaking via early-exit)
 */
export function verifyTwilioSignature(input: VerifyTwilioSignatureInput): boolean {
  const { authToken, signature, url, params } = input;
  if (
    typeof authToken !== "string" ||
    authToken.length === 0 ||
    typeof signature !== "string" ||
    signature.length === 0 ||
    typeof url !== "string" ||
    url.length === 0
  ) {
    return false;
  }

  const keys = Object.keys(params)
    .filter((k) => params[k] !== undefined)
    .sort();

  let canonical = url;
  for (const k of keys) {
    canonical += k + (params[k] ?? "");
  }

  const expectedB64 = createHmac("sha1", authToken)
    .update(canonical, "utf8")
    .digest("base64");

  const expectedBuf = Buffer.from(expectedB64, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");

  // timingSafeEqual requires equal length. Different-length signatures are
  // an immediate fail — return false without invoking the primitive so we
  // don't throw on attacker-controlled lengths.
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  try {
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}
