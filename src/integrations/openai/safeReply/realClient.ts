import { env } from "../../../config/env.js";
import { callExternalApi, ExternalApiError } from "../../httpClient.js";
import type { SafeReplyAiClient, SafeReplyFacts, SafeReplyResult } from "./types.js";

const API_URL = "https://api.openai.com/v1/chat/completions";

const SYSTEM_PROMPT = `You draft a short reply to a prospect who responded positively (or with a question) to a cold outreach email from a web design / SEO / conversion agency.

You are only ever invoked for replies already deemed safe for automation -- never for legal, compliance, hostile, or unsubscribe messages. Even so, follow these rules strictly:
- Base your reply ONLY on the given fields: the original email we sent, the prospect's reply text, and the given qualification reasoning. Never invent facts about their business, their industry, their team, or anything not given.
- Never quote a specific price, discount, contract term, or guaranteed outcome/timeline.
- Never make a commitment you cannot know is true (e.g. "we've already looked at your site in detail" beyond what was given).
- If the reply is a question you cannot answer from the given facts, acknowledge it honestly and offer a call to discuss specifics, rather than guessing.
- Keep it under 100 words, plain text, professional and warm, no markdown, no emoji.
- Always end by proposing a concrete next step (e.g. a short call), signed with the given sender name and company.

Respond with structured JSON only, matching the given schema.`;

const RESPONSE_JSON_SCHEMA = {
  name: "safe_reply_result",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["body"],
    properties: {
      body: { type: "string" },
    },
  },
} as const;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

function validateResult(parsed: unknown): SafeReplyResult {
  if (typeof parsed !== "object" || parsed === null) throw new Error("AI response was not a JSON object");
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.body !== "string" || obj.body.trim().length === 0) {
    throw new Error("AI response missing 'body'");
  }
  return { body: obj.body };
}

export class RealOpenAiSafeReplyClient implements SafeReplyAiClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async generate(facts: SafeReplyFacts): Promise<SafeReplyResult> {
    const data = await callExternalApi<ChatCompletionResponse>("openai", "chat.completions:safe_reply", async () => {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.3,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(facts) },
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

export function createRealOpenAiSafeReplyClient(): SafeReplyAiClient {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when MOCK_EXTERNAL_APIS=false");
  }
  return new RealOpenAiSafeReplyClient(env.OPENAI_API_KEY, env.OPENAI_MODEL);
}
