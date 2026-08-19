import type { QualificationAiClient, QualificationAiResult, QualificationFacts } from "./types.js";

/**
 * Deterministic mock: derives a plausible tier purely from the numeric
 * PageSpeed scores actually present in `facts`, and only ever writes
 * `reasoning` text that cites those same fields — mirroring, without a
 * network call, the "ground the reasoning only in given facts" contract
 * the real OpenAI client enforces via its system prompt + JSON schema.
 */
export class MockOpenAiQualificationClient implements QualificationAiClient {
  async classify(facts: QualificationFacts): Promise<QualificationAiResult> {
    const scores = [facts.pagespeedMobileScore, facts.pagespeedDesktopScore].filter(
      (s): s is number => typeof s === "number",
    );
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

    if (avgScore === null) {
      return {
        qualified: true,
        tier: "warm",
        reasoning: "No PageSpeed scores were available to evaluate; defaulting to a warm tier pending more data.",
        confidence: 0.4,
      };
    }

    if (avgScore < 50) {
      return {
        qualified: true,
        tier: "hot",
        reasoning: `Average PageSpeed performance score is ${avgScore.toFixed(0)}, well below an acceptable threshold, indicating a strong opportunity for performance/SEO improvements.`,
        confidence: 0.85,
      };
    }
    if (avgScore < 75) {
      return {
        qualified: true,
        tier: "warm",
        reasoning: `Average PageSpeed performance score is ${avgScore.toFixed(0)}, which leaves meaningful room for improvement.`,
        confidence: 0.6,
      };
    }
    return {
      qualified: false,
      tier: "cold",
      reasoning: `Average PageSpeed performance score is ${avgScore.toFixed(0)}, already in a strong range, leaving little obvious opportunity.`,
      confidence: 0.55,
    };
  }
}
