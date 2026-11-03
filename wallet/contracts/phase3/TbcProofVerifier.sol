// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Pure TBC header, proof-of-work and Merkle primitives for the v2 verifier.
/// @dev TBC display hashes are big-endian hexadecimal while header and Merkle wire
///      values are little-endian. Every reversal in this library is intentional.
library TbcProofVerifier {
    uint256 internal constant TBC_MAIN_POW_LIMIT =
        0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

    struct Header {
        uint32 version;
        bytes32 previousBlockHash;
        bytes32 merkleRoot;
        uint32 time;
        uint32 bits;
        uint32 nonce;
        bytes32 blockHash;
    }

    error InvalidHeaderLength(uint256 actual);
    error InvalidCompactTarget(uint32 compact);
    error TargetAbovePowLimit(uint256 target, uint256 powLimit);
    error InsufficientProofOfWork(bytes32 blockHash, uint256 target);
    error InvalidTransactionCount();
    error InvalidTransactionIndex(uint256 index, uint256 count);
    error InvalidMerkleBranchLength(uint256 supplied, uint256 required);
    error InvalidOddLeafSibling(uint256 level);

    function reverseBytes32(bytes32 input) internal pure returns (bytes32) {
        uint256 source = uint256(input);
        uint256 reversed;
        for (uint256 index; index < 32; ++index) {
            reversed = (reversed << 8) | (source & 0xff);
            source >>= 8;
        }
        return bytes32(reversed);
    }

    function doubleSha256(bytes memory value) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(value)));
    }

    /// @return hash Display-order block hash, matching TBCNODE and TBCScan.
    function headerHash(bytes calldata rawHeader) internal pure returns (bytes32 hash) {
        if (rawHeader.length != 80) revert InvalidHeaderLength(rawHeader.length);
        hash = reverseBytes32(doubleSha256(rawHeader));
    }

    function parseHeader(bytes calldata rawHeader) internal pure returns (Header memory header) {
        if (rawHeader.length != 80) revert InvalidHeaderLength(rawHeader.length);
        header.version = readUint32LE(rawHeader, 0);
        header.previousBlockHash = reverseBytes32(readBytes32(rawHeader, 4));
        header.merkleRoot = reverseBytes32(readBytes32(rawHeader, 36));
        header.time = readUint32LE(rawHeader, 68);
        header.bits = readUint32LE(rawHeader, 72);
        header.nonce = readUint32LE(rawHeader, 76);
        header.blockHash = reverseBytes32(doubleSha256(rawHeader));
    }

    function verifyHeader(bytes calldata rawHeader, uint256 powLimit)
        internal
        pure
        returns (Header memory header, uint256 target)
    {
        header = parseHeader(rawHeader);
        target = checkedTarget(header.bits, powLimit);
        if (uint256(header.blockHash) > target) {
            revert InsufficientProofOfWork(header.blockHash, target);
        }
    }

    /// @dev Mirrors TBCNODE/Bitcoin arith_uint256::SetCompact.
    function decodeCompactTarget(uint32 compact)
        internal
        pure
        returns (uint256 target, bool negative, bool overflowed)
    {
        uint32 size = compact >> 24;
        uint256 word = uint256(compact & 0x007fffff);
        negative = word != 0 && (compact & 0x00800000) != 0;
        overflowed = word != 0
            && (size > 34 || (word > 0xff && size > 33) || (word > 0xffff && size > 32));
        if (overflowed) return (0, negative, true);
        if (size <= 3) target = word >> (8 * (3 - size));
        else target = word << (8 * (size - 3));
    }

    /// @dev Mirrors TBCNODE/Bitcoin arith_uint256::GetCompact for non-negative targets.
    function encodeCompactTarget(uint256 target) internal pure returns (uint32 compact) {
        if (target == 0) return 0;
        uint256 cursor = target;
        uint32 size;
        while (cursor != 0) {
            ++size;
            cursor >>= 8;
        }
        uint256 word = size <= 3 ? target << (8 * (3 - size)) : target >> (8 * (size - 3));
        if ((word & 0x00800000) != 0) {
            word >>= 8;
            ++size;
        }
        compact = uint32((size << 24) | uint32(word));
    }

    function checkedTarget(uint32 compact, uint256 powLimit) internal pure returns (uint256 target) {
        bool negative;
        bool overflowed;
        (target, negative, overflowed) = decodeCompactTarget(compact);
        if (negative || overflowed || target == 0) revert InvalidCompactTarget(compact);
        if (target > powLimit) revert TargetAbovePowLimit(target, powLimit);
    }

    /// @dev Mirrors TBCNODE GetBlockProof: (~target / (target + 1)) + 1.
    function blockWork(uint32 compact) internal pure returns (uint256) {
        (uint256 target, bool negative, bool overflowed) = decodeCompactTarget(compact);
        if (negative || overflowed || target == 0) return 0;
        if (target == type(uint256).max) return 1;
        return (type(uint256).max - target) / (target + 1) + 1;
    }

    /// @notice Reconstruct a TBC Merkle root with canonical index/count semantics.
    /// @dev This rejects extra branch nodes and requires Bitcoin/TBC's duplicated
    ///      odd leaf to be supplied exactly, preventing ambiguous branch shapes.
    function merkleRoot(
        bytes32 displayedTxid,
        uint32 transactionIndex,
        uint32 transactionCount,
        bytes32[] calldata displayedSiblings
    ) internal pure returns (bytes32 displayedRoot) {
        if (transactionCount == 0) revert InvalidTransactionCount();
        if (transactionIndex >= transactionCount) {
            revert InvalidTransactionIndex(transactionIndex, transactionCount);
        }

        uint256 required;
        for (uint256 width = transactionCount; width > 1; width = (width + 1) / 2) ++required;
        if (displayedSiblings.length != required) {
            revert InvalidMerkleBranchLength(displayedSiblings.length, required);
        }

        bytes32 current = reverseBytes32(displayedTxid);
        uint256 index = transactionIndex;
        uint256 count = transactionCount;
        for (uint256 level; level < displayedSiblings.length; ++level) {
            bytes32 sibling = reverseBytes32(displayedSiblings[level]);
            bool isDuplicatedOddLeaf = (count & 1) == 1 && index == count - 1;
            if (isDuplicatedOddLeaf && sibling != current) revert InvalidOddLeafSibling(level);
            current = (index & 1) == 1
                ? doubleSha256(abi.encodePacked(sibling, current))
                : doubleSha256(abi.encodePacked(current, sibling));
            index /= 2;
            count = (count + 1) / 2;
        }
        displayedRoot = reverseBytes32(current);
    }

    function readBytes32(bytes calldata value, uint256 offset) private pure returns (bytes32 result) {
        assembly ("memory-safe") {
            result := calldataload(add(value.offset, offset))
        }
    }

    function readUint32LE(bytes calldata value, uint256 offset) private pure returns (uint32 result) {
        result = uint32(uint8(value[offset]))
            | (uint32(uint8(value[offset + 1])) << 8)
            | (uint32(uint8(value[offset + 2])) << 16)
            | (uint32(uint8(value[offset + 3])) << 24);
    }
}
