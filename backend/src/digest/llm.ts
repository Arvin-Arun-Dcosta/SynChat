import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";

/** The provider could not give a usable answer. Carries a message fit to show a user. */
export class LlmUnavailable extends Error {}

export interface StructuredRequest<T> {
  system: string;
  user: string;
  /** The answer must match this; it is validated on our side whatever the provider promises. */
  schema: z.ZodType<T>;
  maxTokens: number;
}

/**
 * One kind of request is all SynChat makes of a language model: a system prompt, one
 * user turn, and an answer constrained to a JSON schema. No tools, no conversation
 * state. Each provider is one small class behind this interface.
 */
export interface StructuredLlm {
  readonly provider: "anthropic" | "google" | "stub";
  /** Who the group's messages are sent to, for the notice shown to users. */
  readonly providerLabel: string;
  readonly model: string;
  generate<T>(request: StructuredRequest<T>): Promise<T>;
}

export class ClaudeLlm implements StructuredLlm {
  readonly provider = "anthropic";
  readonly providerLabel = "Anthropic";
  readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  async generate<T>(req: StructuredRequest<T>): Promise<T> {
    let response;
    try {
      // Thinking is left at the model's default (adaptive) and effort is set low:
      // these are short summarising and sorting tasks.
      response = await this.client.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: { effort: "low", format: zodOutputFormat(req.schema) },
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new LlmUnavailable("The AI provider rejected the server's API key");
      }
      if (err instanceof Anthropic.RateLimitError) throw new LlmUnavailable("The AI provider is rate-limiting requests; try again shortly");
      if (err instanceof Anthropic.APIConnectionError) throw new LlmUnavailable("Could not reach the AI provider");
      if (err instanceof Anthropic.APIError) throw new LlmUnavailable(`The AI provider returned an error (${err.status ?? "unknown"})`);
      throw err;
    }
    // A safety refusal or a cut-off response has no usable answer. Check before reading content.
    if (response.stop_reason === "refusal") throw new LlmUnavailable("The AI provider declined this request");
    if (response.stop_reason === "max_tokens" || !response.parsed_output) throw new LlmUnavailable("The AI provider returned an incomplete answer");
    return response.parsed_output as T;
  }
}

export class GeminiLlm implements StructuredLlm {
  readonly provider = "google";
  readonly providerLabel = "Google";
  readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate<T>(req: StructuredRequest<T>): Promise<T> {
    let response;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: req.user,
        config: {
          systemInstruction: req.system,
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(req.schema),
          maxOutputTokens: req.maxTokens,
          abortSignal: AbortSignal.timeout(90_000),
        },
      });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 403) throw new LlmUnavailable("The AI provider rejected the server's API key");
        if (err.status === 429) throw new LlmUnavailable("The AI provider is rate-limiting requests; try again shortly");
        throw new LlmUnavailable(`The AI provider returned an error (${err.status})`);
      }
      if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") throw new LlmUnavailable("The AI provider took too long to answer");
      if (err instanceof TypeError) throw new LlmUnavailable("Could not reach the AI provider"); // fetch failed
      throw err;
    }
    // Blocked prompts and filtered or cut-off answers have nothing usable in them.
    if (response.promptFeedback?.blockReason) throw new LlmUnavailable("The AI provider declined this request");
    const finish = response.candidates?.[0]?.finishReason;
    if (finish === "MAX_TOKENS") throw new LlmUnavailable("The AI provider returned an incomplete answer");
    if (finish && finish !== "STOP") throw new LlmUnavailable("The AI provider declined this request");
    let json: unknown;
    try {
      json = JSON.parse(response.text ?? "");
    } catch {
      throw new LlmUnavailable("The AI provider returned an unreadable answer");
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) throw new LlmUnavailable("The AI provider returned an answer in the wrong shape");
    return parsed.data;
  }
}
