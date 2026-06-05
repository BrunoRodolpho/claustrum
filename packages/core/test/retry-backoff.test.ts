/**
 * NetworkReviewer-011 — `retryWithBackoff` consumes `CompletionError.retryAfterMs`.
 *
 * The 429 `retryAfterMs` extracted by the provider adapters used to be dead.
 * These tests pin the helper that now consumes it:
 *  - respects `retryAfterMs` as a FLOOR (never retries sooner)
 *  - applies additive jitter within `[0, jitterMs)`
 *  - caps attempts (`maxAttempts`) and rethrows the real error
 *  - only retries the configured retryable codes; non-retriable rethrows fast
 *  - exponential backoff can exceed the floor; delays are clamped to maxDelayMs
 *
 * All randomness + sleeping is injected, so the suite is deterministic and
 * does not touch real timers.
 */

import { describe, it, expect } from "vitest";
import { CompletionError } from "../src/index.js";
import {
  retryWithBackoff,
  computeRetryDelayMs,
} from "../src/execution/retry.js";

/** Records the delays passed to sleep instead of actually waiting. */
function recordingSleep(): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly delays: number[];
} {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

const noJitter = { jitterMs: 0, random: () => 0 };

describe("computeRetryDelayMs (NetworkReviewer-011)", () => {
  it("uses retryAfterMs as a floor when it exceeds exponential backoff", () => {
    const d = computeRetryDelayMs({
      attempt: 0,
      retryAfterMs: 5000,
      baseDelayMs: 250, // expo at attempt 0 = 250
      maxDelayMs: 30_000,
      jitterMs: 0,
      random: () => 0,
    });
    expect(d).toBe(5000); // floor wins
  });

  it("lets exponential backoff exceed a small retryAfterMs", () => {
    const d = computeRetryDelayMs({
      attempt: 3, // expo = 250 * 2^3 = 2000
      retryAfterMs: 100,
      baseDelayMs: 250,
      maxDelayMs: 30_000,
      jitterMs: 0,
      random: () => 0,
    });
    expect(d).toBe(2000); // backoff > floor
  });

  it("clamps to maxDelayMs even with a hostile retryAfterMs", () => {
    const d = computeRetryDelayMs({
      attempt: 0,
      retryAfterMs: 9_999_999,
      baseDelayMs: 250,
      maxDelayMs: 30_000,
      jitterMs: 0,
      random: () => 0,
    });
    expect(d).toBe(30_000);
  });

  it("adds jitter within [0, jitterMs) on top of the base delay", () => {
    const d = computeRetryDelayMs({
      attempt: 0,
      retryAfterMs: 1000,
      baseDelayMs: 250,
      maxDelayMs: 30_000,
      jitterMs: 100,
      random: () => 0.5, // -> +50
    });
    expect(d).toBe(1050);
  });
});

describe("retryWithBackoff (NetworkReviewer-011)", () => {
  it("respects retryAfterMs as the sleep floor between attempts", async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new CompletionError("rate_limit", "429", {
            retryAfterMs: 4000,
          });
        }
        return "ok";
      },
      { maxAttempts: 3, baseDelayMs: 250, sleep, ...noJitter },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    // Two sleeps (before retry 2 and retry 3); both floored at 4000 (>> expo).
    expect(delays).toEqual([4000, 4000]);
  });

  it("applies jitter to the sleep delay", async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls < 2) {
          throw new CompletionError("rate_limit", "429", { retryAfterMs: 1000 });
        }
        return "ok";
      },
      {
        maxAttempts: 2,
        baseDelayMs: 250,
        jitterMs: 200,
        random: () => 0.25, // +50
        sleep,
      },
    );
    expect(delays).toEqual([1050]);
  });

  it("caps attempts and rethrows the real CompletionError after the last try", async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const err = new CompletionError("rate_limit", "still limited", {
      retryAfterMs: 500,
      vendorStatus: 429,
    });
    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw err;
        },
        { maxAttempts: 3, baseDelayMs: 250, sleep, ...noJitter },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(3); // exactly maxAttempts, no more
    expect(delays).toHaveLength(2); // sleeps only BETWEEN attempts
  });

  it("does not retry a non-retriable code — rethrows immediately", async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw new CompletionError("auth", "bad key");
        },
        { maxAttempts: 5, sleep, ...noJitter },
      ),
    ).rejects.toMatchObject({ code: "auth" });
    expect(calls).toBe(1); // no retry
    expect(delays).toHaveLength(0); // never slept
  });

  it("rethrows a non-CompletionError throw immediately (no retry)", async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw new TypeError("boom");
        },
        { maxAttempts: 5, sleep, ...noJitter },
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
    expect(delays).toHaveLength(0);
  });

  it("returns the first success without sleeping", async () => {
    const { sleep, delays } = recordingSleep();
    const result = await retryWithBackoff(async () => 42, { sleep, ...noJitter });
    expect(result).toBe(42);
    expect(delays).toHaveLength(0);
  });

  it("can opt additional transient codes into the retry set", async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls < 2) throw new CompletionError("vendor_5xx", "503");
        return "recovered";
      },
      {
        maxAttempts: 2,
        baseDelayMs: 100,
        retryableCodes: ["rate_limit", "vendor_5xx"],
        sleep,
        ...noJitter,
      },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
    // vendor_5xx carries no retryAfterMs -> pure exponential backoff (100).
    expect(delays).toEqual([100]);
  });

  it("invokes onRetry before each sleep without breaking the loop", async () => {
    const { sleep } = recordingSleep();
    const seen: number[] = [];
    let calls = 0;
    await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw new CompletionError("rate_limit", "429");
        return "ok";
      },
      {
        maxAttempts: 3,
        baseDelayMs: 100,
        sleep,
        ...noJitter,
        onRetry: ({ attempt }) => {
          seen.push(attempt);
          throw new Error("telemetry hook blew up"); // must be swallowed
        },
      },
    );
    expect(seen).toEqual([0, 1]);
    expect(calls).toBe(3);
  });
});
