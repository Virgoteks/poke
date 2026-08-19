export type VerificationResult = "valid" | "invalid" | "risky" | "unknown";

export interface EmailVerificationOutcome {
  result: VerificationResult;
  raw: unknown;
}

export interface EmailVerificationClient {
  verify(email: string): Promise<EmailVerificationOutcome>;
}
