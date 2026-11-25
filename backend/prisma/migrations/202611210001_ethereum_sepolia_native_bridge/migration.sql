-- Extend the existing bridge order/settlement tables to the independently
-- verified native-TBC -> Ethereum Sepolia route. Existing HyperEVM records and
-- constraints remain valid.
ALTER TABLE "bridge_assets" DROP CONSTRAINT "bridge_assets_network_check";
ALTER TABLE "bridge_assets" ADD CONSTRAINT "bridge_assets_network_check"
  CHECK ("sourceNetwork" = 'testnet' AND "destinationChainId" IN (998, 11155111));

ALTER TABLE "bridge_assets" DROP CONSTRAINT "bridge_assets_protocol_check";
ALTER TABLE "bridge_assets" ADD CONSTRAINT "bridge_assets_protocol_check"
  CHECK (("protocol" = 'legacy-ft' AND "legacyVersion" BETWEEN 1 AND 4 AND "destinationChainId" = 998)
      OR ("protocol" = 'native-tbc' AND "legacyVersion" = 0 AND "destinationChainId" = 11155111));

ALTER TABLE "bridge_deployments" DROP CONSTRAINT "bridge_deployments_network_check";
ALTER TABLE "bridge_deployments" ADD CONSTRAINT "bridge_deployments_network_check"
  CHECK ("chainId" IN (998, 11155111) AND "nonce" >= 0 AND "confirmations" >= 0 AND "decimals" BETWEEN 0 AND 255);

ALTER TABLE "bridge_orders" DROP CONSTRAINT "bridge_orders_route_check";
ALTER TABLE "bridge_orders" ADD CONSTRAINT "bridge_orders_route_check"
  CHECK ("sourceNetwork" = 'testnet' AND "destinationChainId" IN (998, 11155111)
    AND "decimals" BETWEEN 0 AND 255 AND "sourceConfirmationsRequired" >= 6 AND "destinationConfirmationsRequired" >= 6);

ALTER TABLE "bridge_call_attempts" DROP CONSTRAINT "bridge_call_attempts_valid_check";
ALTER TABLE "bridge_call_attempts" ADD CONSTRAINT "bridge_call_attempts_valid_check"
  CHECK ("kind" IN ('unpause','mint')
    AND "status" IN ('quoted','awaiting_wallet','submitted','confirming','verified','reverted','invalid','cancelled')
    AND "chainId" IN (998, 11155111) AND "nonce" >= 0 AND "gasLimit" > 0
    AND "gasPriceWei" > 0 AND "budgetWei" > 0 AND "estimatedFeeWei" > 0 AND "confirmations" >= 0
    AND "fromAddress" ~ '^0x[0-9a-f]{40}$' AND "toAddress" ~ '^0x[0-9a-f]{40}$'
    AND "data" ~ '^0x[0-9a-f]+$' AND ("txHash" IS NULL OR "txHash" ~ '^0x[0-9a-f]{64}$'));
