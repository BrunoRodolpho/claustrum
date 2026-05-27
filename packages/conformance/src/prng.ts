/**
 * Tiny seeded PRNG for the conformance harness.
 *
 * Verbatim from `@adjudicate/conformance` (Numerical recipes LCG, Knuth/Lewis).
 * 32-bit unsigned arithmetic so Node and browsers produce byte-identical
 * sequences.
 *
 * **Determinism contract.** Same `seed` → same sequence. No `Math.random()`
 * is reachable from anywhere in this package.
 *
 * Why duplicate rather than depend on `@adjudicate/conformance`? The runtime
 * conformance suite is a different layer (cognitive-loop invariants vs Pack
 * invariants) and should not transitively load Pack-trust / Pack-health code
 * at adopter boot time.
 */

export type Rng = () => number;

/**
 * Construct a seeded RNG. The returned function yields a uniform `[0, 1)`
 * float on each call. `seed` is coerced to a 32-bit unsigned integer;
 * negative or fractional seeds are normalized.
 */
export function lcg(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Pick one element from `xs` deterministically. */
export function pick<T>(rng: Rng, xs: ReadonlyArray<T>): T {
  if (xs.length === 0) {
    throw new Error("pick(): empty array");
  }
  const i = Math.floor(rng() * xs.length);
  return xs[i] as T;
}

/**
 * Construct a deterministic ISO-8601 timestamp from the RNG. The minute
 * field is varied across a one-day window so the harness exercises
 * non-trivial `createdAt` values without touching `Date.now()`.
 */
export function deterministicTimestamp(rng: Rng): string {
  const minuteOffset = Math.floor(rng() * 1440); // minutes in a day
  const baseMs = Date.UTC(2026, 4, 18, 0, 0, 0, 0);
  return new Date(baseMs + minuteOffset * 60_000).toISOString();
}

/**
 * Construct a deterministic-looking nonce string from the RNG. Not
 * cryptographic — the harness only needs distinct values to exercise
 * envelopes whose hashes differ. Format mirrors a UUIDv4 shape so any
 * downstream tooling that lints for a UUID pattern still accepts it.
 */
export function deterministicNonce(rng: Rng): string {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += hex[Math.floor(rng() * 16)];
    if (i === 7 || i === 11 || i === 15 || i === 19) s += "-";
  }
  return s;
}
