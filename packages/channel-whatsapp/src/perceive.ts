/**
 * Twilio webhook → normalized ChannelMessage.
 *
 * The legacy ibatexas adapter folded perception into a fat singleton with
 * XState. Here perceive is a pure function over the parsed POST body, with
 * a small set of explicit rejection rules (missing MessageSid, malformed
 * From). Anything else is best-effort.
 *
 * Media handling: Twilio sends `NumMedia` plus `MediaUrl0..N` (and matching
 * `MediaContentType0..N`). We honor up to 10 attachments; beyond that the
 * webhook is most likely abusive and the tail is silently dropped.
 *
 * Location handling: `Latitude`/`Longitude` arrive as decimal strings on
 * location-share messages; we surface them as a single attachment with a
 * synthetic `geo:` URL so downstream tools have a uniform shape.
 */

import type { ChannelMessage } from "@claustrum/core";
import { hashPhone, normalizePhone } from "./phone.js";
import type { TwilioWebhookBody } from "./types.js";

const MAX_MEDIA = 10;

export interface PerceiveOptions {
  /**
   * Override `receivedAt` (tests). Production callers omit; perceive() uses
   * `new Date().toISOString()`.
   */
  readonly now?: () => string;
}

export function perceiveTwilioWebhook(
  body: TwilioWebhookBody,
  options: PerceiveOptions = {},
): ChannelMessage {
  if (!body || typeof body !== "object") {
    throw new Error("perceiveTwilioWebhook: body must be an object");
  }

  const messageSid = body.MessageSid;
  if (typeof messageSid !== "string" || messageSid.length === 0) {
    throw new Error("perceiveTwilioWebhook: missing MessageSid");
  }

  const from = body.From;
  if (typeof from !== "string" || from.length === 0) {
    throw new Error("perceiveTwilioWebhook: missing From");
  }
  const phone = normalizePhone(from);
  const customerId = hashPhone(phone);

  // conversationId: stable per-phone — long-lived sessions span days. The
  // legacy adapter used Twilio's `MessagingServiceSid + From`; we use the
  // hashed phone alone so out-of-band messages (templated re-engagement)
  // land on the same conversation.
  const conversationId = `wa-${customerId}`;

  const text = typeof body.Body === "string" ? body.Body : "";

  const attachments: Array<{
    readonly kind: "image" | "audio" | "document";
    readonly url: string;
    readonly mimeType?: string;
  }> = [];

  const numMedia = parseInt(body.NumMedia ?? "0", 10);
  if (Number.isFinite(numMedia) && numMedia > 0) {
    const limit = Math.min(numMedia, MAX_MEDIA);
    for (let i = 0; i < limit; i++) {
      const url = body[`MediaUrl${i}`];
      const mimeType = body[`MediaContentType${i}`];
      if (typeof url !== "string" || url.length === 0) continue;
      attachments.push({
        kind: classifyMedia(mimeType),
        url,
        ...(mimeType !== undefined ? { mimeType } : {}),
      });
    }
  }

  // Location share → synthetic geo: attachment.
  const lat = body.Latitude;
  const lng = body.Longitude;
  if (typeof lat === "string" && typeof lng === "string") {
    attachments.push({
      kind: "document",
      url: `geo:${lat},${lng}`,
      mimeType: "application/geo+json",
    });
  }

  const receivedAt = options.now ? options.now() : new Date().toISOString();

  // ProfileName is best-effort metadata. We expose it via the raw payload
  // for downstream consumers that want it — it's not part of ChannelMessage
  // proper because it's untrusted user-controlled text.
  return {
    channel: "whatsapp",
    customerId,
    conversationId,
    externalId: messageSid,
    text,
    receivedAt,
    ...(attachments.length > 0 ? { attachments } : {}),
    raw: body,
  };
}

function classifyMedia(mimeType: string | undefined): "image" | "audio" | "document" {
  if (!mimeType) return "document";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}
