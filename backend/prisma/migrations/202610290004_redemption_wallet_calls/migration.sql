-- CreateTable
CREATE TABLE "redemption_wallet_calls" (
    "id" UUID NOT NULL,
    "redemptionId" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'quoted',
    "fromAddress" VARCHAR(42) NOT NULL,
    "toAddress" VARCHAR(42) NOT NULL,
    "data" TEXT NOT NULL,
    "nonce" BIGINT NOT NULL,
    "gasLimit" BIGINT NOT NULL,
    "gasPriceWei" DECIMAL(78,0) NOT NULL,
    "estimatedFeeWei" DECIMAL(78,0) NOT NULL,
    "budgetWei" DECIMAL(78,0) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "txHash" VARCHAR(66),
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "receiptBlockHash" VARCHAR(66),
    "receiptBlockNumber" BIGINT,
    "actualFeeWei" DECIMAL(78,0),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "redemption_wallet_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "redemption_wallet_calls_txHash_key" ON "redemption_wallet_calls"("txHash");

-- CreateIndex
CREATE INDEX "redemption_wallet_calls_redemptionId_createdAt_idx" ON "redemption_wallet_calls"("redemptionId", "createdAt");

-- AddForeignKey
ALTER TABLE "redemption_wallet_calls" ADD CONSTRAINT "redemption_wallet_calls_redemptionId_fkey" FOREIGN KEY ("redemptionId") REFERENCES "redemption_releases"("redemptionId") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "redemption_wallet_calls" ADD CONSTRAINT "redemption_wallet_kind_check" CHECK ("kind" IN ('unpause','reset','approve','lock'));
ALTER TABLE "redemption_wallet_calls" ADD CONSTRAINT "redemption_wallet_status_check" CHECK ("status" IN ('quoted','awaiting_wallet','submitted','confirming','verified','reverted','invalid','cancelled'));
ALTER TABLE "redemption_wallet_calls" ADD CONSTRAINT "redemption_wallet_amount_check" CHECK ("nonce" >= 0 AND "gasLimit" > 0 AND "gasPriceWei" > 0 AND "estimatedFeeWei" > 0 AND "budgetWei" = "gasLimit" * "gasPriceWei" AND "confirmations" >= 0);
CREATE UNIQUE INDEX "redemption_wallet_one_active" ON "redemption_wallet_calls" ("redemptionId") WHERE "status" IN ('quoted','awaiting_wallet','submitted','confirming');
CREATE UNIQUE INDEX "redemption_wallet_sender_nonce" ON "redemption_wallet_calls" ("fromAddress","nonce") WHERE "status" IN ('quoted','awaiting_wallet','submitted','confirming');
