-- CreateTable
CREATE TABLE "redemption_releases" (
    "redemptionId" UUID NOT NULL,
    "fundingAddress" VARCHAR(100) NOT NULL,
    "fundingRequiredRaw" BIGINT NOT NULL,
    "feeQuote" JSONB NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'awaiting_fee',
    "lastError" TEXT,
    "checkedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "redemption_releases_pkey" PRIMARY KEY ("redemptionId")
);

-- CreateTable
CREATE TABLE "redemption_release_plans" (
    "redemptionId" UUID NOT NULL,
    "unsignedRaw" TEXT NOT NULL,
    "planHash" CHAR(64) NOT NULL,
    "feeRaw" BIGINT NOT NULL,
    "inputs" JSONB NOT NULL,
    "proof" TEXT NOT NULL,
    "fundingTxid" CHAR(64) NOT NULL,
    "fundingVout" INTEGER NOT NULL,
    "fundingValueRaw" BIGINT NOT NULL,
    "reserveTxid" CHAR(64) NOT NULL,
    "reserveVout" INTEGER NOT NULL,
    "reserveRaw" TEXT NOT NULL,
    "fundingRaw" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "redemption_release_plans_pkey" PRIMARY KEY ("redemptionId")
);

-- CreateTable
CREATE TABLE "redemption_locks" (
    "redemptionId" UUID NOT NULL,
    "chainId" INTEGER NOT NULL DEFAULT 998,
    "txHash" VARCHAR(66) NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockHash" VARCHAR(66) NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "confirmations" INTEGER NOT NULL,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "redemption_locks_pkey" PRIMARY KEY ("redemptionId")
);

-- CreateTable
CREATE TABLE "redemption_signed_releases" (
    "redemptionId" UUID NOT NULL,
    "txid" CHAR(64) NOT NULL,
    "raw" TEXT NOT NULL,
    "feeRaw" BIGINT NOT NULL,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "blockHash" CHAR(64),
    "blockHeight" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "redemption_signed_releases_pkey" PRIMARY KEY ("redemptionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "redemption_release_plans_reserveTxid_reserveVout_key" ON "redemption_release_plans"("reserveTxid", "reserveVout");

-- CreateIndex
CREATE UNIQUE INDEX "redemption_release_plans_fundingTxid_fundingVout_key" ON "redemption_release_plans"("fundingTxid", "fundingVout");

-- CreateIndex
CREATE UNIQUE INDEX "redemption_locks_chainId_txHash_logIndex_key" ON "redemption_locks"("chainId", "txHash", "logIndex");

-- CreateIndex
CREATE UNIQUE INDEX "redemption_signed_releases_txid_key" ON "redemption_signed_releases"("txid");

-- AddForeignKey
ALTER TABLE "redemption_releases" ADD CONSTRAINT "redemption_releases_redemptionId_fkey" FOREIGN KEY ("redemptionId") REFERENCES "redemption_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_release_plans" ADD CONSTRAINT "redemption_release_plans_redemptionId_fkey" FOREIGN KEY ("redemptionId") REFERENCES "redemption_releases"("redemptionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_locks" ADD CONSTRAINT "redemption_locks_redemptionId_fkey" FOREIGN KEY ("redemptionId") REFERENCES "redemption_releases"("redemptionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_signed_releases" ADD CONSTRAINT "redemption_signed_releases_redemptionId_fkey" FOREIGN KEY ("redemptionId") REFERENCES "redemption_releases"("redemptionId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Immutable plans and signed bytes are insert-only for the runtime role.
ALTER TABLE "redemption_releases" ADD CONSTRAINT "redemption_release_status_check" CHECK ("status" IN ('awaiting_fee','funded','locked','signed','broadcasting','submitted','confirming','completed','needs_review'));
ALTER TABLE "redemption_releases" ADD CONSTRAINT "redemption_release_funding_check" CHECK ("fundingRequiredRaw" >= 1000 AND "fundingRequiredRaw" <= 1000000);
ALTER TABLE "redemption_release_plans" ADD CONSTRAINT "redemption_release_plan_check" CHECK ("feeRaw" > 0 AND "fundingValueRaw" >= "feeRaw" + 500 AND "fundingValueRaw" <= 1000000 AND "reserveVout" = 0 AND "fundingVout" >= 0 AND "planHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "redemption_locks" ADD CONSTRAINT "redemption_lock_check" CHECK ("chainId" = 998 AND "confirmations" >= 6 AND "logIndex" >= 0 AND "blockNumber" >= 0);
ALTER TABLE "redemption_signed_releases" ADD CONSTRAINT "redemption_signed_release_check" CHECK ("feeRaw" > 0 AND "confirmations" >= 0 AND "txid" ~ '^[0-9a-f]{64}$');
