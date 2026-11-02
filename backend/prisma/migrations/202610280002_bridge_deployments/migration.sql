-- Deployment lifecycle only. No existing rows or applied migrations are changed.
CREATE TABLE "bridge_deployments" (
    "id" UUID NOT NULL,
    "identityId" UUID NOT NULL,
    "routeId" VARCHAR(100) NOT NULL,
    "chainId" INTEGER NOT NULL DEFAULT 998,
    "deployer" VARCHAR(42) NOT NULL,
    "admin" VARCHAR(42) NOT NULL,
    "minter" VARCHAR(42) NOT NULL,
    "contractId" CHAR(64) NOT NULL,
    "decimals" SMALLINT NOT NULL,
    "nonce" BIGINT NOT NULL,
    "buildInputSha256" CHAR(64) NOT NULL,
    "initCodeHash" VARCHAR(66) NOT NULL,
    "transactionData" TEXT NOT NULL,
    "runtimeBytecode" TEXT NOT NULL,
    "immutableReferences" JSONB NOT NULL,
    "quote" JSONB NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'prepared',
    "txHash" VARCHAR(66),
    "contractAddress" VARCHAR(42),
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "receiptBlockHash" VARCHAR(66),
    "receiptBlockNumber" BIGINT,
    "gasUsed" DECIMAL(78,0),
    "effectiveGasPriceWei" DECIMAL(78,0),
    "actualFeeWei" DECIMAL(78,0),
    "runtimeCodeHash" VARCHAR(66),
    "verifiedAt" TIMESTAMPTZ(3),
    "checkedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "bridge_deployments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bridge_deployments_identity_fkey" FOREIGN KEY ("identityId") REFERENCES "wallet_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bridge_deployments_asset_fkey" FOREIGN KEY ("routeId") REFERENCES "bridge_assets"("routeId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bridge_deployments_network_check" CHECK ("chainId" = 998 AND "nonce" >= 0 AND "confirmations" >= 0 AND "decimals" BETWEEN 0 AND 255),
    CONSTRAINT "bridge_deployments_status_check" CHECK ("status" IN ('prepared', 'awaiting_wallet', 'submitted', 'confirming', 'verified', 'reverted', 'invalid', 'cancelled')),
    CONSTRAINT "bridge_deployments_hash_check" CHECK ("contractId" ~ '^[0-9a-f]{64}$' AND "buildInputSha256" ~ '^[0-9a-f]{64}$' AND "initCodeHash" ~ '^0x[0-9a-f]{64}$' AND ("txHash" IS NULL OR "txHash" ~ '^0x[0-9a-f]{64}$')),
    CONSTRAINT "bridge_deployments_address_check" CHECK ("deployer" ~ '^0x[0-9a-fA-F]{40}$' AND "admin" ~ '^0x[0-9a-fA-F]{40}$' AND "minter" ~ '^0x[0-9a-fA-F]{40}$'),
    CONSTRAINT "bridge_deployments_fee_check" CHECK (("gasUsed" IS NULL OR "gasUsed" >= 0) AND ("effectiveGasPriceWei" IS NULL OR "effectiveGasPriceWei" >= 0) AND ("actualFeeWei" IS NULL OR "actualFeeWei" >= 0))
);
CREATE UNIQUE INDEX "bridge_deployments_chainId_txHash_key" ON "bridge_deployments"("chainId", "txHash");
CREATE UNIQUE INDEX "bridge_deployments_chainId_contractAddress_key" ON "bridge_deployments"("chainId", "contractAddress");
CREATE INDEX "bridge_deployments_identityId_createdAt_idx" ON "bridge_deployments"("identityId", "createdAt");
-- An unresolved wallet request survives refresh; never open a second deployment
-- for the same user/route until it is explicitly cancelled or resolved.
CREATE UNIQUE INDEX "bridge_deployments_active_route_key" ON "bridge_deployments"("identityId", "routeId")
    WHERE "status" IN ('prepared', 'awaiting_wallet', 'submitted', 'confirming', 'verified');
CREATE UNIQUE INDEX "bridge_deployments_active_nonce_key" ON "bridge_deployments"("chainId", lower("deployer"), "nonce")
    WHERE "status" IN ('prepared', 'awaiting_wallet', 'submitted', 'confirming', 'verified');
