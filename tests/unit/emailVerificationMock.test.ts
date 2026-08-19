import { describe, expect, it } from "vitest";
import { MockEmailVerificationClient } from "../../src/integrations/emailVerification/mockClient.js";

describe("MockEmailVerificationClient", () => {
  it("is deterministic for a given email", async () => {
    const client = new MockEmailVerificationClient();
    const a = await client.verify("someone@example.com");
    const b = await client.verify("someone@example.com");
    expect(a).toEqual(b);
  });

  it("respects reserved substrings for forcing specific outcomes", async () => {
    const client = new MockEmailVerificationClient();
    expect((await client.verify("invalid-user@example.com")).result).toBe("invalid");
    expect((await client.verify("risky-user@example.com")).result).toBe("risky");
    expect((await client.verify("unknown-user@example.com")).result).toBe("unknown");
  });

  it("produces a realistic mix of results for arbitrary emails", async () => {
    const client = new MockEmailVerificationClient();
    const results = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const outcome = await client.verify(`user${i}@example${i}.com`);
      results.add(outcome.result);
    }
    expect(results.size).toBeGreaterThan(1);
  });
});
