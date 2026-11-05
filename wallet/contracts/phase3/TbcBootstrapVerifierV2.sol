// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Verifies DAA points committed by the public Testnet checkpoint v2.
library TbcBootstrapVerifierV2 {
    bytes32 internal constant CONTEXT_DOMAIN_HASH =
        0x8ea0b761915acd25131005717f4a30a4922fbbedc7dbda44a54c27b971da60f3;
    bytes32 internal constant CHECKPOINT_HASH =
        0x000000000000005270e8447f4c71c6952ef28e40625fc58ddd38c027f5ef1cda;
    bytes32 internal constant COMMITMENT_ROOT =
        0x471d082663e7ce837793ab0ea19606b3dd6ea66020708f29e9987519154337c5;
    uint32 internal constant START_HEIGHT = 831_975;
    uint32 internal constant END_HEIGHT = 840_039;
    uint32 internal constant POINT_COUNT = 8_065;
    uint256 internal constant PROOF_LENGTH = 13;

    struct Point {
        uint32 height;
        bytes32 blockHash;
        uint32 time;
        uint32 bits;
        uint256 chainWork;
    }

    function leaf(Point memory point) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            CONTEXT_DOMAIN_HASH,
            CHECKPOINT_HASH,
            point.height,
            point.blockHash,
            point.time,
            point.bits,
            point.chainWork
        ));
    }

    function verify(Point memory point, bytes32[] calldata siblings)
        internal
        pure
        returns (bool)
    {
        if (
            point.height < START_HEIGHT || point.height > END_HEIGHT
                || siblings.length != PROOF_LENGTH
        ) return false;
        uint256 index = point.height - START_HEIGHT;
        uint256 width = POINT_COUNT;
        bytes32 current = leaf(point);
        for (uint256 level; level < siblings.length; ++level) {
            bytes32 sibling = siblings[level];
            if ((width & 1) == 1 && index == width - 1 && sibling != current) return false;
            current = (index & 1) == 1
                ? keccak256(abi.encodePacked(sibling, current))
                : keccak256(abi.encodePacked(current, sibling));
            index /= 2;
            width = (width + 1) / 2;
        }
        return current == COMMITMENT_ROOT;
    }
}
