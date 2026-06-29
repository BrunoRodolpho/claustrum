---
"@claustrum/channel-whatsapp": minor
---

Egress brand (Plan 1 / Theorem E-1): the WhatsApp Twilio egress now accepts the
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
later waves (W5/W6). Requires `@adjudicate/core` ≥ 1.7.0 (the minter set).
