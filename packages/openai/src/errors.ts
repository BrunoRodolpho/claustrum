/**
 * Vendor → CompletionError translation for the OpenAI SDK.
 *
 * OpenAI SDK error classes:
 *  - `APIError` (with `status` + `headers` + nested `error`)
 *  - `APIConnectionError` / `APIConnectionTimeoutError`
 *  - `APIUserAbortError`
 *  - `RateLimitError` (status 429)
 *  - `AuthenticationError` (401) / `PermissionDeniedError` (403)
 *  - `BadRequestError` (400) — sometimes carries `code: "context_length_exceeded"`
 *  - `InternalServerError` (5xx)
 *
 * Translation mirrors the Anthropic adapter so the runtime can treat both
 * vendors uniformly. The shared error taxonomy is what makes the
 * `ModelProvider` port truly drop-in.
 */

import { CompletionError } from "@claustrum/core";

export interface OpenAIErrorShape {
  readonly name?: string;
  readonly status?: number;
  readonly message?: string;
  readonly headers?: Record<string, string | undefined> | Headers;
  readonly error?: {
    readonly type?: string;
    readonly code?: string;
    readonly message?: string;
  };
  readonly code?: string;
}

function getHeader(
  headers: OpenAIErrorShape["headers"],
  name: string,
): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  if (typeof (headers as Headers).get === "function") {
    const v = (headers as Headers).get(name);
    return v === null ? undefined : v;
  }
  const dict = headers as Record<string, string | undefined>;
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

export function translateOpenAIError(err: unknown): CompletionError {
  if (err instanceof CompletionError) {
    return err;
  }

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
        err.message || "OpenAI connection timed out",
        { cause: err },
      );
    }
    if (name === "APIConnectionError") {
      return new CompletionError(
        "network",
        err.message || "OpenAI network error",
        { cause: err },
      );
    }
  }

  const shape = err as OpenAIErrorShape;
  const status = shape.status;
  const vendorMessage =
    shape.error?.message ?? shape.message ?? "OpenAI API error";
  const vendorCode = shape.error?.code ?? shape.code;

  if (typeof status === "number") {
    if (status === 429) {
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
      // OpenAI emits explicit `context_length_exceeded` codes. Fall back to
      // message-content sniffing for older SDK versions.
      const isContext =
        vendorCode === "context_length_exceeded" ||
        lowered.includes("context length") ||
        lowered.includes("maximum context") ||
        lowered.includes("context window");
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
