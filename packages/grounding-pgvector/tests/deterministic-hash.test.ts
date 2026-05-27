/**
 * Canonical-JSON behaviour + `retrievedAt`-exclusion guarantees.
 *
 * Two narrow contracts under test:
 *  1. `retrievedAt` MUST NOT influence `proofHash`. If a future refactor
 *     leaks the timestamp into the hash, replay-determinism dies silently
 *     and the kernel starts rejecting valid replays.
 *  2. The canonical-JSON layer sorts keys lexicographically and elides
 *     `undefined` fields — this MUST match `@adjudicate/core`'s rule
 *     byte-for-byte.
 */

import { describe, expect, it } from "vitest";
import { buildProof, canonicalJson, proofHashOf } from "../src/proof.js";

describe("retrievedAt — excluded from hash", () => {
  const fixed = {
    source: "external" as const,
    recordId: "r1",
    recordVersion: "v1",
    chunkText: "alpha",
    modelId: "m1",
  };

  it("100 retrievedAt permutations all yield the same proofHash", async () => {
    const target = proofHashOf(fixed);
    for (let i = 0; i < 100; i++) {
      const proof = await buildProof({
        ...fixed,
        retrievedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
      });
      expect(proof.proofHash).toBe(target);
    }
  });
});

describe("canonicalJson — key-order normalisation", () => {
  it("sorts object keys lexicographically", () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it("recursively sorts nested object keys", () => {
    expect(canonicalJson({ b: { y: 1, x: 2 }, a: 0 })).toBe(
      '{"a":0,"b":{"x":2,"y":1}}',
    );
  });

  it("preserves array order (arrays are NOT sorted, only object keys)", () => {
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it("elides undefined fields (so {a: undefined} hashes like {})", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson({})).toBe("{}");
  });

  it("normalises null to null", () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it("emits zero whitespace", () => {
    const out = canonicalJson({ a: 1, b: { c: 2 } });
    expect(out).not.toMatch(/\s/);
  });
});

describe("proofHashOf — key-order invariance", () => {
  it("same input in three different construction orders → same hash", () => {
    const a = proofHashOf({
      source: "external",
      recordId: "r",
      recordVersion: "v",
      chunkText: "t",
      modelId: "m",
    });
    const b = proofHashOf({
      modelId: "m",
      chunkText: "t",
      recordVersion: "v",
      recordId: "r",
      source: "external",
    });
    const c = proofHashOf({
      recordVersion: "v",
      source: "external",
      modelId: "m",
      recordId: "r",
      chunkText: "t",
    });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
