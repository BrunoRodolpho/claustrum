# @example/minimal-chat

End-to-end claustrum reference application. Single-file demo that proves
the cognitive loop runs without ibatexas, without Postgres, without any
production adapter beyond the optional Anthropic provider.

## 30-second quickstart

```sh
pnpm install
pnpm --filter @example/minimal-chat dev     # runs main()
```

With no `ANTHROPIC_API_KEY` set, the example wires `InMemoryModelProvider`
so the build/test path stays hermetic. Setting the key flips to a real
`AnthropicProvider` against the Messages API.

## What it shows

- Construct a `Conductor` with `@claustrum/core`'s in-memory test doubles
  for memory, session, grounding, telemetry, channel.
- Register two capabilities: `weather.lookup` (low risk) and
  `calendar.book` (medium risk). The LLM only ever sees these as
  `express_intent(capability, payload)` — the registry resolves the
  capability to a concrete `ToolDefinition.id` after the kernel
  authorizes the envelope.
- Open a `Capsule` for one customer turn; run `handleTurn`.
- Print the resulting `Decision.kind`, the envelope's `intentHash`, and
  the rendered response text.

## What it isn't

- Not a production wiring. The `StubAdjudicator` always EXECUTEs except
  on `kind="danger"` (which it REFUSEs). Real adopters wire an
  `Adjudicator` backed by their `@adjudicate/core` Pack.
- Not LLM-driven. The planner branches on substrings of inbound text;
  real adopters drive the planner from an LLM via `ModelProvider`.

## Next steps from here

1. Swap `InMemoryMemoryProvider` for `@claustrum/memory-postgres` (gives
   you persistence + the Adjudicator-backed `recentActions` path).
2. Swap `WebChannelStub` for `@claustrum/channel-whatsapp` (gives you
   Twilio inbound + parked-confirmation matching).
3. Swap `StubAdjudicator` for a real Adjudicator backed by your
   `@adjudicate/core` Pack.
