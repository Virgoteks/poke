import type { ApolloClient, ApolloPersonSummary } from "./types.js";

function seededFraction(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return (hash % 1000) / 1000;
}

const TITLE_POOL = ["Owner", "Office Manager", "CEO", "Marketing Coordinator", "General Manager", "Sales Associate"];

/**
 * Deterministic mock: the same domain always yields the same people. A
 * domain containing "no-contacts" returns an empty result set, letting
 * tests exercise the "no decision maker found" path without real network
 * access.
 */
export class MockApolloClient implements ApolloClient {
  async searchPeople(domain: string, companyName: string): Promise<ApolloPersonSummary[]> {
    const key = domain || companyName;
    if (key.includes("no-contacts")) return [];

    const count = 2 + Math.floor(seededFraction(key) * 2); // 2-3 people
    return Array.from({ length: count }, (_, i) => {
      const seed = `${key}-${i}`;
      const frac = seededFraction(seed);
      const title = TITLE_POOL[Math.floor(frac * TITLE_POOL.length)]!;
      const firstName = ["Alex", "Jordan", "Taylor", "Morgan", "Casey"][i % 5]!;
      const lastName = ["Smith", "Johnson", "Lee", "Brown", "Garcia"][i % 5]!;
      return {
        apolloPersonId: `mock-person-${key}-${i}`,
        fullName: `${firstName} ${lastName}`,
        firstName,
        lastName,
        title,
        linkedinUrl: `https://linkedin.com/in/${firstName.toLowerCase()}-${lastName.toLowerCase()}`,
        phone: null,
        seniority: title === "Owner" || title === "CEO" ? "owner" : null,
        emailLocked: true,
      };
    });
  }

  async matchPerson(apolloPersonId: string): Promise<{ email: string | null }> {
    // Deterministically "reveal" an email for the mock person.
    const parts = apolloPersonId.split("-");
    const domain = parts.slice(2, -1).join("-") || "example.com";
    const frac = seededFraction(apolloPersonId);
    if (frac < 0.05) return { email: null }; // occasionally simulate "no email on file"
    return { email: `contact.${Math.floor(frac * 10000)}@${domain}` };
  }
}
