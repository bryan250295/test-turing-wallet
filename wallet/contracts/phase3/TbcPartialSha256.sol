// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice SHA-256 compression state for an exact number of complete 64-byte blocks.
/// @dev TBC's OP_PARTIAL_HASH witness commits this state before SHA-256 padding.
///      This is deliberately narrower than a general streaming SHA-256 API.
library TbcPartialSha256 {
    bytes internal constant ROUND_CONSTANTS = hex"428a2f9871374491b5c0fbcfe9b5dba53956c25b59f111f1923f82a4ab1c5ed5d807aa9812835b01243185be550c7dc372be5d7480deb1fe9bdc06a7c19bf174e49b69c1efbe47860fc19dc6240ca1cc2de92c6f4a7484aa5cb0a9dc76f988da983e5152a831c66db00327c8bf597fc7c6e00bf3d5a7914706ca63511429296727b70a852e1b21384d2c6dfc53380d13650a7354766a0abb81c2c92e92722c85a2bfe8a1a81a664bc24b8b70c76c51a3d192e819d6990624f40e3585106aa07019a4c1161e376c082748774c34b0bcb5391c0cb34ed8aa4a5b9cca4f682e6ff3748f82ee78a5636f84c878148cc7020890befffaa4506cebbef9a3f7c67178f2";

    error InvalidPartialSha256Range(uint256 offset, uint256 length, uint256 available);

    function state(bytes calldata value, uint256 offset, uint256 length)
        internal
        pure
        returns (bytes32 result)
    {
        if (
            length == 0 || length & 63 != 0 || offset > value.length
                || length > value.length - offset
        ) revert InvalidPartialSha256Range(offset, length, value.length);

        uint32[8] memory hashState = [
            uint32(0x6a09e667),
            uint32(0xbb67ae85),
            uint32(0x3c6ef372),
            uint32(0xa54ff53a),
            uint32(0x510e527f),
            uint32(0x9b05688c),
            uint32(0x1f83d9ab),
            uint32(0x5be0cd19)
        ];
        bytes memory roundConstants = ROUND_CONSTANTS;
        for (uint256 blockOffset; blockOffset < length; blockOffset += 64) {
            _compress(value, offset + blockOffset, hashState, roundConstants);
        }

        uint256 packed;
        for (uint256 index; index < 8; ++index) {
            packed |= uint256(hashState[index]) << (224 - index * 32);
        }
        result = bytes32(packed);
    }

    function _compress(
        bytes calldata value,
        uint256 offset,
        uint32[8] memory hashState,
        bytes memory roundConstants
    ) private pure {
        uint32[64] memory words;
        for (uint256 index; index < 16; ++index) {
            uint256 cursor = offset + index * 4;
            words[index] = (uint32(uint8(value[cursor])) << 24)
                | (uint32(uint8(value[cursor + 1])) << 16)
                | (uint32(uint8(value[cursor + 2])) << 8)
                | uint32(uint8(value[cursor + 3]));
        }
        unchecked {
            for (uint256 index = 16; index < 64; ++index) {
                uint32 x = words[index - 15];
                uint32 y = words[index - 2];
                uint32 sigma0 = _rotateRight(x, 7) ^ _rotateRight(x, 18) ^ (x >> 3);
                uint32 sigma1 = _rotateRight(y, 17) ^ _rotateRight(y, 19) ^ (y >> 10);
                words[index] = words[index - 16] + sigma0 + words[index - 7] + sigma1;
            }

            uint32[8] memory working;
            for (uint256 index; index < 8; ++index) working[index] = hashState[index];
            for (uint256 index; index < 64; ++index) {
                uint32 temporary1 = working[7]
                    + (_rotateRight(working[4], 6) ^ _rotateRight(working[4], 11)
                        ^ _rotateRight(working[4], 25))
                    + ((working[4] & working[5]) ^ (~working[4] & working[6]))
                    + _roundConstant(roundConstants, index) + words[index];
                uint32 temporary2 =
                    (_rotateRight(working[0], 2) ^ _rotateRight(working[0], 13)
                        ^ _rotateRight(working[0], 22))
                    + ((working[0] & working[1]) ^ (working[0] & working[2])
                        ^ (working[1] & working[2]));
                working[7] = working[6];
                working[6] = working[5];
                working[5] = working[4];
                working[4] = working[3] + temporary1;
                working[3] = working[2];
                working[2] = working[1];
                working[1] = working[0];
                working[0] = temporary1 + temporary2;
            }
            for (uint256 index; index < 8; ++index) hashState[index] += working[index];
        }
    }

    function _roundConstant(bytes memory constants, uint256 index)
        private
        pure
        returns (uint32 result)
    {
        uint256 offset = index * 4;
        result = (uint32(uint8(constants[offset])) << 24)
            | (uint32(uint8(constants[offset + 1])) << 16)
            | (uint32(uint8(constants[offset + 2])) << 8)
            | uint32(uint8(constants[offset + 3]));
    }

    function _rotateRight(uint32 value, uint256 bits) private pure returns (uint32) {
        return (value >> bits) | (value << uint32(32 - bits));
    }
}
