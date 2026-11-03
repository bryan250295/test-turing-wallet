// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcProofVerifier} from "./TbcProofVerifier.sol";
import {TbcDifficultyVerifier} from "./TbcDifficultyVerifier.sol";

/// @notice Non-settlement harness for Phase 3 cross-language vectors.
/// @dev This contract has no storage, authority, mint path or deployment role.
contract TbcVerifierHarness {
    uint256 public constant TBC_MAIN_POW_LIMIT =
        0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

    function inspectHeader(bytes calldata rawHeader)
        external
        pure
        returns (
            uint32 version,
            bytes32 previousBlockHash,
            bytes32 merkleRoot,
            uint32 time,
            uint32 bits,
            uint32 nonce,
            bytes32 blockHash,
            uint256 target,
            uint256 work
        )
    {
        TbcProofVerifier.Header memory header;
        (header, target) = TbcProofVerifier.verifyHeader(rawHeader, TBC_MAIN_POW_LIMIT);
        return (
            header.version,
            header.previousBlockHash,
            header.merkleRoot,
            header.time,
            header.bits,
            header.nonce,
            header.blockHash,
            target,
            TbcProofVerifier.blockWork(header.bits)
        );
    }

    function reconstructMerkleRoot(
        bytes32 displayedTxid,
        uint32 transactionIndex,
        uint32 transactionCount,
        bytes32[] calldata displayedSiblings
    ) external pure returns (bytes32) {
        return TbcProofVerifier.merkleRoot(
            displayedTxid, transactionIndex, transactionCount, displayedSiblings
        );
    }

    function expectedPostForkBits(
        TbcDifficultyVerifier.Point[] calldata points,
        uint32 previousHeight
    ) external pure returns (uint32) {
        return TbcDifficultyVerifier.expectedPostForkBits(points, previousHeight, TBC_MAIN_POW_LIMIT);
    }

    function compactRoundTrip(uint32 compact)
        external
        pure
        returns (uint256 target, uint32 encoded, bool negative, bool overflowed)
    {
        (target, negative, overflowed) = TbcProofVerifier.decodeCompactTarget(compact);
        encoded = TbcProofVerifier.encodeCompactTarget(target);
    }
}
