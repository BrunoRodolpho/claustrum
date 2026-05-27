/**
 * Phone-number helpers.
 *
 * Twilio sends `From` as `whatsapp:+E.164`. The runtime works in raw E.164
 * downstream; raw phone numbers must never appear in logs or audit fields,
 * so we hash before persisting.
 */

import { createHash } from "node:crypto";

const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Strip the `whatsapp:` prefix and validate E.164 form. Throws if the input
 * doesn't match — perceive() must reject malformed webhooks rather than
 * propagate bad customer ids.
 */
export function normalizePhone(from: string): string {
  if (typeof from !== "string" || from.length === 0) {
    throw new Error("normalizePhone: empty input");
  }
  const stripped = from.startsWith("whatsapp:") ? from.slice(9) : from;
  if (!E164_RE.test(stripped)) {
    throw new Error(`normalizePhone: not E.164: ${stripped}`);
  }
  return stripped;
}

/**
 * SHA-256 hash truncated to 12 hex chars. Used as a stable customer id in
 * log lines and as a non-reversible key for telemetry. 48 bits of entropy
 * is sufficient for tenant-scoped uniqueness and resistant to casual
 * de-anonymization.
 */
export function hashPhone(phone: string): string {
  return createHash("sha256").update(phone).digest("hex").slice(0, 12);
}
