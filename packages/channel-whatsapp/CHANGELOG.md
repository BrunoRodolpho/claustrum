# @claustrum/channel-whatsapp

## 0.3.0

### Minor Changes

- d451419: Egress brand (Plan 1 / Theorem E-1): the WhatsApp Twilio egress now accepts the
  runtime-non-forgeable `RenderedReply` brand from `@adjudicate/core` instead of a
  raw `string`.
  - `SendTwilioMessageInput.body` is now `RenderedReply`; `sendTwilioMessage`
    unwraps it via `unwrapRendered(body)` at the raw `fetch` form build — the sole
    egress chokepoint where the string crosses the wire to Twilio.
  - `splitForWhatsApp(reply: RenderedReply): RenderedReply[]` re-mints each chunk
    via `mintRenderedReply` so the brand survives the split.
  - `WhatsAppChannel.render` bridges the still-`string` `RenderedResponse.text`
    through the deprecated `wrapLegacyResponderText` transitional minter (the W5
    deletion seam) so the egress type-checks during the W4→W5 wiring gap.

  This is E-1 (brand carrier + retyped signatures) only. Call-site value-binding
  (E-2) and the upstream `RenderedResponse.text` string→`RenderedReply` flip are
  later waves (W5/W6).

  Requires `@adjudicate/core` >= 1.8.0 — the version that actually exports the
  minter set (`mintRenderedReply` / `unwrapRendered` / `wrapLegacyResponderText`
  et al.). The `@adjudicate/core` dependency AND peerDependency ranges are pinned
  to `^1.8.0` accordingly. This minor changeset bumps `@claustrum/channel-whatsapp`
  0.2.0 -> 0.3.0 (the real publish target).

### Patch Changes

- Updated dependencies [a005e6f]
- Updated dependencies [49f9530]
  - @claustrum/core@0.4.0

## 0.2.0

### Minor Changes

- Widen `ChannelKind` with `"system"` (non-conversational trigger ingress for
  server-resident managed agents) and add the DR-4 per-session lock-key
  strategy.
  - `ChannelKind = "whatsapp" | "web" | "system"` — the canonical union in
    `@claustrum/core` ports/channel. The two parallel literal unions
    (`channel-whatsapp` `AttestContext.channel`, `cli` replay `TurnFile.channel`)
    now reference the canonical type instead of duplicating it. No exhaustive
    switches on `ChannelKind` exist (verified), so the widening is additive.
  - `ConductorOptions.lockKeyStrategy?: LockKeyStrategy` — optional derivation
    of the per-session lock KEY from the `openCapsule` input. Default
    (`defaultLockKey`) is byte-identical to previous behavior
    (`` `${channel}:${customerId}` ``; `input.sessionKey` ignored for locking).
    New exported `sessionKeyAwareLockKey` honors an explicit `sessionKey` as
    the lock key, so a trigger turn (channel `"system"`) can name the
    entity-scoped serialization domain (e.g. `web:<customerId>`) and strictly
    serialize against that customer's chat turns across processes under a
    distributed `SessionLock` (e.g. `PostgresAdvisorySessionLock`).

### Patch Changes

- Updated dependencies
  - @claustrum/core@0.3.0
