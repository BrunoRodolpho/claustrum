/**
 * Streaming cancellation — the load-bearing capability for the runtime.
 *
 * The cognitive loop may call `cancel()` when:
 *  - `adjudicateOutput()` returns REFUSE mid-stream
 *  - a fresh user reply arrives before the current turn finishes
 *  - a session deadline elapses
 *
 * Contract:
 *  1. `cancel()` severs the underlying SDK stream (abort spy called once).
 *  2. The generator yields a terminal `{ type: "cancelled" }` chunk.
 *  3. `cancel()` is idempotent — N invocations still produce 1 abort call.
 *  4. `aborted` observable flag flips to true synchronously on first cancel.
 */

import { describe, expect, it } from "vitest";
import type { AnthropicStreamEvent } from "../src/provider.js";
import { AnthropicProvider } from "../src/provider.js";
import { FakeAnthropicClient } from "./fake-sdk.js";

const REQ = {
  model: "fake-model",
  messages: [{ role: "user" as const, content: "ping" }],
};

describe("AnthropicProvider streaming cancellation", () => {
  it("severs the SDK stream when cancel() is called", async () => {
    // Long script — many text deltas. We cancel after consuming one.
    const events: AnthropicStreamEvent[] = Array.from({ length: 20 }, (_, i) => ({
      type: "content_block_delta" as const,
      index: 0,
      delta: { type: "text_delta" as const, text: `t${i}` },
    }));
    const client = new FakeAnthropicClient({
      streamScript: {
        events,
        finalMessage: {
          model: "fake-model",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "joined" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    });
    const provider = new AnthropicProvider({ client });
    const stream = provider.stream(REQ);

    const seen: string[] = [];
    let consumed = 0;
    for await (const chunk of stream) {
      seen.push(chunk.type);
      consumed += 1;
      if (consumed === 2) {
        stream.cancel();
      }
      if (chunk.type === "cancelled" || chunk.type === "done") {
        break;
      }
    }

    expect(client.abortSpyCallCount).toBe(1);
    expect(seen[seen.length - 1]).toBe("cancelled");
    expect(stream.aborted).toBe(true);
  });

  it("cancel() is idempotent — multiple calls only abort once", async () => {
    const client = new FakeAnthropicClient();
    const provider = new AnthropicProvider({ client });
    const stream = provider.stream(REQ);

    stream.cancel();
    stream.cancel();
    stream.cancel();

    // Drain.
    for await (const _ of stream) {
      void _;
    }

    expect(client.abortSpyCallCount).toBe(1);
    expect(stream.aborted).toBe(true);
  });

  it("aborted flag flips synchronously on first cancel", () => {
    const client = new FakeAnthropicClient();
    const provider = new AnthropicProvider({ client });
    const stream = provider.stream(REQ);

    expect(stream.aborted).toBe(false);
    stream.cancel();
    expect(stream.aborted).toBe(true);
  });

  it("emits text_delta + tool_use_start + tool_input_delta + done in order", async () => {
    const script: AnthropicStreamEvent[] = [
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello " },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_a", name: "lookup" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"q":' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"x"}' },
      },
    ];
    const client = new FakeAnthropicClient({
      streamScript: {
        events: script,
        finalMessage: {
          model: "fake-model",
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "hello " },
            { type: "tool_use", id: "toolu_a", name: "lookup", input: { q: "x" } },
          ],
          usage: { input_tokens: 4, output_tokens: 7 },
        },
      },
    });
    const provider = new AnthropicProvider({ client });
    const stream = provider.stream(REQ);

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const types = chunks.map((c) => c.type);
    expect(types).toEqual([
      "text_delta",
      "tool_use_start",
      "tool_input_delta",
      "tool_input_delta",
      "done",
    ]);
    const done = chunks[4];
    expect(done.type).toBe("done");
    if (done.type === "done") {
      expect(done.stopReason).toBe("tool_use");
      expect(done.inputTokens).toBe(4);
      expect(done.outputTokens).toBe(7);
    }
  });

  it("cancelled chunk carries token count fields (NetworkReviewer-006)", async () => {
    // Cancel mid-stream: finalMessage() throws on genuine mid-stream abort
    // (message_stop not yet arrived), so token counts are 0. The key
    // invariant is that the `cancelled` chunk ALWAYS includes inputTokens
    // and outputTokens fields so callers never receive undefined for spend.
    const events: AnthropicStreamEvent[] = Array.from({ length: 10 }, (_, i) => ({
      type: "content_block_delta" as const,
      index: 0,
      delta: { type: "text_delta" as const, text: `word${i} ` },
    }));
    const client = new FakeAnthropicClient({
      streamScript: {
        events,
        finalMessage: {
          model: "fake-model",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "joined" }],
          usage: { input_tokens: 12, output_tokens: 8 },
        },
      },
    });
    const provider = new AnthropicProvider({ client });
    const stream = provider.stream(REQ);

    const collected = [];
    let consumed = 0;
    for await (const chunk of stream) {
      collected.push(chunk);
      consumed += 1;
      if (consumed === 3) {
        stream.cancel();
      }
      if (chunk.type === "cancelled" || chunk.type === "done") break;
    }

    const last = collected[collected.length - 1];
    expect(last.type).toBe("cancelled");
    if (last.type === "cancelled") {
      // The cancelled chunk must carry numeric token fields (not undefined).
      // On mid-stream abort where message_stop has not arrived, counts are 0
      // because Anthropic delivers usage only in finalMessage().
      expect(typeof last.inputTokens).toBe("number");
      expect(typeof last.outputTokens).toBe("number");
    }
  });
});
