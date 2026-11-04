// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcFtUnlockPrefixVerifier} from "./TbcFtUnlockPrefixVerifier.sol";

/// @notice Immutable-code, stateless legacy-v3 unlock-prefix module for the gateway.
contract TbcFtUnlockPrefixVerifierModule {
    function verifyFtUnlockPrefixes(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        bytes[][] calldata ancestorTransactions,
        uint32[] calldata signaturePushOffsets
    ) external pure returns (bool) {
        return TbcFtUnlockPrefixVerifier.verify(
            rawTransaction,
            parentTransactions,
            ancestorTransactions,
            signaturePushOffsets
        );
    }
}
