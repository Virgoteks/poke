import { describe, expect, it } from "vitest";
import { MockCalendlyClient } from "../../src/integrations/calendly/mockClient.js";

describe("MockCalendlyClient", () => {
  it("embeds the contactId as utm_content so it can be correlated later", async () => {
    const client = new MockCalendlyClient();
    const result = await client.createSchedulingLink("11111111-1111-1111-1111-111111111111");
    expect(result.bookingUrl).toContain("utm_content=11111111-1111-1111-1111-111111111111");
  });

  it("is deterministic for the same contactId", async () => {
    const client = new MockCalendlyClient();
    const first = await client.createSchedulingLink("22222222-2222-2222-2222-222222222222");
    const second = await client.createSchedulingLink("22222222-2222-2222-2222-222222222222");
    expect(first.bookingUrl).toBe(second.bookingUrl);
  });

  it("produces different links for different contacts", async () => {
    const client = new MockCalendlyClient();
    const a = await client.createSchedulingLink("33333333-3333-3333-3333-333333333333");
    const b = await client.createSchedulingLink("44444444-4444-4444-4444-444444444444");
    expect(a.bookingUrl).not.toBe(b.bookingUrl);
  });
});
