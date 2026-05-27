/**
 * Streaming cancellation + tool-call stitching tests for OpenAIProvider.
 *
 * The OpenAI SDK is `AbortSignal`-driven: we own a controller, pass its
 * signal to the SDK, and abort it on cancel(). The fake records each
 * abort-signal-fired event to verify exactly-once semantics.
 *
 * Tool-call stitching: OpenAI tool args arrive fragmented across multiple
 * chunks, addressed by `index`. The adapter MUST emit exactly one
 * `tool_use_start` per index and stitch subsequent argument fragments into
 * `tool_input_delta` events.
 */

import { describe, expect, it } from "vitest";
import type { OpenAIChatCompletionChunk } from "../src/provider.js";
import { OpenAIProvider } from "../src/provider.js";
import { FakeOpenAIClient } from "./fake-sdk.js";

const REQ = {
  model: "gpt-4o",
  messages: [{ role: "user" as const, content: "ping" }],
};

describe("OpenAIProvider streaming cancellation", () => {
  it("severs the SDK stream via AbortController.abort() when cancel() is called", async () => {
    const chunks: OpenAIChatCompletionChunk[] = Array.from({ length: 20 }, (_, i) => ({
      choices: [
        {
          index: 0,
          delta: { content: `t${i}` },
          finish_reason: null,
        },
      ],
    }));
    const client = new FakeOpenAIClient({
      streamScript: { chunks },
      streamDelayMs: 1,
    });
    const provider = new OpenAIProvider({ client });
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

  it("cancel() is idempotent", async () => {
    const client = new FakeOpenAIClient();
    const provider = new OpenAIProvider({ client });
    const stream = provider.stream(REQ);

    stream.cancel();
    stream.cancel();
    stream.cancel();

    for await (const _ of stream) {
      void _;
    }

    expect(client.abortSpyCallCount).toBe(1);
    expect(stream.aborted).toBe(true);
  });

  it("aborted flag flips synchronously", () => {
    const client = new FakeOpenAIClient();
    const provider = new OpenAIProvider({ client });
    const stream = provider.stream(REQ);

    expect(stream.aborted).toBe(false);
    stream.cancel();
    expect(stream.aborted).toBe(true);
  });

  it("caller-supplied AbortSignal also cancels the stream", async () => {
    const client = new FakeOpenAIClient({ streamDelayMs: 1 });
    const provider = new OpenAIProvider({ client });
    const controller = new AbortController();
    const stream = provider.stream({ ...REQ, signal: controller.signal });

    const reader = (async () => {
      const out: string[] = [];
      for await (const chunk of stream) {
        out.push(chunk.type);
        if (chunk.type === "cancelled" || chunk.type === "done") break;
      }
      return out;
    })();

    // Abort externally — should also cancel the adapter stream.
    controller.abort();
    const out = await reader;
    expect(out[out.length - 1]).toBe("cancelled");
  });
});

describe("OpenAIProvider tool-call stitching", () => {
  it("emits exactly one tool_use_start + N tool_input_delta per index", async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      // First fragment: id + function.name + first argument piece.
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_a",
                  function: { name: "lookup", arguments: '{"q":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      // Continuation: just the next argument fragment, no id/name.
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '"x"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      // Final: finish_reason + usage.
      {
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 8 },
      },
    ];
    const client = new FakeOpenAIClient({ streamScript: { chunks } });
    const provider = new OpenAIProvider({ client });
    const stream = provider.stream(REQ);

    const collected = [];
    for await (const chunk of stream) {
      collected.push(chunk);
    }

    const types = collected.map((c) => c.type);
    expect(types).toEqual([
      "tool_use_start",
      "tool_input_delta",
      "tool_input_delta",
      "done",
    ]);

    const start = collected[0];
    expect(start.type).toBe("tool_use_start");
    if (start.type === "tool_use_start") {
      expect(start.id).toBe("call_a");
      expect(start.name).toBe("lookup");
    }
    const done = collected[3];
    expect(done.type).toBe("done");
    if (done.type === "done") {
      expect(done.stopReason).toBe("tool_use");
      expect(done.inputTokens).toBe(5);
      expect(done.outputTokens).toBe(8);
    }
  });

  it("buffers across multiple parallel tool calls by index", async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_x",
                  function: { name: "alpha", arguments: '{"a":1}' },
                },
                {
                  index: 1,
                  id: "call_y",
                  function: { name: "beta", arguments: '{"b":2}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ];
    const client = new FakeOpenAIClient({ streamScript: { chunks } });
    const provider = new OpenAIProvider({ client });
    const stream = provider.stream(REQ);

    const collected = [];
    for await (const chunk of stream) {
      collected.push(chunk);
    }

    // 2x (tool_use_start + tool_input_delta) + 1x done = 5.
    expect(collected).toHaveLength(5);
    const starts = collected.filter((c) => c.type === "tool_use_start");
    expect(starts).toHaveLength(2);
    const ids = starts.map((s) => (s.type === "tool_use_start" ? s.id : "?"));
    expect(ids).toEqual(["call_x", "call_y"]);
  });

  it("emits text_delta + tool_use sequence with usage from include_usage chunk", async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      {
        choices: [
          {
            index: 0,
            delta: { content: "hi " },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_z",
                  function: { name: "tool", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
      // Final usage chunk (include_usage: true) arrives as a separate chunk
      // with empty choices and usage populated.
      {
        choices: [],
        usage: { prompt_tokens: 11, completion_tokens: 22 },
      },
    ];
    const client = new FakeOpenAIClient({ streamScript: { chunks } });
    const provider = new OpenAIProvider({ client });
    const stream = provider.stream(REQ);

    const collected = [];
    for await (const chunk of stream) {
      collected.push(chunk);
    }
    const types = collected.map((c) => c.type);
    expect(types).toEqual([
      "text_delta",
      "tool_use_start",
      "tool_input_delta",
      "done",
    ]);
    const done = collected[3];
    if (done.type === "done") {
      expect(done.stopReason).toBe("tool_use");
      expect(done.inputTokens).toBe(11);
      expect(done.outputTokens).toBe(22);
    }
  });
});

describe("OpenAIProvider embeddings", () => {
  it("calls embeddings.create with default model", async () => {
    const client = new FakeOpenAIClient({
      embeddingResponse: { data: [{ embedding: [0.5, 0.5] }] },
    });
    const provider = new OpenAIProvider({ client });
    const vec = await provider.embed("test");

    expect(vec).toEqual([0.5, 0.5]);
    expect(client.createEmbeddingCalls).toHaveLength(1);
    expect(client.createEmbeddingCalls[0]).toEqual({
      model: "text-embedding-3-small",
      input: "test",
    });
  });

  it("honours defaultEmbeddingModel override", async () => {
    const client = new FakeOpenAIClient();
    const provider = new OpenAIProvider({
      client,
      defaultEmbeddingModel: "text-embedding-3-large",
    });
    await provider.embed("test");
    expect(client.createEmbeddingCalls[0]?.model).toBe("text-embedding-3-large");
  });
});
