-- deterministic_passed must be able to represent "the deterministic rules
-- were inconclusive and the decision was deferred to AI", which is
-- neither true nor false.
ALTER TABLE qualifications ALTER COLUMN deterministic_passed DROP NOT NULL;
