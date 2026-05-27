/**
 * matchToParkedByReply — load-bearing for 3+ day session resumption.
 *
 * Tests cover:
 *  - affirmative across a 24h+ time gap with fake clock
 *  - hash-prefix disambiguation across two parked envelopes
 *  - negative → deny
 *  - defer phrase ("tomorrow") → defer
 *  - empty session returns null
 *  - "yes, tomorrow" prefers defer over confirm (defer phrase wins)
 *  - no match returns null
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import type { ParkedEnvelope, Session } from "@claustrum/core";
import { matchToParkedByReply } from "../src/parked-match.js";

function makeParked(
  hashSeed: string,
  parkedAt: string,
  payload: Record<string, unknown> = {},
): ParkedEnvelope {
  const envelope: IntentEnvelope = buildEnvelope({
    kind: "test.intent",
    payload: { seed: hashSeed, ...payload },
    actor: { principal: "user", sessionId: "sess-1" },
    taint: "UNTRUSTED",
    nonce: `nonce-${hashSeed}`,
    createdAt: parkedAt,
  });
  return {
    envelope,
    confirmationToken: `tok-${hashSeed}`,
    userPrompt: `Confirm ${hashSeed}?`,
    parkedAt,
  };
}

function makeSession(parked: ParkedEnvelope[]): Session {
  return {
    id: "session-test",
    customerId: "cust-test",
    channel: "whatsapp",
    startedAt: "2024-01-01T00:00:00.000Z",
    lastActivityAt: "2024-01-01T00:00:00.000Z",
    pendingConfirmations: parked,
    deferredEnvelopes: [],
    activeGoals: [],
    workingMemory: {
      summary: "",
      facts: [],
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  };
}

describe("matchToParkedByReply", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("affirmative reply resolves most-recently-parked across 24h+ gap", () => {
    vi.setSystemTime(new Date("2024-06-01T10:00:00.000Z"));
    const parked = makeParked("seedA", "2024-06-01T10:00:00.000Z");

    // Simulate user replying 3 days later.
    vi.setSystemTime(new Date("2024-06-04T15:30:00.000Z"));
    const session = makeSession([parked]);
    const match = matchToParkedByReply("yes please", session);
    expect(match).not.toBeNull();
    expect(match?.userResolution).toBe("confirm");
    expect(match?.parked.envelope.intentHash).toBe(parked.envelope.intentHash);
  });

  it("affirmative picks the most-recently-parked when several are pending", () => {
    const older = makeParked("oldOne", "2024-06-01T10:00:00.000Z");
    const newer = makeParked("newOne", "2024-06-02T10:00:00.000Z");
    const session = makeSession([older, newer]);
    const match = matchToParkedByReply("sim", session);
    expect(match?.parked.envelope.intentHash).toBe(newer.envelope.intentHash);
    expect(match?.userResolution).toBe("confirm");
  });

  it("hash-prefix probe disambiguates across two parked envelopes", () => {
    const parkedA = makeParked("aaa", "2024-06-01T10:00:00.000Z");
    const parkedB = makeParked("bbb", "2024-06-02T10:00:00.000Z");
    // Use real prefixes from constructed hashes.
    const prefixA = parkedA.envelope.intentHash.slice(0, 8);
    const prefixB = parkedB.envelope.intentHash.slice(0, 8);
    expect(prefixA).not.toBe(prefixB);

    const session = makeSession([parkedA, parkedB]);
    const matchA = matchToParkedByReply(`#${prefixA}`, session);
    expect(matchA?.parked.envelope.intentHash).toBe(parkedA.envelope.intentHash);
    const matchB = matchToParkedByReply(`#${prefixB}`, session);
    expect(matchB?.parked.envelope.intentHash).toBe(parkedB.envelope.intentHash);
  });

  it("hash-prefix miss returns null (does not silently fall through)", () => {
    const parked = makeParked("x", "2024-06-01T10:00:00.000Z");
    const session = makeSession([parked]);
    expect(matchToParkedByReply("#deadbeef yes", session)).toBeNull();
  });

  it("negative reply produces deny resolution", () => {
    const parked = makeParked("seedN", "2024-06-01T10:00:00.000Z");
    const session = makeSession([parked]);
    const match = matchToParkedByReply("no cancel", session);
    expect(match?.userResolution).toBe("deny");
    expect(match?.parked.envelope.intentHash).toBe(parked.envelope.intentHash);
  });

  it("defer phrase produces defer resolution with captured phrase", () => {
    const parked = makeParked("seedD", "2024-06-01T10:00:00.000Z");
    const session = makeSession([parked]);
    const match = matchToParkedByReply("tomorrow please", session);
    expect(match?.userResolution).toBe("defer");
    expect(match?.deferPhrase).toMatch(/tomorrow/i);
  });

  it("defer-at expression with hours resolves to defer", () => {
    const parked = makeParked("seedH", "2024-06-01T10:00:00.000Z");
    const session = makeSession([parked]);
    const match = matchToParkedByReply("in 2 hours please", session);
    expect(match?.userResolution).toBe("defer");
  });

  it("ambiguous 'yes tomorrow' prefers defer over confirm", () => {
    const parked = makeParked("seedY", "2024-06-01T10:00:00.000Z");
    const session = makeSession([parked]);
    const match = matchToParkedByReply("yes, tomorrow morning", session);
    expect(match?.userResolution).toBe("defer");
  });

  it("empty session returns null", () => {
    const session = makeSession([]);
    expect(matchToParkedByReply("yes", session)).toBeNull();
  });

  it("non-matching utterance returns null even with parked envelopes", () => {
    const parked = makeParked("seedF", "2024-06-01T10:00:00.000Z");
    const session = makeSession([parked]);
    expect(matchToParkedByReply("the weather is fine", session)).toBeNull();
  });

  it("Portuguese affirmative ('sim') matches", () => {
    const parked = makeParked("seedPT", "2024-06-01T10:00:00.000Z");
    const session = makeSession([parked]);
    expect(matchToParkedByReply("sim", session)?.userResolution).toBe("confirm");
  });

  it("Portuguese negative ('não') matches", () => {
    const parked = makeParked("seedPT2", "2024-06-01T10:00:00.000Z");
    const session = makeSession([parked]);
    expect(matchToParkedByReply("não obrigado", session)?.userResolution).toBe("deny");
  });
});
