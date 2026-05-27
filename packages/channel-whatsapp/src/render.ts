/**
 * Outbound WhatsApp rendering.
 *
 * Two responsibilities:
 *  1. Chunk a long response into ≤4096-char pieces at sentence boundaries.
 *  2. Send each chunk via Twilio with retry on 429 (rate-limit) using the
 *     `Retry-After` header when present, plus a fixed inter-chunk sleep
 *     to stay under Twilio's ~1 msg/sec/sender cap.
 *
 * We call the Twilio REST API directly via `fetch` rather than the npm
 * `twilio` SDK. The SDK works but pulls in a heavy dependency graph and
 * a stale request library; the REST surface we need is small (one POST
 * to `/Messages.json` with Basic auth + form-encoded body), and going
 * direct keeps the adapter testable with a stub `fetch` injection. The
 * `twilio` package is still listed as a dependency so adopters can opt
 * into the typed SDK if they prefer.
 */

const WHATSAPP_MAX_CHARS = 4096;

export interface SplitOptions {
  readonly maxChars?: number;
}

/**
 * Split `text` into ≤`maxChars` chunks at sentence boundaries (`.`, `!`, `?`,
 * newline). Falls back to a hard slice if a single sentence exceeds the limit.
 * Trims interior whitespace between chunks but preserves intra-chunk content.
 */
export function splitForWhatsApp(
  text: string,
  maxChars: number = WHATSAPP_MAX_CHARS,
): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    // Find the last sentence boundary in [0, maxChars].
    const window = remaining.slice(0, maxChars);
    let breakAt = -1;
    for (let i = window.length - 1; i >= 0; i--) {
      const ch = window[i];
      if (ch === "." || ch === "!" || ch === "?" || ch === "\n") {
        breakAt = i + 1;
        break;
      }
    }
    // No boundary found within window → hard slice at the limit. Prefer a
    // word boundary (space) if one exists in the last ~10% of the window.
    if (breakAt === -1) {
      const minWordBoundary = Math.floor(maxChars * 0.9);
      for (let i = maxChars - 1; i >= minWordBoundary; i--) {
        if (window[i] === " ") {
          breakAt = i + 1;
          break;
        }
      }
      if (breakAt === -1) breakAt = maxChars;
    }
    chunks.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt);
  }
  if (remaining.length > 0) chunks.push(remaining.trim());
  return chunks.filter((c) => c.length > 0);
}

export interface SendTwilioMessageInput {
  readonly accountSid: string;
  readonly authToken: string;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Override sleep in tests. Production uses `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxRetries?: number;
}

const DEFAULT_MAX_RETRIES = 3;

/**
 * POST a single message to Twilio. Retries up to `maxRetries` on HTTP 429
 * honoring `Retry-After` (seconds), falling back to 1s backoff. Other 4xx
 * fail fast; 5xx retries with linear backoff.
 */
export async function sendTwilioMessage(
  input: SendTwilioMessageInput,
): Promise<void> {
  const {
    accountSid,
    authToken,
    from,
    to,
    body,
    fetch = globalThis.fetch,
    sleep = defaultSleep,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = input;

  if (typeof fetch !== "function") {
    throw new Error("sendTwilioMessage: no fetch implementation available");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const form = new URLSearchParams({ From: from, To: to, Body: body });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    if (res.ok) return;

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const delayMs = parsePositiveSeconds(retryAfter) * 1000 || 1000;
      await sleep(delayMs);
      continue;
    }

    if (res.status >= 500) {
      await sleep(500 * (attempt + 1));
      continue;
    }

    const errBody = await safeReadBody(res);
    throw new Error(`Twilio send failed: ${res.status} ${errBody}`);
  }

  throw new Error(`Twilio send failed after ${maxRetries} retries`);
}

function parsePositiveSeconds(value: string | null): number {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable>";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
