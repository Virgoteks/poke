/**
 * Deterministic normalization helpers used throughout the pipeline for
 * dedup / suppression matching. Keeping these pure and dependency-free
 * makes them trivial to unit test and safe to reuse everywhere.
 */

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) return null;
  return trimmed;
}

export function normalizeDomain(urlOrDomain: string | null | undefined): string | null {
  if (!urlOrDomain) return null;
  let value = urlOrDomain.trim().toLowerCase();
  if (!value) return null;
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    value = `https://${value}`;
  }
  try {
    const url = new URL(value);
    let host = url.hostname;
    if (host.startsWith("www.")) host = host.slice(4);
    return host || null;
  } catch {
    return null;
  }
}

export function isValidEmailFormat(email: string): boolean {
  // Deterministic RFC-5322-ish check before any external verification call.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
