CREATE TABLE "proof_bridge_routes" (
    "id" UUID NOT NULL,
    "identityId" UUID NOT NULL,
    "version" VARCHAR(32) NOT NULL,
    "chainId" INTEGER NOT NULL DEFAULT 998,
    "sourceAddress" VARCHAR(100) NOT NULL,
    "deployer" VARCHAR(42) NOT NULL,
    "relay" VARCHAR(42) NOT NULL,
    "gateway" VARCHAR(42) NOT NULL,
    "wrappedToken" VARCHAR(42) NOT NULL,
    "relayTxHash" VARCHAR(66) NOT NULL,
    "gatewayTxHash" VARCHAR(66) NOT NULL,
    "reserveController" VARCHAR(42) NOT NULL,
    "checkpointHeight" INTEGER NOT NULL,
    "checkpointHash" VARCHAR(66) NOT NULL,
    "bootstrapRoot" VARCHAR(66) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'verified',
    "verifiedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "proof_bridge_routes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "proof_bridge_routes_identity_fkey" FOREIGN KEY ("identityId") REFERENCES "wallet_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "proof_bridge_routes_chain_check" CHECK ("chainId" = 998 AND "checkpointHeight" >= 0),
    CONSTRAINT "proof_bridge_routes_status_check" CHECK ("status" IN ('verified', 'paused')),
    CONSTRAINT "proof_bridge_routes_address_check" CHECK ("deployer" ~ '^0x[0-9a-fA-F]{40}$' AND "relay" ~ '^0x[0-9a-fA-F]{40}$' AND "gateway" ~ '^0x[0-9a-fA-F]{40}$' AND "wrappedToken" ~ '^0x[0-9a-fA-F]{40}$' AND "reserveController" ~ '^0x[0-9a-fA-F]{40}$'),
    CONSTRAINT "proof_bridge_routes_hash_check" CHECK ("relayTxHash" ~ '^0x[0-9a-fA-F]{64}$' AND "gatewayTxHash" ~ '^0x[0-9a-fA-F]{64}$' AND "checkpointHash" ~ '^0x[0-9a-fA-F]{64}$' AND "bootstrapRoot" ~ '^0x[0-9a-fA-F]{64}$')
);

CREATE UNIQUE INDEX "proof_bridge_routes_version_key" ON "proof_bridge_routes"("version");
CREATE UNIQUE INDEX "proof_bridge_routes_relay_key" ON "proof_bridge_routes"("relay");
CREATE UNIQUE INDEX "proof_bridge_routes_gateway_key" ON "proof_bridge_routes"("gateway");
CREATE UNIQUE INDEX "proof_bridge_routes_wrapped_token_key" ON "proof_bridge_routes"("wrappedToken");
CREATE UNIQUE INDEX "proof_bridge_routes_relay_tx_key" ON "proof_bridge_routes"("relayTxHash");
CREATE UNIQUE INDEX "proof_bridge_routes_gateway_tx_key" ON "proof_bridge_routes"("gatewayTxHash");
CREATE INDEX "proof_bridge_routes_identity_created_idx" ON "proof_bridge_routes"("identityId", "createdAt");

CREATE TABLE "proof_bridge_transfers" (
    "id" UUID NOT NULL,
    "identityId" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "buildId" UUID NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'signed',
    "sender" VARCHAR(100) NOT NULL,
    "recipient" VARCHAR(42) NOT NULL,
    "amountRaw" DECIMAL(78,0) NOT NULL,
    "depositId" VARCHAR(66) NOT NULL,
    "sourceTxid" CHAR(64) NOT NULL,
    "sourceRaw" TEXT NOT NULL,
    "parentTransactions" JSONB NOT NULL,
    "ancestorTransactions" JSONB NOT NULL,
    "signatureWitnesses" JSONB NOT NULL,
    "signaturePushOffsets" JSONB NOT NULL,
    "blockHash" VARCHAR(66),
    "blockHeight" INTEGER,
    "transactionIndex" INTEGER,
    "transactionCount" INTEGER,
    "merkleSiblings" JSONB,
    "sourceConfirmations" INTEGER NOT NULL DEFAULT 0,
    "relayHeight" INTEGER,
    "relayPendingHeight" INTEGER,
    "relayPendingTxHash" VARCHAR(66),
    "relayPendingRaw" TEXT,
    "relayPendingNonce" BIGINT,
    "mintTxHash" VARCHAR(66),
    "mintRawTransaction" TEXT,
    "mintNonce" BIGINT,
    "mintBlockNumber" BIGINT,
    "mintConfirmations" INTEGER NOT NULL DEFAULT 0,
    "mintGasUsed" DECIMAL(78,0),
    "mintFeeWei" DECIMAL(78,0),
    "checkedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "proof_bridge_transfers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "proof_bridge_transfers_identity_fkey" FOREIGN KEY ("identityId") REFERENCES "wallet_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "proof_bridge_transfers_route_fkey" FOREIGN KEY ("routeId") REFERENCES "proof_bridge_routes"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "proof_bridge_transfers_status_check" CHECK ("status" IN ('signed', 'source_submitted', 'confirming_source', 'relaying_headers', 'ready_to_mint', 'mint_submitted', 'completed', 'needs_review')),
    CONSTRAINT "proof_bridge_transfers_counts_check" CHECK ("sourceConfirmations" >= 0 AND "mintConfirmations" >= 0 AND "failureCount" >= 0 AND ("blockHeight" IS NULL OR "blockHeight" >= 0) AND ("transactionIndex" IS NULL OR "transactionIndex" >= 0) AND ("transactionCount" IS NULL OR "transactionCount" > 0)),
    CONSTRAINT "proof_bridge_transfers_hash_check" CHECK ("depositId" ~ '^0x[0-9a-fA-F]{64}$' AND "sourceTxid" ~ '^[0-9a-fA-F]{64}$' AND ("blockHash" IS NULL OR "blockHash" ~ '^0x[0-9a-fA-F]{64}$') AND ("relayPendingTxHash" IS NULL OR "relayPendingTxHash" ~ '^0x[0-9a-fA-F]{64}$') AND ("mintTxHash" IS NULL OR "mintTxHash" ~ '^0x[0-9a-fA-F]{64}$'))
);

CREATE UNIQUE INDEX "proof_bridge_transfers_build_id_key" ON "proof_bridge_transfers"("buildId");
CREATE UNIQUE INDEX "proof_bridge_transfers_deposit_id_key" ON "proof_bridge_transfers"("depositId");
CREATE UNIQUE INDEX "proof_bridge_transfers_source_txid_key" ON "proof_bridge_transfers"("sourceTxid");
CREATE UNIQUE INDEX "proof_bridge_transfers_mint_tx_key" ON "proof_bridge_transfers"("mintTxHash");
CREATE INDEX "proof_bridge_transfers_identity_created_idx" ON "proof_bridge_transfers"("identityId", "createdAt");
CREATE INDEX "proof_bridge_transfers_status_checked_idx" ON "proof_bridge_transfers"("status", "checkedAt");
