// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Verifies DAA points committed by the prepared public Testnet checkpoint v3.
library TbcBootstrapVerifierTestnetV3 {
    bytes32 internal constant CONTEXT_DOMAIN_HASH = 0x67580be190f63bae2a4b74e51b27298aa0a7b0de80df4964c494823ec68f4e54;
    bytes32 internal constant CHECKPOINT_HASH = 0x0000000000000034e4fd15c535dc48b74f305b3864359db53fa618f71f54a43c;
    bytes32 internal constant COMMITMENT_ROOT = 0x560bd1322d4d1da2a3aac73785d23f370252fe6b3e07a1b0d053080821f89b28;
    uint32 internal constant START_HEIGHT = 832868;
    uint32 internal constant END_HEIGHT = 840932;
    uint32 internal constant POINT_COUNT = 8065;
    uint256 internal constant PROOF_LENGTH = 13;

    struct Point { uint32 height; bytes32 blockHash; uint32 time; uint32 bits; uint256 chainWork; }

    function leaf(Point memory point) internal pure returns (bytes32) {
        return keccak256(abi.encode(CONTEXT_DOMAIN_HASH, CHECKPOINT_HASH, point.height, point.blockHash, point.time, point.bits, point.chainWork));
    }

    function verify(Point memory point, bytes32[] calldata siblings) internal pure returns (bool) {
        if (point.height < START_HEIGHT || point.height > END_HEIGHT || siblings.length != PROOF_LENGTH) return false;
        uint256 index = point.height - START_HEIGHT;
        uint256 width = POINT_COUNT;
        bytes32 current = leaf(point);
        for (uint256 level; level < siblings.length; ++level) {
            bytes32 sibling = siblings[level];
            if ((width & 1) == 1 && index == width - 1 && sibling != current) return false;
            current = (index & 1) == 1 ? keccak256(abi.encodePacked(sibling, current)) : keccak256(abi.encodePacked(current, sibling));
            index /= 2;
            width = (width + 1) / 2;
        }
        return current == COMMITMENT_ROOT;
    }
}
