/* eslint-disable no-console -- CLI command writes user-facing stdout/stderr. */
/**
 * `claustrum replay <turnId> --conductor <module> --turn <file>` — replay
 * a recorded turn against a freshly-loaded conductor and report whether
 * the observed Decision matches the recorded expectation.
 *
 * Turn file shape (JSON):
 *
 *   {
 *     "turnId": "...",
 *     "channel": "web" | "whatsapp",
 *     "customerId": "...",
 *     "conversationId": "...",
 *     "text": "...",
 *     "receivedAt": "ISO-8601",
 *     "expectedDecisionKind": "EXECUTE" | "REFUSE" | ...,
 *     "expectedEnvelopeKinds": ["..."]
 *   }
 *
 * Exit codes:
 *   0 — turn ran and matched the expectation
 *   1 — turn ran and diverged, or runtime threw, or file unreadable
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import {
  handleTurn,
  type ChannelKind,
  type Conductor,
  type OpenCapsuleInput,
} from "@claustrum/core";
import { loadConductorFactory } from "../lib/load-conductor.js";

export interface ReplayOptions {
  readonly conductor: string;
  readonly turn: string;
  readonly format?: "text" | "json";
  /** Test-injection point. */
  readonly cwd?: string;
  /** When false, return instead of calling process.exit. */
  readonly exitOnError?: boolean;
}

interface TurnFile {
  readonly turnId?: string;
  // Canonical ChannelKind — was a third parallel literal union before the
  // "system" widening; kept in lockstep with @claustrum/core now.
  readonly channel: ChannelKind;
  readonly customerId: string;
  readonly conversationId?: string;
  readonly text: string;
  readonly receivedAt?: string;
  readonly expectedDecisionKind?: string;
  readonly expectedEnvelopeKinds?: ReadonlyArray<string>;
}

export interface ReplayResult {
  readonly ok: boolean;
  readonly turnId: string;
  readonly observedDecisionKind?: string;
  readonly observedEnvelopeKinds?: ReadonlyArray<string>;
  readonly expectedDecisionKind?: string;
  readonly expectedEnvelopeKinds?: ReadonlyArray<string>;
  readonly diverged?: boolean;
  readonly error?: string;
}

async function readTurnFile(filePath: string, cwd: string): Promise<TurnFile> {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const raw = await fs.readFile(abs, "utf8");
  const parsed = JSON.parse(raw) as TurnFile;
  if (
    typeof parsed.channel !== "string" ||
    typeof parsed.customerId !== "string" ||
    typeof parsed.text !== "string"
  ) {
    throw new Error(
      `Turn file ${abs} is missing required fields (channel, customerId, text).`,
    );
  }
  return parsed;
}

export async function runReplay(
  turnId: string,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const exitOnError = options.exitOnError ?? true;
  const format = options.format ?? "text";
  const cwd = options.cwd ?? process.cwd();

  let turnFile: TurnFile;
  try {
    turnFile = await readTurnFile(options.turn, cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: ReplayResult = { ok: false, turnId, error: msg };
    if (format === "json") console.log(JSON.stringify(result, null, 2));
    else console.error(chalk.red("X"), msg);
    if (exitOnError) process.exit(1);
    return result;
  }

  let conductor: Conductor;
  try {
    const loaded = await loadConductorFactory(options.conductor, cwd);
    conductor = await loaded.factory();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: ReplayResult = { ok: false, turnId, error: msg };
    if (format === "json") console.log(JSON.stringify(result, null, 2));
    else console.error(chalk.red("X"), msg);
    if (exitOnError) process.exit(1);
    return result;
  }

  const inboundProbe: OpenCapsuleInput = {
    channel: turnFile.channel,
    customerId: turnFile.customerId,
    inbound: {
      channel: turnFile.channel,
      customerId: turnFile.customerId,
      conversationId: turnFile.conversationId ?? `conv-${turnId}`,
      text: turnFile.text,
      receivedAt: turnFile.receivedAt ?? new Date().toISOString(),
    },
  };

  let observedDecisionKind: string | undefined;
  let observedEnvelopeKinds: ReadonlyArray<string> | undefined;
  try {
    const capsule = await conductor.openCapsule(inboundProbe);
    try {
      const turn = await handleTurn(capsule, inboundProbe.inbound);
      observedDecisionKind = turn.decision.kind;
      observedEnvelopeKinds = Array.from(
        new Set(turn.plan.envelopes.map((e) => String(e.kind))),
      );
    } finally {
      await conductor.closeCapsule(capsule);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: ReplayResult = { ok: false, turnId, error: msg };
    if (format === "json") console.log(JSON.stringify(result, null, 2));
    else console.error(chalk.red("X"), msg);
    if (exitOnError) process.exit(1);
    return result;
  }

  const expectedDecisionKind = turnFile.expectedDecisionKind;
  const expectedEnvelopeKinds = turnFile.expectedEnvelopeKinds;

  let diverged = false;
  if (
    expectedDecisionKind !== undefined &&
    expectedDecisionKind !== observedDecisionKind
  ) {
    diverged = true;
  }
  if (expectedEnvelopeKinds !== undefined && observedEnvelopeKinds !== undefined) {
    const observedSorted = [...observedEnvelopeKinds].sort();
    const expectedSorted = [...expectedEnvelopeKinds].sort();
    if (
      observedSorted.length !== expectedSorted.length ||
      observedSorted.some((k, i) => k !== expectedSorted[i])
    ) {
      diverged = true;
    }
  }

  const result: ReplayResult = {
    ok: !diverged,
    turnId,
    observedDecisionKind,
    observedEnvelopeKinds,
    ...(expectedDecisionKind !== undefined ? { expectedDecisionKind } : {}),
    ...(expectedEnvelopeKinds !== undefined ? { expectedEnvelopeKinds } : {}),
    diverged,
  };

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else if (diverged) {
    console.error(
      chalk.red("X"),
      `Turn ${turnId} diverged. observed=${observedDecisionKind} expected=${expectedDecisionKind ?? "(unset)"}`,
    );
  } else {
    console.log(
      chalk.green("ok"),
      `Turn ${turnId} matched. decision=${observedDecisionKind}`,
    );
  }

  if (diverged && exitOnError) process.exit(1);
  return result;
}
