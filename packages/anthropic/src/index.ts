/**
 * @claustrum/anthropic — public barrel.
 *
 * Adopters import `AnthropicProvider` and construct it with a pre-built SDK
 * client (or a structurally-compatible fake for tests).
 */

export {
  AnthropicProvider,
  wrapAnthropicSdk,
  type AnthropicProviderOptions,
  type AnthropicClientLike,
  type AnthropicMessagesCreateBody,
  type AnthropicMessageResponse,
  type AnthropicMessageStream,
  type AnthropicStreamEvent,
  type AnthropicContentBlock,
} from "./provider.js";

export {
  translateAnthropicError,
  type AnthropicErrorShape,
} from "./errors.js";
