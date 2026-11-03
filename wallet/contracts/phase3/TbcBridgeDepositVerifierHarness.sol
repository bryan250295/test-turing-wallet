// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    ITbcHeaderRelayV2,
    TbcBridgeDepositVerifier
} from "./TbcBridgeDepositVerifier.sol";

/// @notice Stateless Phase 3D cross-language and gas-test harness only.
contract TbcBridgeDepositVerifierHarness {
    function inspectDeposit(
        bytes calldata rawTransaction,
        address expectedGateway,
        bytes20 expectedReserveController
    ) external pure returns (TbcBridgeDepositVerifier.VerifiedDeposit memory) {
        return TbcBridgeDepositVerifier.verifyEnvelope(
            rawTransaction, expectedGateway, expectedReserveController
        );
    }

    function verifyMerkleDeposit(
        bytes32 committedMerkleRoot,
        bytes calldata rawTransaction,
        uint32 transactionIndex,
        uint32 transactionCount,
        bytes32[] calldata displayedSiblings,
        address expectedGateway,
        bytes20 expectedReserveController
    ) external pure returns (TbcBridgeDepositVerifier.VerifiedDeposit memory) {
        return TbcBridgeDepositVerifier.verifyMerkleEnvelope(
            committedMerkleRoot,
            rawTransaction,
            transactionIndex,
            transactionCount,
            displayedSiblings,
            expectedGateway,
            expectedReserveController
        );
    }

    function verifyFinalizedDeposit(
        ITbcHeaderRelayV2 relay,
        bytes32 blockHash,
        bytes calldata rawTransaction,
        uint32 transactionIndex,
        uint32 transactionCount,
        bytes32[] calldata displayedSiblings,
        address expectedGateway,
        bytes20 expectedReserveController
    ) external view returns (TbcBridgeDepositVerifier.VerifiedDeposit memory) {
        return TbcBridgeDepositVerifier.verifyFinalizedInclusion(
            relay,
            blockHash,
            rawTransaction,
            transactionIndex,
            transactionCount,
            displayedSiblings,
            expectedGateway,
            expectedReserveController
        );
    }
}
