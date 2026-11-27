-- Automatic mint attempts persist the exact signed transaction before the
-- first broadcast. A retry therefore re-broadcasts the same nonce/hash instead
-- of creating a second mint transaction after an ambiguous RPC response.
ALTER TABLE "bridge_call_attempts"
	ADD COLUMN "submissionMode" VARCHAR(16) NOT NULL DEFAULT 'wallet',
	ADD COLUMN "rawTransaction" TEXT;

ALTER TABLE "bridge_call_attempts"
	ADD CONSTRAINT "bridge_call_attempts_submission_mode_check"
	CHECK (
		"submissionMode" IN ('wallet', 'relayer')
		AND ("rawTransaction" IS NULL OR "rawTransaction" ~ '^0x[0-9a-fA-F]+$')
		AND ("submissionMode" = 'relayer' OR "rawTransaction" IS NULL)
	);
