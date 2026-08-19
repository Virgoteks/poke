-- A company can be audited (and correctly recorded as audit_failed) even
-- when it has no website at all — there is no URL to store in that case.
ALTER TABLE website_audits ALTER COLUMN url DROP NOT NULL;
