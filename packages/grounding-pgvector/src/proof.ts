/**
 * Grounding proof generation.
 *
 * `proofHash` is a sha256 hex digest over the **canonical-JSON** of:
 *
 *   { chunkText, modelId, recordId, recordVersion, source }
 *
 * The canonical-JSON rule mirrors `@adjudicate/core`'s `sha256Canonical`
 * (RFC 8785 / JCS): recursively sort object keys lexicographically, drop
 * undefined fields, no whitespace. Replay-determinism guarantee: the
 * same five-tuple yields the same hash byte-for-byte across processes
 * and language re-implementations.
 *
 * `retrievedAt` is **excluded** from the hash by construction — it is a
 * wall-clock witness, not a content-identifier. Including it would
 * break the kernel's ability to verify a stored proof on replay.
 *
 * The canonical source of truth is the standalone `@adjudicate/canonical`
 * package (RFC 8785 / JCS). This encoder is kept inline here for now (the
 * grounding adapter is not yet workspace-linked to the kernel repo), but it
 * is LOCKED against drift by `tests/canonical-golden-vectors.json`, which is
 * byte-identical to `@adjudicate/canonical/golden-vectors.json`. If this
 * encoder ever diverges from the kernel's, `canonical-conformance.test.ts`
 * fails here. Once the runtime is workspace-linked to the live kernel, import
 * `sha256Canonical` from `@adjudicate/canonical` and delete this inline copy.
 */

import { createHash } from "node:crypto";
import type { GroundingProof, GroundingSource } from "@claustrum/core";

/**
 * Input five-tuple for {@link proofHashOf}. `retrievedAt` is deliberately
 * absent — it is part of {@link GroundingProof} but NOT part of the hash.
 */
export interface ProofHashInput {
  readonly source: GroundingSource;
  readonly recordId: string;
  readonly recordVersion: string;
  readonly chunkText: string;
  readonly modelId: string;
}

/**
 * Optional signing capability. Kept loose so adopters can plug in
 * KMS, HSM, or in-process keys without leaking vendor types upward.
 * The returned string is stored verbatim in `GroundingProof.signature`.
 */
export interface ProofSigner {
  /** Returns a signature string (e.g. `keyId:alg:base64-value`). */
  sign(proofHashHex: string): Promise<string> | string;
}

export interface BuildProofInput extends ProofHashInput {
  /** ISO-8601 timestamp at which the chunk was retrieved. NOT hashed. */
  readonly retrievedAt: string;
}

// ── Canonical-JSON (inline, no external dep) ────────────────────────────────

/**
 * Recursively canonicalize a value: object keys sorted lexicographically,
 * arrays preserve order, `undefined` fields elided, `null` passes through.
 *
 * Mirrors `@adjudicate/canonical` `canonicalize()` exactly (locked by
 * tests/canonical-golden-vectors.json).
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = canonicalize(v);
  return out;
}

/** Serialise to canonical-JSON. No whitespace, deterministic key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * sha256 hex over the canonical-JSON of the five-tuple. Pure function:
 * same input → same output, byte-for-byte.
 */
export function proofHashOf(input: ProofHashInput): string {
  const body = {
    chunkText: input.chunkText,
    modelId: input.modelId,
    recordId: input.recordId,
    recordVersion: input.recordVersion,
    source: input.source,
  };
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

/**
 * Assemble a {@link GroundingProof}. Computes `proofHash` deterministically;
 * if a {@link ProofSigner} is supplied, attaches an opaque signature.
 *
 * The kernel's grounding-verification path recomputes the same hash from
 * the stored five-tuple and compares — if `proofHashOf` here drifts from
 * `sha256Canonical` in adjudicate, kernel verification breaks silently.
 * The cross-package conformance test exists to catch that drift.
 */
export async function buildProof(
  input: BuildProofInput,
  signer?: ProofSigner,
): Promise<GroundingProof> {
  const proofHash = proofHashOf(input);

  if (signer === undefined) {
    return {
      source: input.source,
      recordId: input.recordId,
      recordVersion: input.recordVersion,
      retrievedAt: input.retrievedAt,
      proofHash,
      chunkText: input.chunkText,
      modelId: input.modelId,
    };
  }

  const signature = await signer.sign(proofHash);
  return {
    source: input.source,
    recordId: input.recordId,
    recordVersion: input.recordVersion,
    retrievedAt: input.retrievedAt,
    proofHash,
    chunkText: input.chunkText,
    modelId: input.modelId,
    signature,
  };
}
