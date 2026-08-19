import type { EmailVerificationClient, EmailVerificationOutcome, VerificationResult } from "./types.js";

function seededFraction(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return (hash % 1000) / 1000;
}

/**
 * Deterministic mock. Reserved substrings in the local part let tests
 * force a specific outcome without real network access:
 *   contains "invalid" -> invalid, "risky" -> risky, "unknown" -> unknown
 * Anything else resolves deterministically from a hash, skewed valid
 * (~80%) to resemble a realistic verification result mix.
 */
export class MockEmailVerificationClient implements EmailVerificationClient {
  async verify(email: string): Promise<EmailVerificationOutcome> {
    const lower = email.toLowerCase();
    let result: VerificationResult;
    if (lower.includes("invalid")) result = "invalid";
    else if (lower.includes("risky")) result = "risky";
    else if (lower.includes("unknown")) result = "unknown";
    else {
      const frac = seededFraction(lower);
      result = frac < 0.8 ? "valid" : frac < 0.9 ? "risky" : "invalid";
    }
    return { result, raw: { mock: true, email, result } };
  }
}
