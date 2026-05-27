/**
 * `buildSnapshot` — pure reducer over the 4 memory kinds.
 *
 * Inputs are raw rows from Postgres (one query per kind, run in parallel).
 * Output is the `MemorySnapshot` shape defined by `@claustrum/core`. No I/O,
 * no logging — testable without a database.
 *
 * Episodic content is rendered as "USER: ... | ASSISTANT: ..." so the
 * downstream prompt composer can include them as conversation fragments
 * without re-parsing JSON.
 */

import type { MemoryItem, MemorySnapshot } from "@claustrum/core";

export interface EpisodicRow {
  readonly id: string | number | bigint;
  readonly turn_id: string;
  readonly user_text: string | null;
  readonly response_text: string | null;
  readonly intent_hash: string | null;
  readonly recorded_at: Date | string;
}

export interface SemanticRow {
  readonly key: string;
  readonly value: string;
  readonly confidence: number | string;
  readonly tags: ReadonlyArray<string> | null;
  readonly recorded_at: Date | string;
}

export interface ProceduralRow {
  readonly id: string | number | bigint;
  readonly workflow_kind: string;
  readonly description: string;
  readonly last_used_at: Date | string | null;
}

export interface RelationalRow {
  readonly id: string | number | bigint;
  readonly signal_kind: string;
  readonly content: string;
  readonly observed_at: Date | string;
}

export interface BuildSnapshotInput {
  readonly customerId: string;
  readonly episodic: ReadonlyArray<EpisodicRow>;
  readonly semantic: ReadonlyArray<SemanticRow>;
  readonly procedural: ReadonlyArray<ProceduralRow>;
  readonly relational: ReadonlyArray<RelationalRow>;
  readonly assembledAt?: string;
}

function toIso(d: Date | string): string {
  return typeof d === "string" ? d : d.toISOString();
}

function toNumber(n: number | string): number {
  return typeof n === "number" ? n : Number(n);
}

function idString(id: string | number | bigint): string {
  return typeof id === "string" ? id : String(id);
}

export function buildSnapshot(input: BuildSnapshotInput): MemorySnapshot {
  const episodic: MemoryItem[] = input.episodic.map((row) => {
    const userPart = row.user_text ? `USER: ${row.user_text}` : "";
    const respPart = row.response_text ? `ASSISTANT: ${row.response_text}` : "";
    const content = [userPart, respPart].filter(Boolean).join(" | ");
    return {
      id: `epi-${idString(row.id)}`,
      kind: "episodic" as const,
      content,
      createdAt: toIso(row.recorded_at),
      ...(row.intent_hash ? { tags: [`intent:${row.intent_hash}`] } : {}),
    };
  });

  const semantic: MemoryItem[] = input.semantic.map((row) => ({
    id: `sem-${row.key}`,
    kind: "semantic" as const,
    content: `${row.key}: ${row.value}`,
    confidence: toNumber(row.confidence),
    createdAt: toIso(row.recorded_at),
    ...(row.tags && row.tags.length > 0 ? { tags: row.tags } : {}),
  }));

  const procedural: MemoryItem[] = input.procedural.map((row) => ({
    id: `pro-${idString(row.id)}`,
    kind: "procedural" as const,
    content: `[${row.workflow_kind}] ${row.description}`,
    createdAt: row.last_used_at
      ? toIso(row.last_used_at)
      : new Date(0).toISOString(),
    tags: [row.workflow_kind],
  }));

  const relational: MemoryItem[] = input.relational.map((row) => ({
    id: `rel-${idString(row.id)}`,
    kind: "relational" as const,
    content: row.content,
    createdAt: toIso(row.observed_at),
    tags: [row.signal_kind],
  }));

  return {
    customerId: input.customerId,
    episodic,
    semantic,
    procedural,
    relational,
    assembledAt: input.assembledAt ?? new Date().toISOString(),
  };
}
