/**
 * APIReviewer-018 — render resolves the recipient via a TYPED artifact.
 *
 * `extractRecipient` used to duck-type artifacts with an unchecked
 * `(artifact as { to: string }).to` cast. It now narrows with the typed
 * `isRecipientArtifact` guard exported from `@claustrum/core`. Behavior for
 * valid artifacts is unchanged; a malformed artifact is a guarded skip that
 * surfaces the documented "no `to` recipient" error rather than crashing on a
 * bad cast.
 *
 * These tests pin the render path:
 *  - a `{ to }` recipient artifact -> Twilio POST carries that `To`
 *  - no artifacts / no recipient artifact -> the documented throw
 *  - an artifact missing `to` (and a non-string `to`) -> guarded, same throw
 *  - a recipient artifact among other (card-like) artifacts is still found
 */

import { describe, it, expect } from "vitest";
import type { RenderedResponse } from "@claustrum/core";
import { WhatsAppChannel } from "../src/whatsapp-channel.js";
import type { WhatsAppChannelConfig } from "../src/types.js";

interface CapturedRequest {
  readonly url: string;
  readonly body: URLSearchParams;
}

function makeChannel(captured: CapturedRequest[]): WhatsAppChannel {
  const fetchStub: typeof globalThis.fetch = async (input, init) => {
    captured.push({
      url: String(input),
      body: new URLSearchParams(String(init?.body ?? "")),
    });
    return new Response("", { status: 200 });
  };
  const config: WhatsAppChannelConfig = {
    accountSid: "ACxxxx",
    authToken: "tok",
    twilioFrom: "whatsapp:+14155238886",
    gatewaySigningKey: "gw-key",
    fetch: fetchStub,
    interChunkDelayMs: 0,
  };
  return new WhatsAppChannel(config);
}

function baseResponse(
  artifacts?: RenderedResponse["artifacts"],
): RenderedResponse {
  return {
    channel: "whatsapp",
    customerId: "hashed-phone",
    conversationId: "conv-1",
    text: "Your refund is processed.",
    ...(artifacts !== undefined ? { artifacts } : {}),
  };
}

describe("WhatsAppChannel.render recipient resolution (APIReviewer-018)", () => {
  it("sends to the recipient from a typed { to } artifact", async () => {
    const captured: CapturedRequest[] = [];
    const ch = makeChannel(captured);
    await ch.render(baseResponse([{ to: "whatsapp:+5511999998888" }]));
    expect(captured).toHaveLength(1);
    expect(captured[0].body.get("To")).toBe("whatsapp:+5511999998888");
    expect(captured[0].body.get("From")).toBe("whatsapp:+14155238886");
    expect(captured[0].body.get("Body")).toBe("Your refund is processed.");
  });

  it("finds the recipient artifact among other (card-like) artifacts", async () => {
    const captured: CapturedRequest[] = [];
    const ch = makeChannel(captured);
    await ch.render(
      baseResponse([
        { kind: "card", title: "Receipt" },
        { to: "whatsapp:+5511111112222" },
      ]),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].body.get("To")).toBe("whatsapp:+5511111112222");
  });

  it("throws the documented error when there are no artifacts", async () => {
    const captured: CapturedRequest[] = [];
    const ch = makeChannel(captured);
    await expect(ch.render(baseResponse())).rejects.toThrow(/no `to` recipient/);
    expect(captured).toHaveLength(0);
  });

  it("guards (no throw on cast) an artifact missing `to` -> documented error", async () => {
    const captured: CapturedRequest[] = [];
    const ch = makeChannel(captured);
    await expect(
      ch.render(baseResponse([{ kind: "card", title: "no recipient here" }])),
    ).rejects.toThrow(/no `to` recipient/);
    expect(captured).toHaveLength(0);
  });

  it("guards an artifact whose `to` is not a string -> documented error", async () => {
    const captured: CapturedRequest[] = [];
    const ch = makeChannel(captured);
    await expect(
      ch.render(baseResponse([{ to: 12345 } as unknown as { to: string }])),
    ).rejects.toThrow(/no `to` recipient/);
    expect(captured).toHaveLength(0);
  });
});
