// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    ITbcHeaderRelayV2,
    TbcBridgeDepositVerifier
} from "./TbcBridgeDepositVerifier.sol";

/// @notice Stateless finalized-header, Merkle-inclusion and deposit-envelope verifier.
contract TbcFinalizedDepositVerifier {
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
