import { env } from "../../config/env.js";
import { callExternalApi, ExternalApiError } from "../httpClient.js";
import type { ApolloClient, ApolloPersonSummary } from "./types.js";

const SEARCH_URL = "https://api.apollo.io/v1/mixed_people/search";
const MATCH_URL = "https://api.apollo.io/v1/people/match";

// Broad decision-maker title filter applied at the API level to conserve
// credits; the deterministic classifier in enrichmentService re-checks
// every result against the canonical title list regardless.
const DECISION_MAKER_TITLES = [
  "owner",
  "ceo",
  "president",
  "founder",
  "co-founder",
  "managing director",
  "general manager",
  "principal",
  "partner",
  "proprietor",
];

interface ApolloSearchResponse {
  people?: Array<{
    id: string;
    name?: string;
    first_name?: string;
    last_name?: string;
    title?: string;
    linkedin_url?: string;
    phone_numbers?: Array<{ sanitized_number?: string }>;
    seniority?: string;
    email?: string | null;
  }>;
}

interface ApolloMatchResponse {
  person?: { email?: string | null };
}

export class RealApolloClient implements ApolloClient {
  constructor(private readonly apiKey: string) {}

  async searchPeople(domain: string, companyName: string): Promise<ApolloPersonSummary[]> {
    const data = await callExternalApi<ApolloSearchResponse>("apollo", "mixed_people/search", async () => {
      const res = await fetch(SEARCH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
        body: JSON.stringify({
          q_organization_domains: [domain],
          organization_name: companyName,
          person_titles: DECISION_MAKER_TITLES,
          page: 1,
          per_page: 10,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ExternalApiError(`Apollo people search failed: ${res.status} ${text}`, res.status);
      }
      return (await res.json()) as ApolloSearchResponse;
    });

    return (data.people ?? []).map((p) => ({
      apolloPersonId: p.id,
      fullName: p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || "Unknown"),
      firstName: p.first_name ?? null,
      lastName: p.last_name ?? null,
      title: p.title ?? null,
      linkedinUrl: p.linkedin_url ?? null,
      phone: p.phone_numbers?.[0]?.sanitized_number ?? null,
      seniority: p.seniority ?? null,
      emailLocked: !p.email,
    }));
  }

  async matchPerson(apolloPersonId: string): Promise<{ email: string | null }> {
    const data = await callExternalApi<ApolloMatchResponse>("apollo", "people/match", async () => {
      const res = await fetch(MATCH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
        body: JSON.stringify({ id: apolloPersonId, reveal_personal_emails: false }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ExternalApiError(`Apollo people match failed: ${res.status} ${text}`, res.status);
      }
      return (await res.json()) as ApolloMatchResponse;
    });
    return { email: data.person?.email ?? null };
  }
}

export function createRealApolloClient(): ApolloClient {
  if (!env.APOLLO_API_KEY) {
    throw new Error("APOLLO_API_KEY is required when MOCK_EXTERNAL_APIS=false");
  }
  return new RealApolloClient(env.APOLLO_API_KEY);
}
