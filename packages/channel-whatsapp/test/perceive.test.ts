/**
 * perceiveTwilioWebhook — normalize Twilio webhook bodies.
 *
 * Tests cover:
 *  - basic text message → ChannelMessage
 *  - multi-media (NumMedia=2 with 2 MediaUrl)
 *  - location share (Latitude + Longitude)
 *  - missing MessageSid is rejected
 *  - missing From is rejected
 *  - malformed From (non-E.164) is rejected
 *  - NumMedia > 10 is capped
 */

import { describe, it, expect } from "vitest";
import { perceiveTwilioWebhook } from "../src/perceive.js";

describe("perceiveTwilioWebhook", () => {
  it("normalizes a basic text message", () => {
    const msg = perceiveTwilioWebhook({
      MessageSid: "SM1",
      From: "whatsapp:+14155551234",
      Body: "hello world",
      NumMedia: "0",
    });
    expect(msg.channel).toBe("whatsapp");
    expect(msg.externalId).toBe("SM1");
    expect(msg.text).toBe("hello world");
    expect(msg.customerId).toMatch(/^[0-9a-f]{12}$/);
    expect(msg.conversationId).toBe(`wa-${msg.customerId}`);
    expect(msg.attachments).toBeUndefined();
    expect(msg.raw).toBeDefined();
  });

  it("collects multi-media attachments (NumMedia=2)", () => {
    const msg = perceiveTwilioWebhook({
      MessageSid: "SM2",
      From: "whatsapp:+14155551234",
      Body: "look at these",
      NumMedia: "2",
      MediaUrl0: "https://api.twilio.com/m0.jpg",
      MediaContentType0: "image/jpeg",
      MediaUrl1: "https://api.twilio.com/m1.png",
      MediaContentType1: "image/png",
    });
    expect(msg.attachments).toBeDefined();
    expect(msg.attachments!.length).toBe(2);
    expect(msg.attachments![0]).toEqual({
      kind: "image",
      url: "https://api.twilio.com/m0.jpg",
      mimeType: "image/jpeg",
    });
    expect(msg.attachments![1].url).toBe("https://api.twilio.com/m1.png");
  });

  it("classifies media by mime-type prefix", () => {
    const msg = perceiveTwilioWebhook({
      MessageSid: "SM3",
      From: "whatsapp:+14155551234",
      NumMedia: "3",
      MediaUrl0: "u0",
      MediaContentType0: "image/jpeg",
      MediaUrl1: "u1",
      MediaContentType1: "audio/ogg",
      MediaUrl2: "u2",
      MediaContentType2: "application/pdf",
    });
    expect(msg.attachments!.map((a) => a.kind)).toEqual(["image", "audio", "document"]);
  });

  it("surfaces a location share as a geo: attachment", () => {
    const msg = perceiveTwilioWebhook({
      MessageSid: "SM4",
      From: "whatsapp:+14155551234",
      Body: "",
      NumMedia: "0",
      Latitude: "37.7749",
      Longitude: "-122.4194",
    });
    expect(msg.attachments).toBeDefined();
    expect(msg.attachments![0].url).toBe("geo:37.7749,-122.4194");
    expect(msg.attachments![0].mimeType).toBe("application/geo+json");
  });

  it("rejects missing MessageSid", () => {
    expect(() =>
      perceiveTwilioWebhook({ From: "whatsapp:+14155551234", Body: "x" } as unknown as Parameters<
        typeof perceiveTwilioWebhook
      >[0]),
    ).toThrow(/MessageSid/);
  });

  it("rejects missing From", () => {
    expect(() =>
      perceiveTwilioWebhook({ MessageSid: "SM5", Body: "x" } as unknown as Parameters<
        typeof perceiveTwilioWebhook
      >[0]),
    ).toThrow(/From/);
  });

  it("rejects non-E.164 phone numbers", () => {
    expect(() =>
      perceiveTwilioWebhook({
        MessageSid: "SM6",
        From: "whatsapp:not-a-number",
        Body: "x",
      }),
    ).toThrow(/E\.164/);
  });

  it("caps NumMedia at 10", () => {
    const body: Record<string, string> = {
      MessageSid: "SM7",
      From: "whatsapp:+14155551234",
      NumMedia: "20",
    };
    for (let i = 0; i < 20; i++) {
      body[`MediaUrl${i}`] = `https://example.com/m${i}`;
      body[`MediaContentType${i}`] = "image/jpeg";
    }
    const msg = perceiveTwilioWebhook(body);
    expect(msg.attachments!.length).toBe(10);
  });

  it("hashes phones consistently (same phone → same customerId)", () => {
    const msg1 = perceiveTwilioWebhook({
      MessageSid: "A",
      From: "whatsapp:+14155551234",
      Body: "1",
    });
    const msg2 = perceiveTwilioWebhook({
      MessageSid: "B",
      From: "whatsapp:+14155551234",
      Body: "2",
    });
    expect(msg1.customerId).toBe(msg2.customerId);
    expect(msg1.externalId).not.toBe(msg2.externalId);
  });

  it("uses injected `now` for deterministic receivedAt in tests", () => {
    const msg = perceiveTwilioWebhook(
      {
        MessageSid: "SM8",
        From: "whatsapp:+14155551234",
        Body: "x",
      },
      { now: () => "2024-06-15T00:00:00.000Z" },
    );
    expect(msg.receivedAt).toBe("2024-06-15T00:00:00.000Z");
  });
});
