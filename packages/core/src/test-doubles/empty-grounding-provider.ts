/**
 * EmptyGroundingProvider — GroundingPort test-double.
 *
 * Returns an empty doc list. Sufficient for property tests where
 * grounding is not under test.
 */

import type {
  GroundingPort,
  GroundingProof,
  RetrievedDocs,
} from "../ports/grounding.js";

export class EmptyGroundingProvider implements GroundingPort {
  async retrieve(): Promise<RetrievedDocs> {
    return {
      docs: [],
      retrievedAt: new Date().toISOString(),
      modelId: "empty",
    };
  }

  async attestGrounding(): Promise<ReadonlyArray<GroundingProof>> {
    return [];
  }
}
