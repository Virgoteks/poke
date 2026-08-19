import { env } from "../../config/env.js";
import { callExternalApi, ExternalApiError } from "../httpClient.js";
import { QUALIFICATION_TIERS, type QualificationAiClient, type QualificationAiResult, type QualificationFacts } from "./types.js";

const API_URL = "https://api.openai.com/v1/chat/completions";

const SYSTEM_PROMPT = `You are a lead-qualification classifier for a web design / SEO / conversion agency's outbound prospecting pipeline.

You will be given a fixed set of factual fields about one business, gathered by an automated pipeline (Google Places data + a website crawl + Google PageSpeed Insights). You must base your judgment ONLY on the fields provided. Do not assume, infer, or invent any fact about the business that is not present in the input — no revenue, no employee count, no industry reputation, no history, nothing. If a field is null, treat it as "unknown", not as evidence of anything.

Your job is to judge how promising this business is as a prospect for web/SEO improvement services:
- A missing website or an unreachable website is usually a STRONG lead (they clearly need help), unless the business category makes a website irrelevant.
- A slow PageSpeed score, thin content, missing contact form, or missing mobile viewport meta tag are all signals of a lead that needs help.
- A fast, modern, complete site is a weak or disqualified lead — there's little to sell.

Respond with structured JSON only, matching the given schema. "reasoning" must cite only the specific fields you were given (e.g. "mobile PageSpeed score is 32" is fine; "they seem like a small family business" is not, unless a given field says so).`;

const RESPONSE_JSON_SCHEMA = {
  name: "qualification_result",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["qualified", "tier", "reasoning", "confidence"],
    properties: {
      qualified: { type: "boolean" },
      tier: { type: "string", enum: [...QUALIFICATION_TIERS] },
      reasoning: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
} as const;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

function validateResult(parsed: unknown): QualificationAiResult {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("AI qualification response was not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.qualified !== "boolean") throw new Error("AI response missing boolean 'qualified'");
  if (typeof obj.tier !== "string" || !(QUALIFICATION_TIERS as readonly string[]).includes(obj.tier)) {
    throw new Error("AI response has an invalid 'tier'");
  }
  if (typeof obj.reasoning !== "string" || obj.reasoning.trim().length === 0) {
    throw new Error("AI response missing 'reasoning'");
  }
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
    throw new Error("AI response has an invalid 'confidence'");
  }
  return {
    qualified: obj.qualified,
    tier: obj.tier as QualificationAiResult["tier"],
    reasoning: obj.reasoning,
    confidence: obj.confidence,
  };
}

export class RealOpenAiQualificationClient implements QualificationAiClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async classify(facts: QualificationFacts): Promise<QualificationAiResult> {
    const data = await callExternalApi<ChatCompletionResponse>("openai", "chat.completions:qualify", async () => {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
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

export function createRealOpenAiQualificationClient(): QualificationAiClient {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when MOCK_EXTERNAL_APIS=false");
  }
  return new RealOpenAiQualificationClient(env.OPENAI_API_KEY, env.OPENAI_MODEL);
}
