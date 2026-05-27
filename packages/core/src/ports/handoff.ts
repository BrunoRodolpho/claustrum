/**
 * HandoffPort — human-escalation queue.
 *
 * Called when a Decision returns ESCALATE. Adapters (PagerDuty, Slack,
 * proprietary CRM) queue the envelope + reason for human review.
 *
 * Idempotent: re-queuing the same envelope (matched by intentHash) MUST
 * NOT double-page.
 */

import type { IntentEnvelope } from "@adjudicate/core";

export interface HandoffPort {
  queue(envelope: IntentEnvelope, reason: string): Promise<void>;
}
