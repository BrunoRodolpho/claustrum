/**
 * ExplainerPort — renders Refusal -> user-facing text.
 *
 * Refusal carries:
 *  - `kind` (SECURITY | BUSINESS_RULE | AUTH | STATE)
 *  - `code` (stable identifier, e.g. "post_order.forbidden_phrase")
 *  - `userFacing` (the default text the kernel proposes)
 *  - `detail` (operator-only)
 *
 * The Explainer may localize, tonalize, or substitute `userFacing` based
 * on tenant voice; SECURITY refusals MUST NOT leak `detail`.
 *
 * Property test CC-004: REFUSE always renders to non-empty text.
 */

import type { Refusal } from "@adjudicate/core";

export interface ExplainerPort {
  render(refusal: Refusal): string;
}
