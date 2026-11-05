ALTER TABLE "bridge_settlements"
ADD COLUMN "sourceTxid" CHAR(64);

ALTER TABLE "bridge_settlements"
ADD CONSTRAINT "bridge_settlements_sourceTxid_format"
CHECK ("sourceTxid" IS NULL OR "sourceTxid" ~ '^[0-9a-f]{64}$');

CREATE INDEX "bridge_settlements_background_source_idx"
ON "bridge_settlements" ("status", "checkedAt")
WHERE "sourceTxid" IS NOT NULL;
