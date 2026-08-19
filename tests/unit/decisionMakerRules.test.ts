import { describe, expect, it } from "vitest";
import { isDecisionMakerTitle } from "../../src/domain/enrichment/decisionMakerRules.js";

describe("isDecisionMakerTitle", () => {
  it.each([
    "Owner",
    "CEO",
    "Chief Executive Officer",
    "President",
    "Founder",
    "Co-Founder & CEO",
    "Managing Director",
    "General Manager",
    "Principal",
    "Partner",
    "Proprietor",
  ])("treats '%s' as a decision maker", (title) => {
    expect(isDecisionMakerTitle(title, null)).toBe(true);
  });

  it.each(["Office Manager", "Marketing Coordinator", "Sales Associate", "Receptionist", null])(
    "does not treat '%s' as a decision maker on title alone",
    (title) => {
      expect(isDecisionMakerTitle(title, null)).toBe(false);
    },
  );

  it("falls back to Apollo's seniority tag when the title is ambiguous", () => {
    expect(isDecisionMakerTitle("Team Lead", "owner")).toBe(true);
    expect(isDecisionMakerTitle("Team Lead", "c_suite")).toBe(true);
    expect(isDecisionMakerTitle("Team Lead", "manager")).toBe(false);
    expect(isDecisionMakerTitle("Team Lead", null)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isDecisionMakerTitle("owner/operator", null)).toBe(true);
    expect(isDecisionMakerTitle("OWNER", null)).toBe(true);
  });
});
