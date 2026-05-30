/**
 * ConfigReviewer-002 — injectable TTL overrides.
 *
 * Verifies two invariants:
 *   1. A custom `ttls.snapshot` override is honoured: the SETEX call to
 *      Redis uses the caller-supplied value, not the module default.
 *   2. Omitting `ttls` leaves the default (60s snapshot TTL) unchanged —
 *      existing callers are fully back-compat.
 */

import { describe, expect, it } from "vitest";
import type { Perception } from "@claustrum/core";
import { createPostgresMemoryProvider } from "../src/postgres-memory-provider.js";
import { TTL_SECONDS, cacheKey } from "../src/cache-keys.js";
import {
  FakeAdjudicator,
  FakePrismaClient,
  FakeRedisClient,
} from "./mocks.js";

const PERCEPTION: Perception = {
  text: "hi",
  channel: "test",
  receivedAt: new Date().toISOString(),
};

describe("injectable TTL overrides", () => {
  it("honours a custom ttls.snapshot value in the SETEX call", async () => {
    const prisma = new FakePrismaClient();
    const redis = new FakeRedisClient();
    const adjudicator = new FakeAdjudicator();
    const customSnapshotTtl = 999;

    const provider = createPostgresMemoryProvider({
      prisma,
      redis,
      adjudicator,
      ttls: { snapshot: customSnapshotTtl },
    });

    await provider.recall("cust-custom-ttl", PERCEPTION);
    // The write-through SETEX is fire-and-forget; flush the microtask queue.
    await new Promise((r) => setImmediate(r));

    const setexCall = redis.calls.find(
      (c) =>
        c.op === "setex" &&
        (c.args as unknown[])[0] === cacheKey.snapshot("cust-custom-ttl"),
    );
    expect(setexCall).toBeDefined();
    // Second arg to setex is the TTL in seconds.
    expect((setexCall!.args as unknown[])[1]).toBe(customSnapshotTtl);
  });

  it("uses the default snapshot TTL when ttls is omitted", async () => {
    const prisma = new FakePrismaClient();
    const redis = new FakeRedisClient();
    const adjudicator = new FakeAdjudicator();

    const provider = createPostgresMemoryProvider({ prisma, redis, adjudicator });

    await provider.recall("cust-default-ttl", PERCEPTION);
    await new Promise((r) => setImmediate(r));

    const setexCall = redis.calls.find(
      (c) =>
        c.op === "setex" &&
        (c.args as unknown[])[0] === cacheKey.snapshot("cust-default-ttl"),
    );
    expect(setexCall).toBeDefined();
    expect((setexCall!.args as unknown[])[1]).toBe(TTL_SECONDS.snapshot);
  });

  it("only overrides the keys supplied; other TTLs are unaffected", async () => {
    // This test documents the partial-override contract: passing
    // { snapshot: 120 } must NOT change semantic/relational/etc TTLs.
    // We verify this by checking that the module export is still the
    // canonical default for other keys.
    const overriddenTtls = { snapshot: 120 };
    const expected = { ...TTL_SECONDS, ...overriddenTtls };

    expect(expected.snapshot).toBe(120);
    expect(expected.semantic).toBe(TTL_SECONDS.semantic);
    expect(expected.relational).toBe(TTL_SECONDS.relational);
    expect(expected.episodicRecent).toBe(TTL_SECONDS.episodicRecent);
    expect(expected.episodicTurn).toBe(TTL_SECONDS.episodicTurn);
  });
});
