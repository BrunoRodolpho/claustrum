/**
 * `createPgVectorGroundingProvider` — factory for a pgvector-backed
 * {@link GroundingPort}.
 *
 * Boundary discipline:
 *  - Embedding logic is **injected** via `ModelProvider.embed()`, not
 *    baked in. The provider has no opinion on the vendor.
 *  - The connection pool is **injected** — adopters control pooling,
 *    SSL, connection limits, retries.
 *  - Proof signing is **injected** — production deployments will plug
 *    in KMS/HSM signers; tests can omit (unsigned proof is still hash-
 *    verifiable, just not signature-verifiable).
 *  - No coupling to ibatexas or any vertical.
 *
 * `attestGrounding()` policy: a claim of the form `"...chunkText..."` is
 * matched to a retrieved doc by **exact `chunkText` substring containment**
 * (the planner emits claims as quoted excerpts of cited chunks). If no
 * retrieved doc matches, the claim produces NO proof — the kernel will
 * REFUSE the envelope on missing-grounding, which is its responsibility,
 * not ours. We never invent a proof.
 */

import type {
  GroundingPort,
  GroundingProof,
  GroundingSource,
  GroundingSpec,
  ModelProvider,
  Perception,
  RetrievedDoc,
  RetrievedDocs,
} from "@claustrum/core";
import type { Pool } from "./pool.js";
import { buildProof, type ProofSigner } from "./proof.js";
import { rowToRetrievedDoc, runKnnQuery } from "./retrieve.js";

/**
 * Construction-time dependencies. All required except `signer` (optional)
 * and `defaultK` (defaults to 8) and `source` (defaults to `"external"`).
 */
export interface PgVectorGroundingProviderDeps {
  readonly pool: Pool;
  readonly modelProvider: ModelProvider;
  /** Stamped onto every {@link RetrievedDocs.modelId} and every proof hash. */
  readonly modelId: string;
  /** Tenant slice for the WHERE clause — multi-tenant isolation. */
  readonly tenantId: string;
  /** Optional KMS/HSM signer; if absent, proofs are hash-only. */
  readonly signer?: ProofSigner;
  /** k for retrieval when `GroundingSpec.k` is absent. Defaults to 8. */
  readonly defaultK?: number;
  /** Tags every retrieved doc + proof. Defaults to `"external"`. */
  readonly source?: GroundingSource;
}

/**
 * Factory. Returns a {@link GroundingPort} backed by pgvector + the
 * injected embedding model. The returned object captures `deps` by
 * closure — no shared mutable state, safe to share across turns.
 */
export function createPgVectorGroundingProvider(
  deps: PgVectorGroundingProviderDeps,
): GroundingPort {
  const defaultK = deps.defaultK ?? 8;
  const source: GroundingSource = deps.source ?? "external";

  async function retrieve(
    perception: Perception,
    spec?: GroundingSpec,
  ): Promise<RetrievedDocs> {
    const k = spec?.k ?? defaultK;
    const embedding = await deps.modelProvider.embed(perception.text);

    const rows = await runKnnQuery({
      pool: deps.pool,
      tenantId: deps.tenantId,
      embedding,
      k,
    });

    const docs: ReadonlyArray<RetrievedDoc> = rows.map((row) =>
      rowToRetrievedDoc(row, source),
    );

    return {
      docs,
      retrievedAt: new Date().toISOString(),
      modelId: deps.modelId,
    };
  }

  async function attestGrounding(
    docs: RetrievedDocs,
    claims: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<GroundingProof>> {
    const proofs: GroundingProof[] = [];

    for (const claim of claims) {
      const match = findMatchingDoc(docs.docs, claim);
      if (match === undefined) {
        // No retrieved chunk supports this claim — produce no proof.
        // The kernel will REFUSE the envelope on missing-grounding.
        continue;
      }

      const proof = await buildProof(
        {
          source: match.source,
          recordId: match.recordId,
          recordVersion: match.recordVersion,
          chunkText: match.chunkText,
          modelId: docs.modelId,
          retrievedAt: docs.retrievedAt,
        },
        deps.signer,
      );
      proofs.push(proof);
    }

    return proofs;
  }

  return { retrieve, attestGrounding };
}

/**
 * Claim → doc matching. Two-pass:
 *
 *  1. Exact substring containment (claim text appears inside chunkText
 *     OR vice versa). Covers the planner's quoted-excerpt case.
 *  2. Normalised whitespace + lowercase comparison as a fallback for
 *     light formatting drift.
 *
 * Deliberately NOT semantic — semantic match risks producing proofs for
 * claims the retrieval did not actually support. The kernel's REFUSE
 * path on missing-grounding is the safety net; we err toward emitting
 * fewer proofs, not inventing ones.
 *
 * Exported for testing.
 */
export function findMatchingDoc(
  docs: ReadonlyArray<RetrievedDoc>,
  claim: string,
): RetrievedDoc | undefined {
  if (claim.length === 0) return undefined;

  for (const doc of docs) {
    if (doc.chunkText.includes(claim) || claim.includes(doc.chunkText)) {
      return doc;
    }
  }

  const normClaim = normalize(claim);
  if (normClaim.length === 0) return undefined;

  for (const doc of docs) {
    const normChunk = normalize(doc.chunkText);
    if (normChunk.includes(normClaim) || normClaim.includes(normChunk)) {
      return doc;
    }
  }

  return undefined;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
