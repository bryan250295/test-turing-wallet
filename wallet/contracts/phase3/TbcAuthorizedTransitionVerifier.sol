// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcBridgeDepositVerifier} from "./TbcBridgeDepositVerifier.sol";
import {TbcInputAuthorization} from "./TbcInputAuthorization.sol";

/// @notice Immutable-code, stateless authorization module for the proof gateway.
contract TbcAuthorizedTransitionVerifier {
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
}
