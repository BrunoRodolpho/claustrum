/**
 * @claustrum/channel-web — public barrel.
 */

export { WebChannel } from "./web-channel.js";
export { perceiveWebPayload } from "./perceive.js";
export { attestWebEnvelope, type WebAttestContext } from "./attest.js";
export type { WebChannelConfig, WebInboundPayload, WebSink } from "./types.js";
