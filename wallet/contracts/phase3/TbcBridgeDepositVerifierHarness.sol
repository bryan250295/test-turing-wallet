// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    ITbcHeaderRelayV2,
    TbcBridgeDepositVerifier
} from "./TbcBridgeDepositVerifier.sol";
import {TbcInputAuthorization} from "./TbcInputAuthorization.sol";

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

    function verifyTransition(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        address expectedGateway,
        bytes20 expectedReserveController
    ) external pure returns (TbcBridgeDepositVerifier.VerifiedTransition memory) {
        return TbcBridgeDepositVerifier.verifyTransition(
            rawTransaction,
            parentTransactions,
            expectedGateway,
            expectedReserveController
        );
    }

    function verifyAuthenticatedTransition(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        bytes[][] calldata ancestorTransactions,
        address expectedGateway,
        bytes20 expectedReserveController
    ) external pure returns (TbcBridgeDepositVerifier.VerifiedTransition memory) {
        return TbcBridgeDepositVerifier.verifyAuthenticatedTransition(
            rawTransaction,
            parentTransactions,
            ancestorTransactions,
            expectedGateway,
            expectedReserveController
        );
    }

    function verifyAuthorizedTransition(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        bytes[][] calldata ancestorTransactions,
        TbcInputAuthorization.SignatureWitness[] calldata signatureWitnesses,
        address expectedGateway,
        bytes20 expectedReserveController
    ) external pure returns (TbcBridgeDepositVerifier.VerifiedTransition memory) {
        return TbcInputAuthorization.verifyAuthorizedTransition(
            rawTransaction,
            parentTransactions,
            ancestorTransactions,
            signatureWitnesses,
            expectedGateway,
            expectedReserveController
        );
    }

    function signatureDigest(
        bytes calldata rawTransaction,
        bytes calldata parentTransaction,
        uint256 vin
    ) external pure returns (bytes32) {
        return TbcInputAuthorization.signatureDigest(rawTransaction, parentTransaction, vin);
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
