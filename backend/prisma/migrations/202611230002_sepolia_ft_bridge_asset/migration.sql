-- TBC legacy fungible tokens may be registered independently for HyperEVM
-- custody routes and Ethereum Sepolia burn-return routes. Native TBC remains
-- restricted to its dedicated Sepolia protocol row.
ALTER TABLE "bridge_assets" DROP CONSTRAINT "bridge_assets_protocol_check";

ALTER TABLE "bridge_assets" ADD CONSTRAINT "bridge_assets_protocol_check"
CHECK (
    (
        "protocol" = 'legacy-ft'
        AND "legacyVersion" BETWEEN 1 AND 4
        AND "destinationChainId" IN (998, 11155111)
    )
    OR (
        "protocol" = 'native-tbc'
        AND "legacyVersion" = 0
        AND "destinationChainId" = 11155111
    )
);
