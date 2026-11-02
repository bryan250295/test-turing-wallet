-- Preserve prepared orders, frozen terms and custody ciphertext. Add funding and
-- wallet-confirmed settlement separately; no chain transaction is sent by SQL.
CREATE TABLE "bridge_settlements" (
    "orderId" UUID NOT NULL PRIMARY KEY REFERENCES "bridge_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "status" VARCHAR(32) NOT NULL DEFAULT 'awaiting_payment',
    "paymentOpenedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMPTZ(3), "lastError" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "bridge_settlements_state_check" CHECK ("status" IN ('awaiting_payment','confirming','ready_to_mint','mint_pending','completed','needs_review'))
);
CREATE TABLE "bridge_deposits" (
    "orderId" UUID NOT NULL PRIMARY KEY REFERENCES "bridge_settlements"("orderId") ON DELETE RESTRICT ON UPDATE CASCADE,
    "sourceNetwork" VARCHAR(32) NOT NULL,
    "txid" CHAR(64) NOT NULL, "vout" INTEGER NOT NULL,
    "amountRaw" DECIMAL(78,0) NOT NULL, "feeRaw" DECIMAL(78,0) NOT NULL, "confirmations" INTEGER NOT NULL,
    "blockHash" CHAR(64), "blockHeight" INTEGER, "checkedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "bridge_deposits_valid_check" CHECK ("sourceNetwork" = 'testnet' AND "txid" ~ '^[0-9a-f]{64}$' AND "vout" BETWEEN 0 AND 65535 AND "amountRaw" > 0 AND "amountRaw" <= 18446744073709551615 AND "feeRaw" > 0 AND "confirmations" >= 0 AND ("blockHash" IS NULL OR "blockHash" ~ '^[0-9a-f]{64}$') AND ("blockHeight" IS NULL OR "blockHeight" >= 0))
);
CREATE UNIQUE INDEX "bridge_deposits_sourceNetwork_txid_vout_key" ON "bridge_deposits"("sourceNetwork","txid","vout");
CREATE TABLE "bridge_call_attempts" (
    "id" UUID NOT NULL PRIMARY KEY,
    "orderId" UUID NOT NULL REFERENCES "bridge_settlements"("orderId") ON DELETE RESTRICT ON UPDATE CASCADE,
    "kind" VARCHAR(16) NOT NULL, "status" VARCHAR(24) NOT NULL DEFAULT 'quoted',
    "chainId" INTEGER NOT NULL DEFAULT 998,
    "fromAddress" VARCHAR(42) NOT NULL, "toAddress" VARCHAR(42) NOT NULL,
    "data" TEXT NOT NULL, "nonce" BIGINT NOT NULL, "gasLimit" BIGINT NOT NULL,
    "gasPriceWei" DECIMAL(78,0) NOT NULL, "estimatedFeeWei" DECIMAL(78,0) NOT NULL, "budgetWei" DECIMAL(78,0) NOT NULL,
    "txHash" VARCHAR(66), "confirmations" INTEGER NOT NULL DEFAULT 0,
    "receiptBlockHash" VARCHAR(66), "receiptBlockNumber" BIGINT, "actualFeeWei" DECIMAL(78,0), "lastError" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "bridge_call_attempts_valid_check" CHECK ("kind" IN ('unpause','mint') AND "status" IN ('quoted','awaiting_wallet','submitted','confirming','verified','reverted','invalid','cancelled') AND "chainId" = 998 AND "nonce" >= 0 AND "gasLimit" > 0 AND "gasPriceWei" > 0 AND "budgetWei" > 0 AND "estimatedFeeWei" > 0 AND "confirmations" >= 0 AND "fromAddress" ~ '^0x[0-9a-f]{40}$' AND "toAddress" ~ '^0x[0-9a-f]{40}$' AND "data" ~ '^0x[0-9a-f]+$' AND ("txHash" IS NULL OR "txHash" ~ '^0x[0-9a-f]{64}$'))
);
CREATE UNIQUE INDEX "bridge_call_attempts_txHash_key" ON "bridge_call_attempts"("txHash");
CREATE INDEX "bridge_call_attempts_orderId_createdAt_idx" ON "bridge_call_attempts"("orderId","createdAt");
-- Unknown wallet submissions retain their slot until their hash is reconciled.
CREATE UNIQUE INDEX "bridge_call_attempts_active_order_key" ON "bridge_call_attempts"("orderId") WHERE "status" IN ('quoted','awaiting_wallet','submitted','confirming');
CREATE UNIQUE INDEX "bridge_call_attempts_active_sender_key" ON "bridge_call_attempts"("chainId","fromAddress") WHERE "status" IN ('quoted','awaiting_wallet','submitted','confirming');
