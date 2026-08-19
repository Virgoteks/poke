import { env } from "../../../config/env.js";
import { callExternalApi, ExternalApiError } from "../../httpClient.js";
import type { PersonalizationAiClient, PersonalizationFacts, PersonalizationResult } from "./types.js";

const API_URL = "https://api.openai.com/v1/chat/completions";

const SYSTEM_PROMPT = `You write short, personalized first-touch cold outreach emails for a web design / SEO / conversion agency.

You will be given a fixed set of factual fields about one prospect and their website. Base the email ONLY on those fields. Never invent or assume any fact not given to you -- no revenue, no team size, no history, no compliments about things you weren't told. If a field is null, simply don't mention it.

Rules:
- Address the contact by first name if given, otherwise use a generic greeting.
- Reference at most 1-2 concrete facts from the input (e.g. a specific PageSpeed score, a missing contact form, or "no website found").
- Keep the body under 120 words, plain text, no markdown, no bullet points, no emoji, no exaggerated claims, no fabricated urgency.
- End with a low-pressure call to action (e.g. offering a quick call), signed with the given sender name and company.
- Never mention pricing, guarantees, or specific revenue/results numbers.

Respond with structured JSON only, matching the given schema.`;

const RESPONSE_JSON_SCHEMA = {
  name: "personalization_result",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["subject", "body"],
    properties: {
      subject: { type: "string" },
      body: { type: "string" },
    },
  },
} as const;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

function validateResult(parsed: unknown): PersonalizationResult {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("AI personalization response was not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.subject !== "string" || obj.subject.trim().length === 0) {
    throw new Error("AI response missing 'subject'");
  }
  if (typeof obj.body !== "string" || obj.body.trim().length === 0) {
    throw new Error("AI response missing 'body'");
  }
  return { subject: obj.subject, body: obj.body };
}

export class RealOpenAiPersonalizationClient implements PersonalizationAiClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async generate(facts: PersonalizationFacts): Promise<PersonalizationResult> {
    const data = await callExternalApi<ChatCompletionResponse>("openai", "chat.completions:personalize", async () => {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.4,
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

export function createRealOpenAiPersonalizationClient(): PersonalizationAiClient {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when MOCK_EXTERNAL_APIS=false");
  }
  return new RealOpenAiPersonalizationClient(env.OPENAI_API_KEY, env.OPENAI_MODEL);
}
