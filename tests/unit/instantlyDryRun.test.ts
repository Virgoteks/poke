import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("createInstantlyClient dry-run gating", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the mock client whenever DRY_RUN_SENDING is true, even if MOCK_EXTERNAL_APIS is false", async () => {
    vi.doMock("../../src/config/env.js", () => ({
      env: { LOG_LEVEL: "silent", MOCK_EXTERNAL_APIS: false, DRY_RUN_SENDING: true, INSTANTLY_API_KEY: "" },
      isProduction: false,
      isTest: true,
    }));
    const { createInstantlyClient } = await import("../../src/integrations/instantly/index.js");
    const { MockInstantlyClient } = await import("../../src/integrations/instantly/mockClient.js");
    const client = createInstantlyClient();
    expect(client).toBeInstanceOf(MockInstantlyClient);
  });

  it("returns the mock client whenever MOCK_EXTERNAL_APIS is true, even if DRY_RUN_SENDING is false", async () => {
    vi.doMock("../../src/config/env.js", () => ({
      env: { LOG_LEVEL: "silent", MOCK_EXTERNAL_APIS: true, DRY_RUN_SENDING: false, INSTANTLY_API_KEY: "" },
      isProduction: false,
      isTest: true,
    }));
    const { createInstantlyClient } = await import("../../src/integrations/instantly/index.js");
    const { MockInstantlyClient } = await import("../../src/integrations/instantly/mockClient.js");
    const client = createInstantlyClient();
    expect(client).toBeInstanceOf(MockInstantlyClient);
  });

  it("only returns the real client when both MOCK_EXTERNAL_APIS and DRY_RUN_SENDING are false", async () => {
    vi.doMock("../../src/config/env.js", () => ({
      env: { LOG_LEVEL: "silent", MOCK_EXTERNAL_APIS: false, DRY_RUN_SENDING: false, INSTANTLY_API_KEY: "real-key" },
      isProduction: false,
      isTest: true,
    }));
    const { createInstantlyClient } = await import("../../src/integrations/instantly/index.js");
    const { RealInstantlyClient } = await import("../../src/integrations/instantly/realClient.js");
    const client = createInstantlyClient();
    expect(client).toBeInstanceOf(RealInstantlyClient);
  });

  it("the mock client never performs a network call and returns a dryRun result", async () => {
    const { MockInstantlyClient } = await import("../../src/integrations/instantly/mockClient.js");
    const client = new MockInstantlyClient();
    const result = await client.sendEmail({
      toEmail: "someone@example.com",
      toName: "Someone",
      subject: "Hi",
      body: "Body",
      idempotencyKey: "key-123",
    });
    expect(result.dryRun).toBe(true);
    expect(result.instantlyMessageId).toContain("key-123");
  });
});
