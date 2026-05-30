/**
 * GroundingPort — retrieval + grounding-proof generation.
 *
 * Grounding has two faces:
 *  - retrieve(): RAG. The planner reads from this to ground its plan.
 *  - attestGrounding(): proof generation. After the LLM cites a fact,
 *    the runtime calls this to bind the citation to a content-addressed
 *    `GroundingProof` that flows into the envelope payload.
 *
 * `GroundingProof.proofHash` excludes `retrievedAt` so re-retrieval
 * produces a byte-identical hash — replay determinism.
 */

export interface Perception {
  readonly text: string;
  readonly channel: string;
  readonly externalId?: string;
  readonly receivedAt: string;
  readonly attachments?: ReadonlyArray<{
    readonly kind: "image" | "audio" | "document";
    readonly url: string;
    readonly mimeType?: string;
  }>;
  /**
   * Channel-driver-supplied locale hint. Adapters may infer from
   * phone number prefix, header, or webhook field.
   */
  readonly locale?: string;
}

export type GroundingSource = "catalog" | "policy" | "history" | "external";

export interface GroundingSpec {
  /** Tool-side declaration of what grounding is required to call this tool. */
  readonly sources: ReadonlyArray<GroundingSource>;
  readonly minScore?: number;
  readonly k?: number;
}

export interface RetrievedDoc {
  readonly id: string;
  readonly source: GroundingSource;
  readonly recordId: string;
  readonly recordVersion: string;
  readonly chunkText: string;
  readonly score: number;
  readonly metadata?: Record<string, unknown>;
}

export interface RetrievedDocs {
  readonly docs: ReadonlyArray<RetrievedDoc>;
  readonly retrievedAt: string;
  readonly modelId: string;
}

export interface GroundingProof {
  readonly source: GroundingSource;
  readonly recordId: string;
  readonly recordVersion: string;
  readonly retrievedAt: string;
  /** sha256Canonical({source, recordId, recordVersion, chunkText, modelId}). */
  readonly proofHash: string;
  readonly chunkText: string;
  readonly modelId: string;
  readonly signature?: string;
}

export interface GroundingPort {
  retrieve(perception: Perception, spec?: GroundingSpec): Promise<RetrievedDocs>;

  /**
   * Attest grounding: map a claim (string) onto retrieved docs and emit
   * a `GroundingProof`. Implementations match claims by exact substring /
   * normalized-whitespace containment against `chunkText`, or by
   * record-id reference embedded in the claim. Matching is NOT semantic —
   * there is no vector similarity or embedding comparison in this
   * operation. Adopters writing custom adapters must honour this
   * contract: byte-level / substring matching only.
   */
  attestGrounding(
    docs: RetrievedDocs,
    claims: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<GroundingProof>>;
}
