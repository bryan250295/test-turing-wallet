-- Add prepared orders and encrypted per-order custody. Payment is not enabled.
CREATE TABLE "bridge_orders" (
    "id" UUID NOT NULL,
    "identityId" UUID NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "deploymentId" UUID NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'prepared',
    "sourceNetwork" VARCHAR(32) NOT NULL,
    "contractId" CHAR(64) NOT NULL,
    "decimals" SMALLINT NOT NULL,
    "symbol" VARCHAR(100) NOT NULL,
    "amountRaw" DECIMAL(78,0) NOT NULL,
    "sender" VARCHAR(100) NOT NULL,
    "recipient" VARCHAR(42) NOT NULL,
    "destinationChainId" INTEGER NOT NULL,
    "destinationContract" VARCHAR(42) NOT NULL,
    "sourceConfirmationsRequired" INTEGER NOT NULL,
    "destinationConfirmationsRequired" INTEGER NOT NULL,
    "termsHash" CHAR(64) NOT NULL,
    "policyVersion" VARCHAR(100) NOT NULL,
    "targetCheckedBlockNumber" BIGINT NOT NULL,
    "targetCheckedBlockHash" VARCHAR(66) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMPTZ(3),
    CONSTRAINT "bridge_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bridge_orders_identity_fkey" FOREIGN KEY ("identityId") REFERENCES "wallet_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bridge_orders_deployment_fkey" FOREIGN KEY ("deploymentId") REFERENCES "bridge_deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bridge_orders_state_check" CHECK (("status" = 'prepared' AND "cancelledAt" IS NULL) OR ("status" = 'cancelled' AND "cancelledAt" IS NOT NULL)),
    CONSTRAINT "bridge_orders_route_check" CHECK ("sourceNetwork" = 'testnet' AND "destinationChainId" = 998 AND "decimals" BETWEEN 0 AND 255 AND "sourceConfirmationsRequired" >= 6 AND "destinationConfirmationsRequired" >= 6),
    CONSTRAINT "bridge_orders_amount_check" CHECK ("amountRaw" > 0 AND "amountRaw" <= 18446744073709551615),
    CONSTRAINT "bridge_orders_hash_check" CHECK ("contractId" ~ '^[0-9a-f]{64}$' AND "termsHash" ~ '^[0-9a-f]{64}$' AND "targetCheckedBlockHash" ~ '^0x[0-9a-f]{64}$' AND "targetCheckedBlockNumber" >= 0),
    CONSTRAINT "bridge_orders_address_check" CHECK ("recipient" ~ '^0x[0-9a-f]{40}$' AND "destinationContract" ~ '^0x[0-9a-f]{40}$' AND "recipient" <> '0x0000000000000000000000000000000000000000' AND "recipient" <> "destinationContract")
);
CREATE UNIQUE INDEX "bridge_orders_identityId_idempotencyKey_key" ON "bridge_orders"("identityId", "idempotencyKey");
CREATE INDEX "bridge_orders_identityId_createdAt_idx" ON "bridge_orders"("identityId", "createdAt");

CREATE TABLE "bridge_custody" (
    "orderId" UUID NOT NULL,
    "network" VARCHAR(32) NOT NULL,
    "address" VARCHAR(100) NOT NULL,
    "publicKeyHex" VARCHAR(66) NOT NULL,
    "addressFormat" VARCHAR(64) NOT NULL,
    "version" SMALLINT NOT NULL,
    "keyId" CHAR(64) NOT NULL,
    "ivHex" CHAR(24) NOT NULL,
    "tagHex" CHAR(32) NOT NULL,
    "ciphertextHex" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bridge_custody_pkey" PRIMARY KEY ("orderId"),
    CONSTRAINT "bridge_custody_order_fkey" FOREIGN KEY ("orderId") REFERENCES "bridge_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bridge_custody_format_check" CHECK ("network" = 'testnet' AND "version" = 1 AND "addressFormat" = 'tbc-p2pkh-pubkeyhash00-compressed' AND "address" ~ '^1[1-9A-HJ-NP-Za-km-z]{25,34}$' AND "publicKeyHex" ~ '^(02|03)[0-9a-f]{64}$'),
    CONSTRAINT "bridge_custody_crypto_check" CHECK ("keyId" ~ '^[0-9a-f]{64}$' AND "ivHex" ~ '^[0-9a-f]{24}$' AND "tagHex" ~ '^[0-9a-f]{32}$' AND "ciphertextHex" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "bridge_custody_address_key" ON "bridge_custody"("address");
