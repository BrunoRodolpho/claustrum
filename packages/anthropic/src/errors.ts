/**
 * Vendor → CompletionError translation for the Anthropic SDK.
 *
 * The Anthropic SDK (`@anthropic-ai/sdk`) emits typed errors:
 *  - `APIError` (with `status` + `headers`)
 *  - `APIConnectionError`
 *  - `APIConnectionTimeoutError`
 *  - `APIUserAbortError`
 *  - `RateLimitError` (subclass of APIError, status 429)
 *  - `AuthenticationError` / `PermissionDeniedError` (401 / 403)
 *  - `BadRequestError` (400)
 *  - `InternalServerError` (5xx)
 *
 * We translate to `CompletionErrorCode` per the runtime contract. The
 * load-bearing case is `429` → `rate_limit` with `retryAfterMs` extracted
 * from the `Retry-After` response header.
 */

import { CompletionError } from "@claustrum/core";

/**
 * Shape of the relevant fields on an Anthropic SDK error. We avoid
 * importing the SDK directly so tests can pass plain objects.
 */
export interface AnthropicErrorShape {
  readonly name?: string;
  readonly status?: number;
  readonly message?: string;
  readonly headers?: Record<string, string | undefined> | Headers;
  readonly error?: { readonly type?: string; readonly message?: string };
}

function getHeader(
  headers: AnthropicErrorShape["headers"],
  name: string,
): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  // Headers (web fetch) — has `.get`.
  if (typeof (headers as Headers).get === "function") {
    const v = (headers as Headers).get(name);
    return v === null ? undefined : v;
  }
  const dict = headers as Record<string, string | undefined>;
  // Case-insensitive lookup.
  for (const key of Object.keys(dict)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return dict[key];
    }
  }
  return undefined;
}

function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  // Retry-After is either an integer-seconds value or an HTTP-date.
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.floor(asNumber * 1000);
  }
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/**
 * Translate any Anthropic SDK error (or shape-compatible plain object) to a
 * `CompletionError`. Pass-through if `err` is already a CompletionError.
 */
export function translateAnthropicError(err: unknown): CompletionError {
  if (err instanceof CompletionError) {
    return err;
  }

  // AbortError / APIUserAbortError → cancelled.
  if (err instanceof Error) {
    const name = err.name;
    if (
      name === "APIUserAbortError" ||
      name === "AbortError" ||
      (err as { code?: string }).code === "ABORT_ERR"
    ) {
      return new CompletionError("cancelled", err.message || "request aborted", {
        cause: err,
      });
    }
    if (name === "APIConnectionTimeoutError") {
      return new CompletionError(
        "timeout",
        err.message || "Anthropic connection timed out",
        { cause: err },
      );
    }
    if (name === "APIConnectionError") {
      return new CompletionError(
        "network",
        err.message || "Anthropic network error",
        { cause: err },
      );
    }
  }

  const shape = err as AnthropicErrorShape;
  const status = shape.status;
  const vendorMessage =
    shape.error?.message ?? shape.message ?? "Anthropic API error";

  if (typeof status === "number") {
    if (status === 429) {
      // `retryAfterMs` is consumed by `retryWithBackoff` from @claustrum/core
      // (NetworkReviewer-011). Wiring that helper into `complete()` here is a
      // tracked follow-up — the helper is landed and unit-tested in core.
      const retryAfterMs = parseRetryAfterMs(
        getHeader(shape.headers, "retry-after"),
      );
      return new CompletionError("rate_limit", vendorMessage, {
        vendorStatus: status,
        vendorMessage,
        retryAfterMs,
        cause: err,
      });
    }
    if (status === 401 || status === 403) {
      return new CompletionError("auth", vendorMessage, {
        vendorStatus: status,
        vendorMessage,
        cause: err,
      });
    }
    if (status === 400) {
      const lowered = vendorMessage.toLowerCase();
      const isContext =
        lowered.includes("context") ||
        lowered.includes("max_tokens") ||
        lowered.includes("token") && lowered.includes("limit");
      return new CompletionError(
        isContext ? "context_overflow" : "bad_request",
        vendorMessage,
        {
          vendorStatus: status,
          vendorMessage,
          cause: err,
        },
      );
    }
    if (status >= 500 && status < 600) {
      return new CompletionError("vendor_5xx", vendorMessage, {
        vendorStatus: status,
        vendorMessage,
        cause: err,
      });
    }
  }

  return new CompletionError(
    "unknown",
    vendorMessage,
    typeof status === "number"
      ? { vendorStatus: status, vendorMessage, cause: err }
      : { vendorMessage, cause: err },
  );
}
