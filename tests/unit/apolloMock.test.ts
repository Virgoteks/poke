import { describe, expect, it } from "vitest";
import { MockApolloClient } from "../../src/integrations/apollo/mockClient.js";

describe("MockApolloClient", () => {
  it("is deterministic for a given domain", async () => {
    const client = new MockApolloClient();
    const a = await client.searchPeople("acme.com", "Acme");
    const b = await client.searchPeople("acme.com", "Acme");
    expect(a).toEqual(b);
  });

  it("returns no people for a domain containing 'no-contacts'", async () => {
    const client = new MockApolloClient();
    const people = await client.searchPeople("no-contacts.example.com", "Nobody Inc");
    expect(people).toHaveLength(0);
  });

  it("matchPerson deterministically reveals an email for the same person id", async () => {
    const client = new MockApolloClient();
    const people = await client.searchPeople("acme.com", "Acme");
    const first = people[0]!;
    const a = await client.matchPerson(first.apolloPersonId);
    const b = await client.matchPerson(first.apolloPersonId);
    expect(a).toEqual(b);
  });

  it("falls back to the company name as a seed when no domain is available", async () => {
    const client = new MockApolloClient();
    const people = await client.searchPeople("", "No Website Co");
    expect(people.length).toBeGreaterThan(0);
  });
});
