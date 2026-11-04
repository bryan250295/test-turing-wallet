// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcBridgeDepositVerifier} from "./TbcBridgeDepositVerifier.sol";
import {TbcInputAuthorization} from "./TbcInputAuthorization.sol";

/// @notice Stateless Phase 3D authorization and parent-witness test harness only.
/// @dev Keeping this expensive path separate lets the compiler remove the
///      envelope/Merkle/finality entry points from this runtime. It has no
///      storage, settlement authority or deployment role.
contract TbcAuthorizedTransitionHarness {
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
