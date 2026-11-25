ALTER TABLE "sepolia_burn_redemptions"
	ADD COLUMN "fundingConfirmations" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "sepolia_burn_redemptions"
	ADD CONSTRAINT "sepolia_burn_redemptions_funding_confirmations_check"
	CHECK ("fundingConfirmations" >= 0);
