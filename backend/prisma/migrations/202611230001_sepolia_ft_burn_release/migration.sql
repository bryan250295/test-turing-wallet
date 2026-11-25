ALTER TABLE "sepolia_burn_redemptions"
    ADD COLUMN "sourceAssetKind" VARCHAR(24) NOT NULL DEFAULT 'native-tbc',
    ADD COLUMN "fundingAddress" VARCHAR(100),
    ADD COLUMN "fundingRequiredRaw" BIGINT,
    ADD COLUMN "feeQuote" JSONB,
    ADD COLUMN "fundingTxid" CHAR(64),
    ADD COLUMN "fundingVout" INTEGER,
    ADD COLUMN "fundingValueRaw" BIGINT,
    ADD COLUMN "fundingRaw" TEXT,
    ADD COLUMN "reserveRaw" TEXT,
    ADD COLUMN "releaseInputs" JSONB,
    ADD COLUMN "proof" TEXT,
    ALTER COLUMN "payoutRaw" DROP NOT NULL,
    ALTER COLUMN "feeRaw" DROP NOT NULL,
    ALTER COLUMN "releaseUnsignedRaw" DROP NOT NULL,
    ALTER COLUMN "releasePlanHash" DROP NOT NULL;

ALTER TABLE "sepolia_burn_redemptions"
    DROP CONSTRAINT "sepolia_burn_redemptions_status_check",
    DROP CONSTRAINT "sepolia_burn_redemptions_amounts_check",
    ADD CONSTRAINT "sepolia_burn_redemptions_status_check" CHECK ("status" IN ('awaiting_fee','prepared','burn_pending','burn_confirming','burn_verified','release_signed','release_broadcasting','release_submitted','release_confirming','completed','needs_review')),
    ADD CONSTRAINT "sepolia_burn_redemptions_asset_kind_check" CHECK ("sourceAssetKind" IN ('native-tbc','fungible-token')),
    ADD CONSTRAINT "sepolia_burn_redemptions_amounts_check" CHECK (
        ("sourceAssetKind" = 'native-tbc' AND "payoutRaw" > 0 AND "feeRaw" > 0 AND "amountRaw" = "payoutRaw" + "feeRaw")
        OR
        ("sourceAssetKind" = 'fungible-token' AND ("payoutRaw" IS NULL OR "payoutRaw" = "amountRaw") AND ("feeRaw" IS NULL OR "feeRaw" > 0))
    ),
    ADD CONSTRAINT "sepolia_burn_redemptions_ft_funding_check" CHECK (
        "sourceAssetKind" <> 'fungible-token'
        OR ("fundingAddress" IS NOT NULL AND "fundingRequiredRaw" > 0 AND "feeQuote" IS NOT NULL)
    );

CREATE UNIQUE INDEX "sepolia_burn_redemptions_funding_input_key"
    ON "sepolia_burn_redemptions"("fundingTxid", "fundingVout")
    WHERE "fundingTxid" IS NOT NULL;
