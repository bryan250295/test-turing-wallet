-- Optional testnet Admin automation retains the contract's exact 2-of-2
-- sequence while durably pinning both signed transactions before broadcast.
CREATE TABLE "bridge_admin_activations" (
	"deploymentId" UUID PRIMARY KEY,
	"identityId" UUID NOT NULL,
	"chainId" INTEGER NOT NULL,
	"adminAddress" VARCHAR(42) NOT NULL,
	"targetAddress" VARCHAR(42) NOT NULL,
	"actionId" VARCHAR(66) NOT NULL,
	"status" VARCHAR(32) NOT NULL DEFAULT 'proposal_signed',
	"proposalNonce" BIGINT NOT NULL,
	"proposalData" TEXT NOT NULL,
	"proposalGasLimit" BIGINT NOT NULL,
	"proposalGasPriceWei" DECIMAL(78,0) NOT NULL,
	"proposalRawTransaction" TEXT NOT NULL,
	"proposalTxHash" VARCHAR(66) NOT NULL UNIQUE,
	"proposalConfirmations" INTEGER NOT NULL DEFAULT 0,
	"proposalReceiptBlockHash" VARCHAR(66),
	"proposalReceiptBlockNumber" BIGINT,
	"proposalActualFeeWei" DECIMAL(78,0),
	"approvalNonce" BIGINT,
	"approvalData" TEXT,
	"approvalGasLimit" BIGINT,
	"approvalGasPriceWei" DECIMAL(78,0),
	"approvalRawTransaction" TEXT,
	"approvalTxHash" VARCHAR(66) UNIQUE,
	"approvalConfirmations" INTEGER NOT NULL DEFAULT 0,
	"approvalReceiptBlockHash" VARCHAR(66),
	"approvalReceiptBlockNumber" BIGINT,
	"approvalActualFeeWei" DECIMAL(78,0),
	"checkedAt" TIMESTAMPTZ(3),
	"lastError" TEXT,
	"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "bridge_admin_activations_deployment_fkey" FOREIGN KEY ("deploymentId") REFERENCES "bridge_deployments"("id") ON DELETE RESTRICT,
	CONSTRAINT "bridge_admin_activations_chain_check" CHECK ("chainId" IN (998, 11155111)),
	CONSTRAINT "bridge_admin_activations_action_check" CHECK ("actionId" ~ '^0x[0-9a-fA-F]{64}$'),
	CONSTRAINT "bridge_admin_activations_status_check" CHECK ("status" IN ('proposal_signed','proposal_submitted','proposal_confirming','proposal_verified','approval_signed','approval_submitted','approval_confirming','completed','needs_review')),
	CONSTRAINT "bridge_admin_activations_proposal_raw_check" CHECK ("proposalRawTransaction" ~ '^0x[0-9a-fA-F]+$'),
	CONSTRAINT "bridge_admin_activations_approval_raw_check" CHECK ("approvalRawTransaction" IS NULL OR "approvalRawTransaction" ~ '^0x[0-9a-fA-F]+$'),
	CONSTRAINT "bridge_admin_activations_approval_bundle_check" CHECK (
		("approvalNonce" IS NULL AND "approvalData" IS NULL AND "approvalGasLimit" IS NULL AND "approvalGasPriceWei" IS NULL AND "approvalRawTransaction" IS NULL AND "approvalTxHash" IS NULL)
		OR ("approvalNonce" IS NOT NULL AND "approvalData" IS NOT NULL AND "approvalGasLimit" IS NOT NULL AND "approvalGasPriceWei" IS NOT NULL AND "approvalRawTransaction" IS NOT NULL AND "approvalTxHash" IS NOT NULL)
	)
);

CREATE UNIQUE INDEX "bridge_admin_activations_chain_admin_target_key" ON "bridge_admin_activations"("chainId", "adminAddress", "targetAddress");
CREATE INDEX "bridge_admin_activations_status_checked_idx" ON "bridge_admin_activations"("status", "checkedAt");
