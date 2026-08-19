import { env } from "../../../config/env.js";
import { callExternalApi, ExternalApiError } from "../../httpClient.js";
import { AI_REPLY_INTENTS, type AiReplyIntent, type ReplyClassificationAiClient, type ReplyClassificationResult } from "./types.js";

const API_URL = "https://api.openai.com/v1/chat/completions";

const SYSTEM_PROMPT = `You classify a single email reply to a cold outreach message.

Deterministic rules have already ruled out unsubscribe requests, legal/compliance threats, hostile messages, and out-of-office auto-replies -- you will never see those. Classify the reply text you are given into exactly one of: "interested" (wants to learn more / book a call / positive), "not_interested" (a polite no / not right now), "question" (asking for more information before deciding), or "other" (anything else, including empty or unclear replies).

Base your classification ONLY on the literal text given. Do not infer anything about the business itself beyond what the reply says.`;

const RESPONSE_JSON_SCHEMA = {
  name: "reply_classification_result",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["intent", "confidence"],
    properties: {
      intent: { type: "string", enum: [...AI_REPLY_INTENTS] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
} as const;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

function validateResult(parsed: unknown): ReplyClassificationResult {
  if (typeof parsed !== "object" || parsed === null) throw new Error("AI response was not a JSON object");
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.intent !== "string" || !(AI_REPLY_INTENTS as readonly string[]).includes(obj.intent)) {
    throw new Error("AI response has an invalid 'intent'");
  }
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
    throw new Error("AI response has an invalid 'confidence'");
  }
  return { intent: obj.intent as AiReplyIntent, confidence: obj.confidence };
}

export class RealOpenAiReplyClassificationClient implements ReplyClassificationAiClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async classify(replyBody: string): Promise<ReplyClassificationResult> {
    const data = await callExternalApi<ChatCompletionResponse>("openai", "chat.completions:classify_reply", async () => {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: replyBody },
          ],
          response_format: { type: "json_schema", json_schema: RESPONSE_JSON_SCHEMA },
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ExternalApiError(`OpenAI chat completion failed: ${res.status} ${text}`, res.status);
      }
      return (await res.json()) as ChatCompletionResponse;
    });

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI response contained no message content");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("OpenAI response content was not valid JSON despite structured output mode");
    }
    return validateResult(parsed);
  }
}

export function createRealOpenAiReplyClassificationClient(): ReplyClassificationAiClient {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when MOCK_EXTERNAL_APIS=false");
  }
  return new RealOpenAiReplyClassificationClient(env.OPENAI_API_KEY, env.OPENAI_MODEL);
}
