/**
 * Error translation — every `CompletionErrorCode` variant.
 *
 * The runtime classifies failures by code (retriable rate_limit vs hard
 * auth vs context_overflow that needs prompt slimming). Drift here causes
 * silent regressions in retry behaviour — pin it with explicit cases.
 */

import { describe, expect, it } from "vitest";
import { CompletionError } from "@claustrum/core";
import { translateAnthropicError } from "../src/errors.js";

describe("translateAnthropicError", () => {
  it("429 → rate_limit + retryAfterMs from Retry-After (seconds)", () => {
    const err = translateAnthropicError({
      status: 429,
      message: "rate limit",
      headers: { "retry-after": "3" },
    });
    expect(err).toBeInstanceOf(CompletionError);
    expect(err.code).toBe("rate_limit");
    expect(err.retryAfterMs).toBe(3000);
    expect(err.vendorStatus).toBe(429);
  });

  it("429 → rate_limit handles missing Retry-After", () => {
    const err = translateAnthropicError({ status: 429, message: "rate limit" });
    expect(err.code).toBe("rate_limit");
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("429 → rate_limit handles HTTP-date Retry-After", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const err = translateAnthropicError({
      status: 429,
      message: "rate limit",
      headers: { "Retry-After": future },
    });
    expect(err.code).toBe("rate_limit");
    expect(err.retryAfterMs).toBeGreaterThan(3000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(6000);
  });

  it("401 → auth", () => {
    expect(translateAnthropicError({ status: 401, message: "bad key" }).code).toBe(
      "auth",
    );
  });

  it("403 → auth", () => {
    expect(translateAnthropicError({ status: 403, message: "forbidden" }).code).toBe(
      "auth",
    );
  });

  it("400 with 'context' → context_overflow", () => {
    expect(
      translateAnthropicError({
        status: 400,
        message: "prompt is too long for context",
      }).code,
    ).toBe("context_overflow");
  });

  it("400 without context keyword → bad_request", () => {
    expect(
      translateAnthropicError({
        status: 400,
        message: "invalid tool_schema",
      }).code,
    ).toBe("bad_request");
  });

  it("500 → vendor_5xx", () => {
    expect(translateAnthropicError({ status: 500, message: "boom" }).code).toBe(
      "vendor_5xx",
    );
  });

  it("503 → vendor_5xx", () => {
    expect(translateAnthropicError({ status: 503, message: "overloaded" }).code).toBe(
      "vendor_5xx",
    );
  });

  it("APIConnectionTimeoutError → timeout", () => {
    const err = new Error("timeout");
    err.name = "APIConnectionTimeoutError";
    expect(translateAnthropicError(err).code).toBe("timeout");
  });

  it("APIConnectionError → network", () => {
    const err = new Error("ECONNREFUSED");
    err.name = "APIConnectionError";
    expect(translateAnthropicError(err).code).toBe("network");
  });

  it("APIUserAbortError → cancelled", () => {
    const err = new Error("aborted");
    err.name = "APIUserAbortError";
    expect(translateAnthropicError(err).code).toBe("cancelled");
  });

  it("AbortError → cancelled", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(translateAnthropicError(err).code).toBe("cancelled");
  });

  it("unknown shape → unknown", () => {
    expect(translateAnthropicError("plain string").code).toBe("unknown");
    expect(translateAnthropicError({ status: 418 }).code).toBe("unknown");
  });

  it("passes through CompletionError unchanged", () => {
    const original = new CompletionError("rate_limit", "x");
    expect(translateAnthropicError(original)).toBe(original);
  });
});
