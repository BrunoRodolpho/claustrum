/**
 * @claustrum/openai — public barrel.
 *
 * Adopters import `OpenAIProvider` and construct it with a pre-built SDK
 * client. The provider implements the FROZEN `ModelProvider` contract
 * from `@claustrum/core`.
 */

export {
  OpenAIProvider,
  type OpenAIProviderOptions,
  type OpenAIClientLike,
  type OpenAIChatCompletionsBody,
  type OpenAIChatCompletionChunk,
  type OpenAIChatCompletionResponse,
  type OpenAIChatMessage,
  type OpenAIEmbeddingResponse,
  type OpenAIFinishReason,
} from "./provider.js";

export {
  translateOpenAIError,
  type OpenAIErrorShape,
} from "./errors.js";
