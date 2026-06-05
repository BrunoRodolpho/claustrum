/**
 * Cross-implementation canonical-JSON conformance lock (RC-X1).
 *
 * `proof.ts` carries its own canonical-JSON encoder (boundary discipline keeps
 * the grounding adapter from importing kernel internals). The audit flagged
 * that the fork had NO test tying it to adjudicate's encoder, so the two could
 * drift silently and make kernel-side proof verification fail undetectably.
 *
 * This test is that lock: `canonical-golden-vectors.json` here is byte-identical
 * to `@adjudicate/canonical/golden-vectors.json` in the kernel repo. Both repos
 * assert their encoder reproduces the same (input -> sha256) pairs. If this
 * encoder drifts from the kernel's, this test fails here; if the kernel's
 * drifts, its own golden-vectors test fails there. Update a hash only by
 * regenerating from the reference implementation and editing BOTH copies.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, proofHashOf } from "../src/proof.js";

interface GoldenVector {
  readonly name: string;
  readonly input: unknown;
  readonly sha256: string;
}

const fixture = JSON.parse(
  readFileSync(new URL("./canonical-golden-vectors.json", import.meta.url), "utf-8"),
) as { readonly vectors: readonly GoldenVector[] };

function sha256OfCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

describe("canonical-JSON conformance with @adjudicate/canonical (RC-X1)", () => {
  it("ships the shared vector set", () => {
    expect(fixture.vectors.length).toBeGreaterThan(0);
  });

  for (const v of fixture.vectors) {
    it(`canonicalJson hash matches golden: ${v.name}`, () => {
      expect(sha256OfCanonical(v.input)).toBe(v.sha256);
    });
  }

  it("proofHashOf reproduces the grounding-proof five-tuple golden hash", () => {
    const vec = fixture.vectors.find((v) => v.name === "grounding-proof-five-tuple");
    expect(vec).toBeDefined();
    const input = vec!.input as {
      source: "external";
      recordId: string;
      recordVersion: string;
      chunkText: string;
      modelId: string;
    };
    // proofHashOf is the production hashing path the kernel verifies against —
    // it MUST equal the kernel's sha256Canonical over the same five-tuple.
    expect(proofHashOf(input)).toBe(vec!.sha256);
  });
});

describe("canonical encoder rules match @adjudicate/canonical (RC-X1 drift lock)", () => {
  it("NFC-normalizes strings (NFD and NFC hash identically) — DataReviewer-008", () => {
    const nfc = "caf\u00e9"; // NFC: e-acute precomposed U+00E9
    const nfd = "cafe\u0301"; // NFD: e + combining acute U+0301
    expect(nfc).not.toBe(nfd);
    expect(sha256OfCanonical({ name: nfc })).toBe(sha256OfCanonical({ name: nfd }));
  });

  it("throws on non-finite numbers — CryptoReviewer-002", () => {
    expect(() => sha256OfCanonical({ x: Number.NaN })).toThrow();
    expect(() => sha256OfCanonical({ x: Number.POSITIVE_INFINITY })).toThrow();
  });
});
