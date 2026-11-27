CREATE TABLE "bridge_order_drafts" (
	"id" UUID NOT NULL,
	"identityId" UUID NOT NULL,
	"idempotencyKey" UUID NOT NULL,
	"deploymentId" UUID NOT NULL,
	"status" VARCHAR(24) NOT NULL DEFAULT 'draft',
	"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updatedAt" TIMESTAMPTZ(3) NOT NULL,
	"finalizedAt" TIMESTAMPTZ(3),
	"cancelledAt" TIMESTAMPTZ(3),
	CONSTRAINT "bridge_order_drafts_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "bridge_order_drafts_status_check" CHECK ("status" IN ('draft', 'finalized', 'cancelled')),
	CONSTRAINT "bridge_order_drafts_lifecycle_check" CHECK (
		("status" = 'draft' AND "finalizedAt" IS NULL AND "cancelledAt" IS NULL) OR
		("status" = 'finalized' AND "finalizedAt" IS NOT NULL AND "cancelledAt" IS NULL) OR
		("status" = 'cancelled' AND "finalizedAt" IS NULL AND "cancelledAt" IS NOT NULL)
	)
);

CREATE UNIQUE INDEX "bridge_order_drafts_identityId_idempotencyKey_key"
	ON "bridge_order_drafts"("identityId", "idempotencyKey");
CREATE INDEX "bridge_order_drafts_identityId_createdAt_idx"
	ON "bridge_order_drafts"("identityId", "createdAt");

ALTER TABLE "bridge_order_drafts"
	ADD CONSTRAINT "bridge_order_drafts_identity_fkey"
	FOREIGN KEY ("identityId") REFERENCES "wallet_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bridge_order_drafts"
	ADD CONSTRAINT "bridge_order_drafts_deployment_fkey"
	FOREIGN KEY ("deploymentId") REFERENCES "bridge_deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
