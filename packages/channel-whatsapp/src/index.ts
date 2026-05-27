/**
 * @claustrum/channel-whatsapp — public barrel.
 *
 * The driver class lives at the top; everything else is exported so
 * adopters can compose lower-level helpers (e.g. signature verification
 * in a webhook route handler before the body even reaches the driver).
 */

export { WhatsAppChannel } from "./whatsapp-channel.js";
export {
  verifyTwilioSignature,
  type VerifyTwilioSignatureInput,
} from "./twilio-signature.js";
export { perceiveTwilioWebhook, type PerceiveOptions } from "./perceive.js";
export {
  splitForWhatsApp,
  sendTwilioMessage,
  type SendTwilioMessageInput,
  type SplitOptions,
} from "./render.js";
export { attestWithGatewayKey, type AttestContext } from "./attest.js";
export { matchToParkedByReply } from "./parked-match.js";
export { normalizePhone, hashPhone } from "./phone.js";
export type {
  WhatsAppChannelConfig,
  TwilioWebhookBody,
  ParkedMatch,
  UserResolution,
} from "./types.js";
