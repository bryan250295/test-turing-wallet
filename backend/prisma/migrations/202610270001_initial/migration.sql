-- CreateTable
CREATE TABLE "wallet_identities" (
    "id" UUID NOT NULL,
    "chain" VARCHAR(16) NOT NULL,
    "network" VARCHAR(32) NOT NULL,
    "address" VARCHAR(100) NOT NULL,
    "role" VARCHAR(16) NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_challenges" (
    "id" UUID NOT NULL,
    "chain" VARCHAR(16) NOT NULL,
    "network" VARCHAR(32) NOT NULL,
    "address" VARCHAR(100) NOT NULL,
    "purpose" VARCHAR(16) NOT NULL,
    "lockTxid" CHAR(64),
    "origin" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "bindingHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "tokenHash" CHAR(64) NOT NULL,
    "identityId" UUID NOT NULL,
    "csrfToken" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "htlc_requests" (
    "network" VARCHAR(32) NOT NULL,
    "lockTxid" CHAR(64) NOT NULL,
    "contractId" CHAR(64) NOT NULL,
    "sender" VARCHAR(100) NOT NULL,
    "receiver" VARCHAR(100) NOT NULL,
    "amountRaw" DECIMAL(100,0) NOT NULL,
    "decimals" SMALLINT NOT NULL,
    "symbol" VARCHAR(100) NOT NULL,
    "tokenName" VARCHAR(1000),
    "refundTimestamp" BIGINT NOT NULL,
    "submission" VARCHAR(16),
    "source" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "htlc_requests_pkey" PRIMARY KEY ("network","lockTxid")
);

-- CreateTable
CREATE TABLE "htlc_recoveries" (
    "network" VARCHAR(32) NOT NULL,
    "lockTxid" CHAR(64) NOT NULL,
    "txid" CHAR(64) NOT NULL,
    "action" VARCHAR(8) NOT NULL,
    "submission" VARCHAR(16),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "htlc_recoveries_pkey" PRIMARY KEY ("network","lockTxid","txid")
);

-- CreateTable
CREATE TABLE "htlc_observations" (
    "network" VARCHAR(32) NOT NULL,
    "lockTxid" CHAR(64) NOT NULL,
    "lastResult" JSONB,
    "checkedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "attemptedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "htlc_observations_pkey" PRIMARY KEY ("network","lockTxid")
);

-- CreateTable
CREATE TABLE "claim_secrets" (
    "network" VARCHAR(32) NOT NULL,
    "lockTxid" CHAR(64) NOT NULL,
    "owner" VARCHAR(100) NOT NULL,
    "version" INTEGER NOT NULL,
    "hashHex" CHAR(64) NOT NULL,
    "ivHex" CHAR(24) NOT NULL,
    "tagHex" CHAR(32) NOT NULL,
    "ciphertextHex" CHAR(64) NOT NULL,
    "keyId" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_secrets_pkey" PRIMARY KEY ("network","lockTxid")
);

-- CreateTable
CREATE TABLE "storage_imports" (
    "path" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "importedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_imports_pkey" PRIMARY KEY ("path")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "identityId" UUID,
    "action" VARCHAR(64) NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_identities_chain_network_address_key" ON "wallet_identities"("chain", "network", "address");

-- CreateIndex
CREATE INDEX "auth_challenges_expiresAt_idx" ON "auth_challenges"("expiresAt");

-- CreateIndex
CREATE INDEX "auth_sessions_identityId_idx" ON "auth_sessions"("identityId");

-- CreateIndex
CREATE INDEX "auth_sessions_expiresAt_idx" ON "auth_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "htlc_requests_network_sender_createdAt_idx" ON "htlc_requests"("network", "sender", "createdAt");

-- CreateIndex
CREATE INDEX "htlc_requests_network_receiver_createdAt_idx" ON "htlc_requests"("network", "receiver", "createdAt");

-- CreateIndex
CREATE INDEX "claim_secrets_network_owner_idx" ON "claim_secrets"("network", "owner");

-- CreateIndex
CREATE INDEX "audit_events_identityId_createdAt_idx" ON "audit_events"("identityId", "createdAt");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "wallet_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "htlc_recoveries" ADD CONSTRAINT "htlc_recoveries_network_lockTxid_fkey" FOREIGN KEY ("network", "lockTxid") REFERENCES "htlc_requests"("network", "lockTxid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "htlc_observations" ADD CONSTRAINT "htlc_observations_network_lockTxid_fkey" FOREIGN KEY ("network", "lockTxid") REFERENCES "htlc_requests"("network", "lockTxid") ON DELETE CASCADE ON UPDATE CASCADE;


-- Domain constraints supplement generated types and apply to every database writer.
ALTER TABLE "htlc_requests" ADD CONSTRAINT "htlc_decimals_range" CHECK ("decimals" BETWEEN 0 AND 255);
ALTER TABLE "htlc_requests" ADD CONSTRAINT "htlc_amount_nonnegative" CHECK ("amountRaw" >= 0);
ALTER TABLE "htlc_requests" ADD CONSTRAINT "htlc_network" CHECK ("network" = 'testnet');
ALTER TABLE "htlc_requests" ADD CONSTRAINT "htlc_submission" CHECK ("submission" IS NULL OR "submission" IN ('submitted', 'unknown', 'rejected'));
ALTER TABLE "htlc_recoveries" ADD CONSTRAINT "htlc_recovery_action" CHECK ("action" IN ('claim', 'refund'));
ALTER TABLE "htlc_recoveries" ADD CONSTRAINT "htlc_recovery_submission" CHECK ("submission" IS NULL OR "submission" IN ('submitted', 'unknown', 'rejected'));
ALTER TABLE "wallet_identities" ADD CONSTRAINT "wallet_network" CHECK (("chain" = 'tbc' AND "network" = 'testnet') OR ("chain" = 'evm' AND "network" = '998'));
ALTER TABLE "wallet_identities" ADD CONSTRAINT "wallet_role" CHECK ("role" IN ('user', 'admin'));
ALTER TABLE "auth_challenges" ADD CONSTRAINT "challenge_purpose" CHECK ("purpose" IN ('login', 'reveal'));
