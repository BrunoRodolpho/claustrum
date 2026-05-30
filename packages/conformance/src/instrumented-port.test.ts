/**
 * Unit tests for the `withInstrumentedPort` helper.
 *
 * Key property to verify: restoration always happens in `finally`, even
 * when `body` throws.
 */

import { describe, expect, it } from "vitest";
import { withInstrumentedPort } from "./instrumented-port.js";

describe("withInstrumentedPort", () => {
  it("installs the spy for the duration of body and restores original afterward", async () => {
    const target = {
      greet: (name: string): string => `hello, ${name}`,
    };
    const original = target.greet;
    const spyCalls: string[] = [];

    await withInstrumentedPort(
      target,
      "greet",
      (orig) => (name: string): string => {
        spyCalls.push(name);
        return orig(name);
      },
      async (spy) => {
        // Inside the body the spy is installed.
        expect(target.greet).toBe(spy);
        expect(target.greet("world")).toBe("hello, world");
      },
    );

    // After body completes, the original must be restored.
    expect(target.greet).toBe(original);
    expect(spyCalls).toEqual(["world"]);
  });

  it("restores the original even when body throws", async () => {
    const target = {
      getValue: (): number => 42,
    };
    const original = target.getValue;

    await expect(
      withInstrumentedPort(
        target,
        "getValue",
        (_orig) => (): number => 99,
        async (_spy) => {
          throw new Error("body exploded");
        },
      ),
    ).rejects.toThrow("body exploded");

    // Critical: original must be restored despite the throw.
    expect(target.getValue).toBe(original);
    expect(target.getValue()).toBe(42);
  });

  it("passes the spy to body so callers can inspect call counts", async () => {
    let callCount = 0;
    const target = {
      ping: (): string => "pong",
    };

    await withInstrumentedPort(
      target,
      "ping",
      (orig) => (): string => {
        callCount++;
        return orig();
      },
      async (spy) => {
        spy();
        spy();
        expect(callCount).toBe(2);
      },
    );

    expect(callCount).toBe(2);
  });

  it("returns the value produced by body", async () => {
    const target = { x: 0 };

    const result = await withInstrumentedPort(
      target,
      "x",
      (_orig) => 999,
      async (_spy) => "body-result",
    );

    expect(result).toBe("body-result");
  });
});
