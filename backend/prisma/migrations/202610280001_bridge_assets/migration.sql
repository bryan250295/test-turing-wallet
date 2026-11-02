-- Add the first verified bridge-asset registry. Existing tables and data are unchanged.
CREATE TABLE "bridge_assets" (
    "routeId" VARCHAR(100) NOT NULL,
    "sourceNetwork" VARCHAR(32) NOT NULL,
    "contractId" CHAR(64) NOT NULL,
    "protocol" VARCHAR(32) NOT NULL,
    "name" VARCHAR(1000) NOT NULL,
    "symbol" VARCHAR(100) NOT NULL,
    "decimals" SMALLINT NOT NULL,
    "legacyVersion" SMALLINT NOT NULL,
    "totalSupplyRaw" DECIMAL(78,0) NOT NULL,
    "genesisCodeHash" CHAR(64) NOT NULL,
    "genesisTapeHash" CHAR(64) NOT NULL,
    "mintSourceTxid" CHAR(64) NOT NULL,
    "mintSourceVout" INTEGER NOT NULL,
    "genesisBlockHash" CHAR(64) NOT NULL,
    "genesisBlockHeight" INTEGER NOT NULL,
    "confirmations" INTEGER NOT NULL,
    "destinationChainId" INTEGER NOT NULL,
    "verificationMethod" VARCHAR(100) NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bridge_assets_pkey" PRIMARY KEY ("routeId"),
    CONSTRAINT "bridge_assets_network_check" CHECK ("sourceNetwork" = 'testnet' AND "destinationChainId" = 998),
    CONSTRAINT "bridge_assets_protocol_check" CHECK ("protocol" = 'legacy-ft' AND "legacyVersion" BETWEEN 1 AND 4),
    CONSTRAINT "bridge_assets_decimals_check" CHECK ("decimals" BETWEEN 0 AND 255),
    CONSTRAINT "bridge_assets_supply_check" CHECK ("totalSupplyRaw" > 0 AND "totalSupplyRaw" <= 18446744073709551615),
    CONSTRAINT "bridge_assets_outpoint_check" CHECK ("mintSourceVout" >= 0 AND "genesisBlockHeight" >= 0 AND "confirmations" >= 6),
    CONSTRAINT "bridge_assets_hash_check" CHECK (
        "contractId" ~ '^[0-9a-f]{64}$' AND "mintSourceTxid" ~ '^[0-9a-f]{64}$'
        AND "genesisBlockHash" ~ '^[0-9a-f]{64}$' AND "genesisCodeHash" ~ '^[0-9a-f]{64}$'
        AND "genesisTapeHash" ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX "bridge_assets_sourceNetwork_contractId_destinationChainId_key"
    ON "bridge_assets"("sourceNetwork", "contractId", "destinationChainId");
