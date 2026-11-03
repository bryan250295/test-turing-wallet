// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Verifies points in the frozen tbcdev-testnet DAA bootstrap commitment.
/// @dev The commitment is an explicit extension of the trusted checkpoint. It
///      authenticates pre-checkpoint DAA inputs; it is not a substitute for
///      post-checkpoint header, difficulty or proof-of-work validation.
library TbcBootstrapVerifier {
    bytes32 internal constant CONTEXT_DOMAIN_HASH =
        0xc72c08ec739bdbab8c200de3e34d6564d38f7b9162abfbc9246f2c7e10591a1f;
    bytes32 internal constant CHECKPOINT_HASH =
        0x000000000000023f252086d278485a61b6c225ad07213fff329ef5e31e1c256b;
    bytes32 internal constant COMMITMENT_ROOT =
        0x94ac5bf81d725359d987255015423a13bb4ff99aa04456d6f952e0ddeaa1a273;
    uint32 internal constant START_HEIGHT = 831_100;
    uint32 internal constant END_HEIGHT = 839_164;
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

    /// @dev Tree nodes use keccak256(left || right) and duplicate an unpaired
    ///      rightmost node. Height fixes both the leaf index and proof direction.
    function verify(Point memory point, bytes32[] calldata siblings)
        internal
        pure
        returns (bool)
    {
        if (
            point.height < START_HEIGHT || point.height > END_HEIGHT || siblings.length != PROOF_LENGTH
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
