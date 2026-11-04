// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcFtUnlockPrefixVerifier} from "./TbcFtUnlockPrefixVerifier.sol";
import {TbcPartialSha256} from "./TbcPartialSha256.sol";

/// @notice Stateless getCurrentTxdata/buildFtPrePreTxData verification harness.
/// @dev A future gateway must require this gate together with the authorization gate.
contract TbcFtUnlockPrefixHarness {
    function partialSha256State(bytes calldata value, uint256 offset, uint256 length)
        external
        pure
        returns (bytes32)
    {
        return TbcPartialSha256.state(value, offset, length);
    }

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
