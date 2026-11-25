CREATE TABLE "sepolia_burn_redemptions" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "identityId" UUID NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'prepared',
    "redemptionKey" VARCHAR(66) NOT NULL,
    "holder" VARCHAR(42) NOT NULL,
    "tbcRecipient" VARCHAR(35) NOT NULL,
    "amountRaw" DECIMAL(78,0) NOT NULL,
    "payoutRaw" BIGINT NOT NULL,
    "feeRaw" BIGINT NOT NULL,
    "releaseUnsignedRaw" TEXT NOT NULL,
    "releasePlanHash" CHAR(64) NOT NULL,
    "releaseRaw" TEXT,
    "releaseTxid" CHAR(64),
    "releaseConfirmations" INTEGER NOT NULL DEFAULT 0,
    "releaseBlockHash" CHAR(64),
    "releaseBlockHeight" INTEGER,
    "checkedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "sepolia_burn_redemptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sepolia_burn_redemptions_status_check" CHECK ("status" IN ('prepared','burn_pending','burn_confirming','burn_verified','release_signed','release_broadcasting','release_submitted','release_confirming','completed','needs_review')),
    CONSTRAINT "sepolia_burn_redemptions_amounts_check" CHECK ("amountRaw" > 0 AND "payoutRaw" > 0 AND "feeRaw" > 0 AND "amountRaw" = "payoutRaw" + "feeRaw")
);

CREATE UNIQUE INDEX "sepolia_burn_redemptions_orderId_key" ON "sepolia_burn_redemptions"("orderId");
CREATE UNIQUE INDEX "sepolia_burn_redemptions_redemptionKey_key" ON "sepolia_burn_redemptions"("redemptionKey");
CREATE UNIQUE INDEX "sepolia_burn_redemptions_releaseTxid_key" ON "sepolia_burn_redemptions"("releaseTxid");
CREATE INDEX "sepolia_burn_redemptions_identityId_createdAt_idx" ON "sepolia_burn_redemptions"("identityId", "createdAt");

CREATE TABLE "sepolia_burn_calls" (
    "id" UUID NOT NULL,
    "redemptionId" UUID NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'quoted',
    "chainId" INTEGER NOT NULL DEFAULT 11155111,
    "fromAddress" VARCHAR(42) NOT NULL,
    "toAddress" VARCHAR(42) NOT NULL,
    "data" TEXT NOT NULL,
    "nonce" BIGINT NOT NULL,
    "gasLimit" BIGINT NOT NULL,
    "gasPriceWei" DECIMAL(78,0) NOT NULL,
    "estimatedFeeWei" DECIMAL(78,0) NOT NULL,
    "budgetWei" DECIMAL(78,0) NOT NULL,
    "txHash" VARCHAR(66),
    "logIndex" INTEGER,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "receiptBlockHash" VARCHAR(66),
    "receiptBlockNumber" BIGINT,
    "actualFeeWei" DECIMAL(78,0),
    "lastError" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "sepolia_burn_calls_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sepolia_burn_calls_chain_check" CHECK ("chainId" = 11155111),
    CONSTRAINT "sepolia_burn_calls_status_check" CHECK ("status" IN ('quoted','awaiting_wallet','submitted','confirming','verified','reverted','invalid','cancelled'))
);

CREATE UNIQUE INDEX "sepolia_burn_calls_txHash_key" ON "sepolia_burn_calls"("txHash");
CREATE INDEX "sepolia_burn_calls_redemptionId_createdAt_idx" ON "sepolia_burn_calls"("redemptionId", "createdAt");

ALTER TABLE "sepolia_burn_redemptions" ADD CONSTRAINT "sepolia_burn_redemptions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "bridge_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sepolia_burn_redemptions" ADD CONSTRAINT "sepolia_burn_redemptions_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "wallet_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sepolia_burn_calls" ADD CONSTRAINT "sepolia_burn_calls_redemptionId_fkey" FOREIGN KEY ("redemptionId") REFERENCES "sepolia_burn_redemptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
