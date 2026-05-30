/**
 * instrumented-port — safe spy installation helper for conformance checks.
 *
 * Every conformance check that needs to intercept a port method follows the
 * same pattern:
 *  1. Capture the original method.
 *  2. Install a spy (cast away readonly via `as unknown as`).
 *  3. Run a body of work that may throw or hang.
 *  4. Restore the original in a `finally` block.
 *
 * Without this helper, if step 3 throws BEFORE the `finally` the spy
 * persists on the shared conductor object and corrupts later checks.
 * `withInstrumentedPort` centralises the install / restore cycle so:
 *  - The unsafe `as unknown as` cast lives in exactly one place.
 *  - Restoration is guaranteed regardless of whether `body` throws.
 *  - Each check's `.run()` only reads the call-count / recording from the
 *    captured spy closure; it never touches the raw cast.
 *
 * @param target   The port object whose method is being replaced.
 * @param key      The name of the method to replace.
 * @param makeSpy  Factory that receives the original bound method and returns
 *                 the spy to install.  Called once, before `body`.
 * @param body     Async body to run with the spy installed.  Receives the spy
 *                 itself so callers can inspect call counts etc.
 * @returns        Whatever `body` returns.
 */
export async function withInstrumentedPort<
  TTarget extends object,
  TKey extends keyof TTarget,
  TSpy extends TTarget[TKey],
  TResult,
>(
  target: TTarget,
  key: TKey,
  makeSpy: (original: TTarget[TKey]) => TSpy,
  body: (spy: TSpy) => Promise<TResult>,
): Promise<TResult> {
  // Bind the original so it retains its `this` context even after we
  // replace the slot.  TTarget[TKey] may not be a function at the type
  // level, but all call sites pass method keys, so the cast is safe.
  const original: TTarget[TKey] = target[key];

  // The single location in the whole codebase where we cast away readonly.
  const mutable = target as unknown as Record<string, unknown>;
  const spy = makeSpy(original);
  mutable[key as string] = spy;

  try {
    return await body(spy);
  } finally {
    mutable[key as string] = original;
  }
}
