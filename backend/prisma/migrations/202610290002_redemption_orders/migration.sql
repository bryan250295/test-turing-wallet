CREATE TABLE "redemption_orders" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "identityId" UUID NOT NULL,
    "escrowId" UUID NOT NULL,
    "escrowAddress" VARCHAR(42) NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "redemptionId" VARCHAR(66) NOT NULL,
    "holder" VARCHAR(42) NOT NULL,
    "tbcRecipient" VARCHAR(35) NOT NULL,
    "amountRaw" DECIMAL(78,0) NOT NULL,
    "termsHash" CHAR(64) NOT NULL,
    "policyVersion" VARCHAR(64) NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'prepared',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMPTZ(3),
    CONSTRAINT "redemption_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "redemption_orders_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "bridge_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "redemption_orders_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "wallet_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "redemption_orders_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "redemption_escrow_deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "redemption_orders_amount_check" CHECK ("amountRaw" > 0 AND "amountRaw" <= 18446744073709551615),
    CONSTRAINT "redemption_orders_status_check" CHECK (("status" = 'prepared' AND "cancelledAt" IS NULL) OR ("status" = 'cancelled' AND "cancelledAt" IS NOT NULL)),
    CONSTRAINT "redemption_orders_policy_check" CHECK ("policyVersion" = 'permanent-escrow-preparation-v1'),
    CONSTRAINT "redemption_orders_hash_check" CHECK ("redemptionId" ~ '^0x[0-9a-f]{64}$' AND "redemptionId" <> '0x0000000000000000000000000000000000000000000000000000000000000000' AND "termsHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "redemption_orders_holder_check" CHECK ("escrowAddress" ~ '^0x[0-9a-f]{40}$' AND "holder" ~ '^0x[0-9a-f]{40}$')
);
CREATE UNIQUE INDEX "redemption_orders_redemptionId_key" ON "redemption_orders"("redemptionId");
CREATE UNIQUE INDEX "redemption_orders_identityId_idempotencyKey_key" ON "redemption_orders"("identityId", "idempotencyKey");
CREATE INDEX "redemption_orders_identityId_orderId_createdAt_idx" ON "redemption_orders"("identityId", "orderId", "createdAt");
