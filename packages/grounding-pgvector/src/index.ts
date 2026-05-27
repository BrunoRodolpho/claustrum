/**
 * @claustrum/grounding-pgvector — pgvector-backed `GroundingProvider`.
 *
 * Public barrel. Adopter apps import:
 *
 *   import { createPgVectorGroundingProvider } from "@claustrum/grounding-pgvector";
 *
 * Lower-level helpers (`buildProof`, `proofHashOf`) are exported for
 * adopters who need to assemble proofs outside the standard retrieve →
 * attest path (e.g. when caching pre-computed proofs).
 */

export {
  createPgVectorGroundingProvider,
  findMatchingDoc,
  type PgVectorGroundingProviderDeps,
} from "./pgvector-grounding-provider.js";

export {
  buildProof,
  canonicalJson,
  proofHashOf,
  type BuildProofInput,
  type ProofHashInput,
  type ProofSigner,
} from "./proof.js";

export {
  formatVectorLiteral,
  rowToRetrievedDoc,
  runKnnQuery,
  type KnnQueryInput,
  type KnnRow,
} from "./retrieve.js";

export type { Pool, QueryResult } from "./pool.js";
