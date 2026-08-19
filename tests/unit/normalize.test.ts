import { describe, expect, it } from "vitest";
import { isValidEmailFormat, normalizeDomain, normalizeEmail } from "../../src/lib/normalize.js";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Jane.Doe@Example.COM  ")).toBe("jane.doe@example.com");
  });
  it("returns null for missing/empty/invalid input", () => {
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("not-an-email")).toBeNull();
  });
});

describe("normalizeDomain", () => {
  it("strips protocol, www, path, and query", () => {
    expect(normalizeDomain("https://www.Example.com/path?x=1")).toBe("example.com");
    expect(normalizeDomain("example.com")).toBe("example.com");
    expect(normalizeDomain("http://sub.example.com")).toBe("sub.example.com");
  });
  it("returns null for garbage input", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain(undefined)).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
  });
});

describe("isValidEmailFormat", () => {
  it("accepts well-formed addresses", () => {
    expect(isValidEmailFormat("owner@business.com")).toBe(true);
  });
  it("rejects malformed addresses", () => {
    expect(isValidEmailFormat("owner@")).toBe(false);
    expect(isValidEmailFormat("@business.com")).toBe(false);
    expect(isValidEmailFormat("owner business.com")).toBe(false);
  });
});
