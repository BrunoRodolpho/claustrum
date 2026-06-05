/**
 * retryWithBackoff — bounded retry that CONSUMES `CompletionError.retryAfterMs`.
 *
 * Background (NetworkReviewer-011): both provider adapters extract
 * `retryAfterMs` from a 429 `Retry-After` header onto `CompletionError`, but
 * nothing ever read it — the field was dead and there was no app-level
 * backoff. This helper closes that gap: it wraps an async operation and, on a
 * retriable `CompletionError`, waits before retrying using a delay that
 * **respects `retryAfterMs` as a floor**, layers exponential backoff, adds
 * jitter, and **caps the number of attempts**.
 *
 * It is deliberately provider-agnostic (lives next to `CompletionError`) and
 * fully injectable (`sleep`, `random`) so it is unit-testable without real
 * timers or real randomness. Wiring it into the provider `complete()` paths is
 * a follow-up (see the package note) — the helper stands alone and tested.
 *
 * Design notes:
 *  - Delay for attempt `n` (0-based) = clamp(
 *        max(retryAfterMs ?? 0, baseDelayMs * 2**n) + jitter,
 *        0, maxDelayMs)
 *    where jitter ∈ [0, jitterMs). The server's `Retry-After` is a FLOOR: we
 *    never retry sooner than the server asked, but exponential growth can push
 *    us later. `maxDelayMs` caps a hostile/huge `Retry-After`.
 *  - Only `CompletionError`s whose `code` is in `retryableCodes` are retried.
 *    Default: `["rate_limit"]` — the case that carries `retryAfterMs`. Anything
 *    else (auth, bad_request, cancelled, …) is rethrown immediately.
 *  - After `maxAttempts` total attempts the last error is rethrown unchanged,
 *    so callers see the real `CompletionError`, not a wrapper.
 */

import {
  CompletionError,
  type CompletionErrorCode,
} from "../ports/model-provider.js";

export interface RetryOptions {
  /**
   * Total number of attempts (initial try + retries). Must be >= 1.
   * `1` disables retrying. Default: 3.
   */
  readonly maxAttempts?: number;
  /**
   * Base for exponential backoff in ms (attempt 0 grows from here).
   * Default: 250.
   */
  readonly baseDelayMs?: number;
  /** Upper clamp on any single delay in ms (caps a hostile Retry-After). Default: 30_000. */
  readonly maxDelayMs?: number;
  /**
   * Width of the additive jitter window in ms; the delay gets a random value
   * in `[0, jitterMs)` added. Default: 100. Set to 0 for deterministic delays.
   */
  readonly jitterMs?: number;
  /**
   * Which `CompletionErrorCode`s are retried. Default: `["rate_limit"]`.
   * (Only `rate_limit` carries `retryAfterMs` today; callers may opt other
   * transient codes in.)
   */
  readonly retryableCodes?: ReadonlyArray<CompletionErrorCode>;
  /** Injectable sleep (ms) — defaults to a real `setTimeout`. Override in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG in `[0, 1)` — defaults to `Math.random`. Override in tests. */
  readonly random?: () => number;
  /**
   * Optional hook invoked just before each sleep with the attempt index
   * (0-based, the attempt that just failed), the error, and the chosen delay.
   * Useful for telemetry; never throws into the retry loop.
   */
  readonly onRetry?: (info: {
    readonly attempt: number;
    readonly delayMs: number;
    readonly error: CompletionError;
  }) => void;
}

const DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  jitterMs: 100,
  retryableCodes: ["rate_limit"] as ReadonlyArray<CompletionErrorCode>,
} as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the delay (ms) before the retry that follows a failed attempt.
 *
 * Exported for unit-testing the policy in isolation. `attempt` is 0-based (the
 * index of the attempt that just failed). `retryAfterMs` (if present) is a
 * floor; exponential backoff may exceed it; the result is clamped to
 * `[0, maxDelayMs]` and a jitter value in `[0, jitterMs)` is added (then
 * re-clamped to `maxDelayMs`).
 */
export function computeRetryDelayMs(input: {
  readonly attempt: number;
  readonly retryAfterMs?: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterMs: number;
  readonly random: () => number;
}): number {
  const { attempt, retryAfterMs, baseDelayMs, maxDelayMs, jitterMs, random } =
    input;
  const expo = baseDelayMs * 2 ** Math.max(0, attempt);
  const floor = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : 0;
  // Respect the server floor; exponential growth can push later.
  const base = Math.min(Math.max(floor, expo), maxDelayMs);
  const jitter = jitterMs > 0 ? random() * jitterMs : 0;
  return Math.min(base + jitter, maxDelayMs);
}

function isRetryable(
  err: unknown,
  codes: ReadonlyArray<CompletionErrorCode>,
): err is CompletionError {
  return err instanceof CompletionError && codes.includes(err.code);
}

/**
 * Run `fn`, retrying on a retriable `CompletionError` with a delay that
 * respects `retryAfterMs`, applies exponential backoff + jitter, and caps the
 * attempt count. Non-retriable errors (and non-`CompletionError` throws) are
 * rethrown immediately. After the final attempt the last error is rethrown
 * unchanged.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULTS.maxAttempts);
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const jitterMs = options.jitterMs ?? DEFAULTS.jitterMs;
  const retryableCodes = options.retryableCodes ?? DEFAULTS.retryableCodes;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !isRetryable(err, retryableCodes)) {
        throw err;
      }
      const delayMs = computeRetryDelayMs({
        attempt,
        ...(err.retryAfterMs !== undefined
          ? { retryAfterMs: err.retryAfterMs }
          : {}),
        baseDelayMs,
        maxDelayMs,
        jitterMs,
        random,
      });
      if (options.onRetry !== undefined) {
        try {
          options.onRetry({ attempt, delayMs, error: err });
        } catch {
          // Telemetry hooks must never break the retry loop.
        }
      }
      await sleep(delayMs);
    }
  }
  // Unreachable in practice (the loop either returns or throws), but satisfies
  // the type checker and guards an off-by-one.
  throw lastError;
}
