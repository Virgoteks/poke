export interface ApolloPersonSummary {
  apolloPersonId: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  linkedinUrl: string | null;
  phone: string | null;
  /** Apollo's own seniority tag, if provided ("owner", "founder", "c_suite", "director", ...). */
  seniority: string | null;
  /** Apollo often doesn't include a real email at search time; it must be revealed separately. */
  emailLocked: boolean;
}

export interface ApolloClient {
  searchPeople(domain: string, companyName: string): Promise<ApolloPersonSummary[]>;
  /** Reveals (and typically spends a credit for) a specific person's email address. */
  matchPerson(apolloPersonId: string): Promise<{ email: string | null }>;
}
