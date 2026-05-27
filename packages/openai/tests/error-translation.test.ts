/**
 * Error translation — every `CompletionErrorCode` variant for OpenAI.
 *
 * The drift detector for retry behaviour. If the OpenAI SDK changes error
 * class names or status codes, these tests fail noisily before any
 * production traffic does.
 */

import { describe, expect, it } from "vitest";
import { CompletionError } from "@claustrum/core";
import { translateOpenAIError } from "../src/errors.js";

describe("translateOpenAIError", () => {
  it("429 → rate_limit + retryAfterMs from Retry-After (seconds)", () => {
    const err = translateOpenAIError({
      status: 429,
      message: "rate limit",
      headers: { "retry-after": "7" },
    });
    expect(err).toBeInstanceOf(CompletionError);
    expect(err.code).toBe("rate_limit");
    expect(err.retryAfterMs).toBe(7000);
    expect(err.vendorStatus).toBe(429);
  });

  it("429 → rate_limit with missing Retry-After leaves retryAfterMs undefined", () => {
    const err = translateOpenAIError({ status: 429, message: "rate limit" });
    expect(err.code).toBe("rate_limit");
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("429 → rate_limit with HTTP-date Retry-After", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const err = translateOpenAIError({
      status: 429,
      headers: { "Retry-After": future },
      message: "rate limit",
    });
    expect(err.code).toBe("rate_limit");
    expect(err.retryAfterMs).toBeGreaterThan(3000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(6000);
  });

  it("401 → auth", () => {
    expect(translateOpenAIError({ status: 401, message: "bad key" }).code).toBe(
      "auth",
    );
  });

  it("403 → auth", () => {
    expect(translateOpenAIError({ status: 403, message: "forbidden" }).code).toBe(
      "auth",
    );
  });

  it("400 with code=context_length_exceeded → context_overflow", () => {
    expect(
      translateOpenAIError({
        status: 400,
        message: "This model's maximum context length is 8192 tokens",
        error: { code: "context_length_exceeded", message: "context" },
      }).code,
    ).toBe("context_overflow");
  });

  it("400 with message containing 'context length' → context_overflow", () => {
    expect(
      translateOpenAIError({
        status: 400,
        message: "you exceeded the maximum context length",
      }).code,
    ).toBe("context_overflow");
  });

  it("400 with unrelated message → bad_request", () => {
    expect(
      translateOpenAIError({
        status: 400,
        message: "invalid_function_call schema",
      }).code,
    ).toBe("bad_request");
  });

  it("500 → vendor_5xx", () => {
    expect(translateOpenAIError({ status: 500, message: "boom" }).code).toBe(
      "vendor_5xx",
    );
  });

  it("502 → vendor_5xx", () => {
    expect(translateOpenAIError({ status: 502, message: "bad gateway" }).code).toBe(
      "vendor_5xx",
    );
  });

  it("APIConnectionTimeoutError → timeout", () => {
    const err = new Error("timeout");
    err.name = "APIConnectionTimeoutError";
    expect(translateOpenAIError(err).code).toBe("timeout");
  });

  it("APIConnectionError → network", () => {
    const err = new Error("ECONNREFUSED");
    err.name = "APIConnectionError";
    expect(translateOpenAIError(err).code).toBe("network");
  });

  it("APIUserAbortError → cancelled", () => {
    const err = new Error("aborted");
    err.name = "APIUserAbortError";
    expect(translateOpenAIError(err).code).toBe("cancelled");
  });

  it("AbortError → cancelled", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(translateOpenAIError(err).code).toBe("cancelled");
  });

  it("unknown shape → unknown", () => {
    expect(translateOpenAIError({ status: 418 }).code).toBe("unknown");
    expect(translateOpenAIError(123).code).toBe("unknown");
  });

  it("passes through CompletionError unchanged", () => {
    const original = new CompletionError("auth", "x");
    expect(translateOpenAIError(original)).toBe(original);
  });
});
