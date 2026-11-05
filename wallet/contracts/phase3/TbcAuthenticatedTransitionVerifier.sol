// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcBridgeDepositVerifier} from "./TbcBridgeDepositVerifier.sol";

/// @notice Stateless parent/ancestor/conservation verifier split for low-gas deployment chains.
contract TbcAuthenticatedTransitionVerifier {
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
}
