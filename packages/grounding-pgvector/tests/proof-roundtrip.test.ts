/**
 * Proof-roundtrip: `proofHash` is deterministic across re-retrievals and
 * a kernel-side recompute reproduces it byte-for-byte. Also: changing
 * `recordVersion` (or any other hashed field) flips the hash.
 *
 * This is the load-bearing test for kernel-verifiable grounding. If this
 * passes against `@adjudicate/core`'s `sha256Canonical` (locked by the
 * conformance cross-package test elsewhere), the kernel will accept our
 * proofs on replay.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildProof, canonicalJson, proofHashOf } from "../src/proof.js";

const baseInput = {
  source: "external" as const,
  recordId: "rec-42",
  recordVersion: "v1",
  chunkText: "The brain is the conductor of the cortical orchestra.",
  modelId: "text-embedding-3-small",
};

describe("proofHashOf — determinism", () => {
  it("yields the same hash for identical inputs across calls", () => {
    const h1 = proofHashOf(baseInput);
    const h2 = proofHashOf({ ...baseInput });
    const h3 = proofHashOf({
      // intentionally constructed in a different key order
      modelId: baseInput.modelId,
      chunkText: baseInput.chunkText,
      recordVersion: baseInput.recordVersion,
      recordId: baseInput.recordId,
      source: baseInput.source,
    });
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);
  });

  it("hash is a 64-char lowercase hex string", () => {
    const h = proofHashOf(baseInput);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when recordVersion changes", () => {
    const h1 = proofHashOf(baseInput);
    const h2 = proofHashOf({ ...baseInput, recordVersion: "v2" });
    expect(h1).not.toBe(h2);
  });

  it("changes when recordId changes", () => {
    const h1 = proofHashOf(baseInput);
    const h2 = proofHashOf({ ...baseInput, recordId: "rec-43" });
    expect(h1).not.toBe(h2);
  });

  it("changes when chunkText changes (single character)", () => {
    const h1 = proofHashOf(baseInput);
    const h2 = proofHashOf({
      ...baseInput,
      chunkText: baseInput.chunkText + ".",
    });
    expect(h1).not.toBe(h2);
  });

  it("changes when modelId changes", () => {
    const h1 = proofHashOf(baseInput);
    const h2 = proofHashOf({ ...baseInput, modelId: "voyage-3" });
    expect(h1).not.toBe(h2);
  });

  it("changes when source changes", () => {
    const h1 = proofHashOf(baseInput);
    const h2 = proofHashOf({ ...baseInput, source: "policy" });
    expect(h1).not.toBe(h2);
  });
});

describe("buildProof — kernel-style rederive verification", () => {
  it("emits a proof whose proofHash recomputes via the canonical-JSON rule", async () => {
    const proof = await buildProof({
      ...baseInput,
      retrievedAt: "2025-01-01T00:00:00.000Z",
    });

    // Kernel-side rederive: take the five hashed fields off the proof,
    // canonicalize, sha256. Must equal `proof.proofHash`.
    const expected = createHash("sha256")
      .update(
        canonicalJson({
          chunkText: proof.chunkText,
          modelId: proof.modelId,
          recordId: proof.recordId,
          recordVersion: proof.recordVersion,
          source: proof.source,
        }),
      )
      .digest("hex");

    expect(proof.proofHash).toBe(expected);
  });

  it("two re-retrievals with different retrievedAt timestamps share a proofHash", async () => {
    const p1 = await buildProof({
      ...baseInput,
      retrievedAt: "2025-01-01T00:00:00.000Z",
    });
    const p2 = await buildProof({
      ...baseInput,
      retrievedAt: "2025-06-15T12:34:56.789Z",
    });
    expect(p1.proofHash).toBe(p2.proofHash);
    expect(p1.retrievedAt).not.toBe(p2.retrievedAt);
  });

  it("invokes the signer with the proofHash and stores its return value verbatim", async () => {
    const calls: string[] = [];
    const signer = {
      sign: (h: string) => {
        calls.push(h);
        return `kms-test:Ed25519:${h.slice(0, 16)}`;
      },
    };

    const proof = await buildProof(
      { ...baseInput, retrievedAt: "2025-01-01T00:00:00.000Z" },
      signer,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(proof.proofHash);
    expect(proof.signature).toBe(`kms-test:Ed25519:${proof.proofHash.slice(0, 16)}`);
  });
});
