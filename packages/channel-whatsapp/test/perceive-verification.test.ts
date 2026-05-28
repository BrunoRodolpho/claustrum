/**
 * RC-R2: WhatsAppChannel.perceive must verify the inbound Twilio signature
 * before normalizing — fail-closed. Previously verifyTwilioSignature existed
 * but was never invoked, so any party that could POST the webhook got their
 * message normalized and adjudicated with zero identity check.
 */

import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  WhatsAppChannel,
  TwilioVerificationError,
} from "../src/whatsapp-channel.js";
import type { WhatsAppChannelConfig } from "../src/types.js";

const AUTH_TOKEN = "test-auth-token-123";
const url = "https://example.com/webhooks/whatsapp";
const body = {
  MessageSid: "SM123",
  From: "whatsapp:+5511999998888",
  To: "whatsapp:+14155238886",
  Body: "oi",
};

/** Mirror Twilio's canonical-string HMAC-SHA1 construction (see twilio-signature.ts). */
function twilioSign(
  u: string,
  params: Record<string, string>,
  token: string,
): string {
  const keys = Object.keys(params).sort();
  let canonical = u;
  for (const k of keys) canonical += k + params[k];
  return createHmac("sha1", token).update(canonical, "utf8").digest("base64");
}

function makeChannel(): WhatsAppChannel {
  const config: WhatsAppChannelConfig = {
    accountSid: "ACxxxx",
    authToken: AUTH_TOKEN,
    twilioFrom: "whatsapp:+14155238886",
    gatewaySigningKey: "gw-key",
  };
  return new WhatsAppChannel(config);
}

describe("WhatsAppChannel.perceive — mandatory Twilio verification (RC-R2)", () => {
  it("accepts a correctly-signed inbound and returns a ChannelMessage", async () => {
    const signature = twilioSign(url, body, AUTH_TOKEN);
    const msg = await makeChannel().perceive({ url, signature, body });
    expect(msg.channel).toBe("whatsapp");
    expect(msg.text).toBe("oi");
    expect(msg.externalId).toBe("SM123");
  });

  it("rejects a forged signature (fail-closed)", async () => {
    await expect(
      makeChannel().perceive({ url, signature: "forged-sig", body }),
    ).rejects.toBeInstanceOf(TwilioVerificationError);
  });

  it("rejects a tampered body even with a signature for the original", async () => {
    const signature = twilioSign(url, body, AUTH_TOKEN);
    const tampered = { ...body, Body: "transfer all funds" };
    await expect(
      makeChannel().perceive({ url, signature, body: tampered }),
    ).rejects.toBeInstanceOf(TwilioVerificationError);
  });

  it("rejects when verification context is missing (bare body)", async () => {
    await expect(makeChannel().perceive(body)).rejects.toBeInstanceOf(
      TwilioVerificationError,
    );
  });

  it("rejects a signature computed with the wrong auth token", async () => {
    const signature = twilioSign(url, body, "WRONG-token");
    await expect(
      makeChannel().perceive({ url, signature, body }),
    ).rejects.toBeInstanceOf(TwilioVerificationError);
  });
});
