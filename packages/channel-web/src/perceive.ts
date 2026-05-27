/**
 * Web inbound → normalized ChannelMessage.
 *
 * Web inbound is HTTP/JSON. Versus Twilio there's no shared canonical
 * form, so the adapter accepts the loosest reasonable shape and rejects
 * only when essentials are missing.
 *
 * `customerId` is a host-managed identifier (web sessions usually have a
 * cookie/JWT-derived id). Unlike the WhatsApp channel, the host is
 * trusted to supply a stable customer id — the adapter does not derive
 * one from request headers.
 */

import type { ChannelMessage } from "@claustrum/core";
import type { WebInboundPayload } from "./types.js";

let monotonicCounter = 0;

export function perceiveWebPayload(payload: WebInboundPayload): ChannelMessage {
  if (!payload || typeof payload !== "object") {
    throw new Error("perceiveWebPayload: payload must be an object");
  }
  const text = typeof payload.text === "string" ? payload.text : "";
  const customerId =
    typeof payload.customerId === "string" && payload.customerId.length > 0
      ? payload.customerId
      : "anonymous";
  const conversationId =
    typeof payload.conversationId === "string" && payload.conversationId.length > 0
      ? payload.conversationId
      : `web-${customerId}`;
  const receivedAt =
    typeof payload.receivedAt === "string" && payload.receivedAt.length > 0
      ? payload.receivedAt
      : new Date().toISOString();

  // Request id: prefer the caller's supplied value; fall back to a
  // per-process monotonic counter so each ChannelMessage still has a
  // stable externalId for telemetry correlation.
  monotonicCounter++;
  const externalId =
    typeof payload.requestId === "string" && payload.requestId.length > 0
      ? payload.requestId
      : `web-${Date.now()}-${monotonicCounter}`;

  return {
    channel: "web",
    customerId,
    conversationId,
    externalId,
    text,
    receivedAt,
    ...(typeof payload.locale === "string" ? { locale: payload.locale } : {}),
    ...(payload.attachments !== undefined && payload.attachments.length > 0
      ? { attachments: payload.attachments }
      : {}),
    raw: payload,
  };
}
