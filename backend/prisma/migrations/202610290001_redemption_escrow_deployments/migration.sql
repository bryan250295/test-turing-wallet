CREATE TABLE "redemption_escrow_deployments" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "deploymentId" UUID NOT NULL,
    "identityId" UUID NOT NULL,
    "deployer" VARCHAR(42) NOT NULL,
    "wrappedToken" VARCHAR(42) NOT NULL,
    "sourceContractId" CHAR(64) NOT NULL,
    "decimals" SMALLINT NOT NULL,
    "nonce" BIGINT NOT NULL,
    "quote" JSONB NOT NULL,
    "buildInputSha256" CHAR(64) NOT NULL,
    "transactionData" TEXT NOT NULL,
    "runtimeBytecode" TEXT NOT NULL,
    "immutableReferences" JSONB NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'prepared',
    "txHash" VARCHAR(66),
    "contractAddress" VARCHAR(42),
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "receiptBlockHash" VARCHAR(66),
    "receiptBlockNumber" BIGINT,
    "actualFeeWei" DECIMAL(78,0),
    "runtimeCodeHash" VARCHAR(66),
    "verifiedAt" TIMESTAMPTZ(3),
    "checkedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "redemption_escrow_deployments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "redemption_escrow_deployments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "bridge_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "redemption_escrow_deployments_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "bridge_deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "redemption_escrow_deployments_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "wallet_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "redemption_escrow_deployments_amounts_check" CHECK ("nonce" >= 0 AND "confirmations" >= 0 AND "decimals" BETWEEN 0 AND 255),
    CONSTRAINT "redemption_escrow_deployments_status_check" CHECK ("status" IN ('prepared', 'awaiting_wallet', 'submitted', 'confirming', 'verified', 'cancelled', 'reverted', 'invalid'))
);
CREATE UNIQUE INDEX "redemption_escrow_deployments_txHash_key" ON "redemption_escrow_deployments"("txHash");
CREATE UNIQUE INDEX "redemption_escrow_deployments_contractAddress_key" ON "redemption_escrow_deployments"("contractAddress");
CREATE INDEX "redemption_escrow_owner_token_created_idx" ON "redemption_escrow_deployments"("identityId", "deploymentId", "createdAt");
CREATE UNIQUE INDEX "redemption_escrow_one_active_per_token" ON "redemption_escrow_deployments"("deploymentId") WHERE "status" IN ('prepared', 'awaiting_wallet', 'submitted', 'confirming', 'verified');
CREATE UNIQUE INDEX "redemption_escrow_active_sender_nonce" ON "redemption_escrow_deployments"("deployer", "nonce") WHERE "status" IN ('prepared', 'awaiting_wallet', 'submitted', 'confirming');
