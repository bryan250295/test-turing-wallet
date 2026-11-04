// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcProofVerifier} from "./TbcProofVerifier.sol";
import {TbcBoundedTransaction} from "./TbcBoundedTransaction.sol";
import {TbcPartialSha256} from "./TbcPartialSha256.sol";

/// @notice Exact legacy-v3 FT.getFTunlock prefix verification for the bounded route.
/// @dev Verifies getCurrentTxdata || buildFtPrePreTxData up to the signature push.
///      Signature/public-key/getPreTxdata verification remains in TbcInputAuthorization.
library TbcFtUnlockPrefixVerifier {
    uint256 internal constant FT_V3_CODE_BYTES = 1_884;
    uint256 internal constant FT_V3_PARTIAL_OFFSET = 1_856;
    uint256 internal constant FT_V3_CONTROLLER_OFFSET = 1_857;
    bytes32 internal constant FT_V3_CODE_PREFIX_HASH =
        0x587af8d9c41a35a8dcb830f461f56045a3938897cdc4d1cfb5f0fa26e6ab4336;
    bytes32 internal constant FT_V3_CONTRACT_SUFFIX_HASH =
        0x6d7328472a8bce3b6a53519087fd2f83f703e8b450240d9ce9c10cb4cfcbc33a;
    bytes32 internal constant FT_V3_ADDRESS_SUFFIX_HASH =
        0x1996d1d2f449942cebe17805cd8a7526992f6510674f6c162c97339be3bd5a7b;
    bytes32 internal constant FT_V3_CODE_PARTIAL_HASH =
        0x197cfcf91f9a14217df24cf36f567b8d0ff784a638d4d9b7c2add2d888687f9b;

    struct PrefixCursor {
        uint256 cursor;
        uint256 end;
        uint256 vin;
    }

    error PrefixWitnessCountMismatch(uint256 supplied, uint256 expected);
    error PrefixParentCountMismatch(uint256 supplied, uint256 expected);
    error PrefixAncestorGroupCountMismatch(uint256 supplied, uint256 expected);
    error InvalidPrefixParent(uint256 vin);
    error InvalidCurrentTxdata(uint256 vin);
    error InvalidPrePreTxdata(uint256 vin, uint256 slot);

    function verify(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        bytes[][] calldata ancestorTransactions,
        uint32[] calldata signaturePushOffsets
    ) internal pure returns (bool) {
        TbcBoundedTransaction.TransactionView memory transaction =
            TbcBoundedTransaction.inspect(rawTransaction);
        if (signaturePushOffsets.length != transaction.inputCount) {
            revert PrefixWitnessCountMismatch(
                signaturePushOffsets.length, transaction.inputCount
            );
        }
        if (parentTransactions.length != transaction.inputCount) {
            revert PrefixParentCountMismatch(parentTransactions.length, transaction.inputCount);
        }
        if (ancestorTransactions.length != transaction.inputCount) {
            revert PrefixAncestorGroupCountMismatch(
                ancestorTransactions.length, transaction.inputCount
            );
        }

        uint256 nativeVin = transaction.inputCount - 1;
        for (uint256 vin; vin < nativeVin; ++vin) {
            _verifyVin(
                rawTransaction,
                parentTransactions[vin],
                ancestorTransactions[vin],
                signaturePushOffsets[vin],
                transaction,
                vin
            );
        }
        if (ancestorTransactions[nativeVin].length != 0) {
            revert PrefixAncestorGroupCountMismatch(
                ancestorTransactions[nativeVin].length, 0
            );
        }
        return true;
    }

    function _verifyVin(
        bytes calldata rawTransaction,
        bytes calldata parentTransaction,
        bytes[] calldata ancestors,
        uint32 signaturePushOffset,
        TbcBoundedTransaction.TransactionView memory transaction,
        uint256 vin
    ) private pure {
        TbcBoundedTransaction.TransactionView memory parent =
            TbcBoundedTransaction.inspectParent(parentTransaction);
        if (
            parent.txid != transaction.inputs[vin].previousTxid
                || transaction.inputs[vin].outputIndex + 1 >= parent.outputCount
        ) revert InvalidPrefixParent(vin);
        PrefixCursor memory prefix;
        prefix.end = uint256(transaction.inputs[vin].scriptOffset) + signaturePushOffset;
        prefix.vin = vin;
        if (
            prefix.end
                > uint256(transaction.inputs[vin].scriptOffset)
                    + transaction.inputs[vin].scriptLength
        ) {
            revert InvalidCurrentTxdata(vin);
        }
        prefix.cursor = _verifyCurrentTxdata(
            rawTransaction,
            transaction,
            vin,
            transaction.inputs[vin].scriptOffset,
            prefix.end
        );
        prefix.cursor = _verifyPrePreTxdata(
            rawTransaction,
            parentTransaction,
            parent,
            transaction.inputs[vin].outputIndex,
            ancestors,
            prefix
        );
        if (prefix.cursor != prefix.end) revert InvalidCurrentTxdata(vin);
    }

    function _verifyCurrentTxdata(
        bytes calldata raw,
        TbcBoundedTransaction.TransactionView memory transaction,
        uint256 vin,
        uint256 cursor,
        uint256 end
    ) private pure returns (uint256) {
        if (cursor >= end || uint8(raw[cursor]) != 0x51) revert InvalidCurrentTxdata(vin);
        ++cursor;
        for (uint256 outputIndex; outputIndex < transaction.outputCount; ++outputIndex) {
            TbcBoundedTransaction.OutputView memory output = transaction.outputs[outputIndex];
            (cursor,) = _verifyEncodedOutput(
                raw, raw, output, cursor, end, vin, type(uint256).max
            );
            if (output.scriptLength == FT_V3_CODE_BYTES) {
                if (++outputIndex >= transaction.outputCount) revert InvalidCurrentTxdata(vin);
                cursor = _verifyFullOutput(
                    raw, raw, transaction.outputs[outputIndex], cursor, end, vin
                );
            }
            if (cursor >= end || uint8(raw[cursor]) != 0x52) {
                revert InvalidCurrentTxdata(vin);
            }
            ++cursor;
        }
        uint8 expectedIndex = vin == 0 ? 0 : uint8(0x50 + vin);
        if (cursor >= end || uint8(raw[cursor]) != expectedIndex) {
            revert InvalidCurrentTxdata(vin);
        }
        return cursor + 1;
    }

    function _verifyPrePreTxdata(
        bytes calldata raw,
        bytes calldata parentRaw,
        TbcBoundedTransaction.TransactionView memory parent,
        uint32 parentVout,
        bytes[] calldata ancestors,
        PrefixCursor memory prefix
    ) private pure returns (uint256) {
        if (prefix.cursor >= prefix.end || uint8(raw[prefix.cursor]) != 0x57) {
            revert InvalidPrePreTxdata(prefix.vin, 6);
        }
        ++prefix.cursor;
        TbcBoundedTransaction.OutputView memory tape = parent.outputs[parentVout + 1];
        uint256 required = _ancestorIndex(parentRaw, tape.scriptOffset, 6);
        if (ancestors.length != required) {
            revert PrefixAncestorGroupCountMismatch(ancestors.length, required);
        }
        for (uint256 reverseSlot = 6; reverseSlot > 0; --reverseSlot) {
            uint256 slot = reverseSlot - 1;
            if (_readUint64LE(parentRaw, tape.scriptOffset + 3 + slot * 8) == 0) continue;
            if (slot >= parent.inputCount) revert InvalidPrePreTxdata(prefix.vin, slot);
            uint256 ancestorIndex = _ancestorIndex(parentRaw, tape.scriptOffset, slot);
            prefix.cursor = _verifyPrePreSlot(
                raw, ancestors[ancestorIndex], parent, slot, prefix
            );
        }
        return prefix.cursor;
    }

    function _ancestorIndex(bytes calldata parentRaw, uint256 tapeOffset, uint256 slot)
        private
        pure
        returns (uint256 index)
    {
        for (uint256 prior; prior < slot; ++prior) {
            if (_readUint64LE(parentRaw, tapeOffset + 3 + prior * 8) != 0) ++index;
        }
    }

    function _verifyPrePreSlot(
        bytes calldata raw,
        bytes calldata ancestorRaw,
        TbcBoundedTransaction.TransactionView memory parent,
        uint256 slot,
        PrefixCursor memory prefix
    ) private pure returns (uint256) {
        TbcBoundedTransaction.TransactionView memory ancestor =
            TbcBoundedTransaction.inspectParent(ancestorRaw);
        TbcBoundedTransaction.InputView memory source = parent.inputs[slot];
        if (
            ancestor.txid != source.previousTxid || source.outputIndex >= ancestor.outputCount
        ) revert InvalidPrePreTxdata(prefix.vin, slot);
        return _verifyOnePrePre(
            raw, ancestorRaw, ancestor, source.outputIndex, prefix, slot
        );
    }

    function _verifyOnePrePre(
        bytes calldata raw,
        bytes calldata ancestorRaw,
        TbcBoundedTransaction.TransactionView memory ancestor,
        uint32 vout,
        PrefixCursor memory prefix,
        uint256 slot
    ) private pure returns (uint256) {
        uint256 cursor = _consumePush(
            raw, prefix.cursor, prefix.end, 16, prefix.vin, slot
        );
        if (
            _readUint32LE(raw, cursor) != 10
                || _readUint32LE(raw, cursor + 4)
                    != _readUint32LE(ancestorRaw, ancestorRaw.length - 4)
                || _readUint32LE(raw, cursor + 8) != ancestor.inputCount
                || _readUint32LE(raw, cursor + 12) != ancestor.outputCount
        ) revert InvalidPrePreTxdata(prefix.vin, slot);
        cursor += 16;
        cursor = _consumePush(raw, cursor, prefix.end, 32, prefix.vin, slot);
        if (_readBytes32(raw, cursor) != _inputCommitment(ancestor)) {
            revert InvalidPrePreTxdata(prefix.vin, slot);
        }
        cursor += 32;
        cursor = _consumePush(raw, cursor, prefix.end, 32, prefix.vin, slot);
        if (_readBytes32(raw, cursor) != _inputScriptCommitment(ancestorRaw, ancestor)) {
            revert InvalidPrePreTxdata(prefix.vin, slot);
        }
        cursor += 32;
        prefix.cursor = cursor;
        cursor = _verifyOutputCommitments(
            raw, ancestorRaw, ancestor, 0, vout, prefix, slot
        );
        (cursor,) = _verifyEncodedOutput(
            raw, ancestorRaw, ancestor.outputs[vout], cursor, prefix.end, prefix.vin, slot
        );
        prefix.cursor = cursor;
        cursor = _verifyOutputCommitments(
            raw,
            ancestorRaw,
            ancestor,
            vout + 1,
            ancestor.outputCount,
            prefix,
            slot
        );
        if (cursor >= prefix.end || uint8(raw[cursor]) != 0x52) {
            revert InvalidPrePreTxdata(prefix.vin, slot);
        }
        return cursor + 1;
    }

    function _verifyEncodedOutput(
        bytes calldata witnessRaw,
        bytes calldata transactionRaw,
        TbcBoundedTransaction.OutputView memory output,
        uint256 cursor,
        uint256 end,
        uint256 vin,
        uint256 slot
    ) private pure returns (uint256, uint256) {
        cursor = _consumePush(witnessRaw, cursor, end, 8, vin, slot);
        if (_readUint64LE(witnessRaw, cursor) != output.satoshis) {
            _invalid(vin, slot);
        }
        cursor += 8;

        uint256 partialLength = output.scriptLength == FT_V3_CODE_BYTES
            ? FT_V3_PARTIAL_OFFSET
            : uint256(output.scriptLength) / 64 * 64;
        uint256 suffixLength = output.scriptLength - partialLength;
        cursor = _consumePush(witnessRaw, cursor, end, suffixLength, vin, slot);
        if (
            keccak256(witnessRaw[cursor:cursor + suffixLength])
                != keccak256(
                    transactionRaw[
                        output.scriptOffset + partialLength:
                            output.scriptOffset + output.scriptLength
                    ]
                )
        ) _invalid(vin, slot);
        cursor += suffixLength;

        if (partialLength == 0) {
            cursor = _consumePush(witnessRaw, cursor, end, 0, vin, slot);
        } else {
            cursor = _consumePush(witnessRaw, cursor, end, 32, vin, slot);
            bytes32 expected;
            if (output.scriptLength == FT_V3_CODE_BYTES) {
                if (!_isPinnedV3Code(transactionRaw, output)) _invalid(vin, slot);
                expected = FT_V3_CODE_PARTIAL_HASH;
            } else {
                expected = TbcPartialSha256.state(
                    transactionRaw, output.scriptOffset, partialLength
                );
            }
            if (_readBytes32(witnessRaw, cursor) != expected) _invalid(vin, slot);
            cursor += 32;
        }

        uint256 sizeLength = output.scriptLength < 256 ? 1 : 2;
        cursor = _consumePush(witnessRaw, cursor, end, sizeLength, vin, slot);
        if (
            uint8(witnessRaw[cursor]) != uint8(output.scriptLength)
                || sizeLength == 2
                    && uint8(witnessRaw[cursor + 1]) != uint8(output.scriptLength >> 8)
        ) _invalid(vin, slot);
        return (cursor + sizeLength, partialLength);
    }

    function _isPinnedV3Code(
        bytes calldata raw,
        TbcBoundedTransaction.OutputView memory output
    ) private pure returns (bool) {
        if (
            keccak256(
                raw[output.scriptOffset:output.scriptOffset + FT_V3_CONTROLLER_OFFSET]
            ) != FT_V3_CODE_PREFIX_HASH
        ) return false;
        bytes32 suffixHash = keccak256(
            raw[
                output.scriptOffset + FT_V3_CONTROLLER_OFFSET + 20:
                    output.scriptOffset + FT_V3_CODE_BYTES
            ]
        );
        return suffixHash == FT_V3_ADDRESS_SUFFIX_HASH
            || suffixHash == FT_V3_CONTRACT_SUFFIX_HASH;
    }

    function _verifyFullOutput(
        bytes calldata witnessRaw,
        bytes calldata transactionRaw,
        TbcBoundedTransaction.OutputView memory output,
        uint256 cursor,
        uint256 end,
        uint256 vin
    ) private pure returns (uint256) {
        cursor = _consumePush(witnessRaw, cursor, end, 8, vin, type(uint256).max);
        if (_readUint64LE(witnessRaw, cursor) != output.satoshis) {
            revert InvalidCurrentTxdata(vin);
        }
        cursor += 8;
        cursor = _consumePush(
            witnessRaw, cursor, end, output.scriptLength, vin, type(uint256).max
        );
        if (
            keccak256(witnessRaw[cursor:cursor + output.scriptLength])
                != keccak256(
                    transactionRaw[output.scriptOffset:output.scriptOffset + output.scriptLength]
                )
        ) revert InvalidCurrentTxdata(vin);
        return cursor + output.scriptLength;
    }

    function _verifyOutputCommitments(
        bytes calldata witnessRaw,
        bytes calldata transactionRaw,
        TbcBoundedTransaction.TransactionView memory transaction,
        uint256 first,
        uint256 limit,
        PrefixCursor memory prefix,
        uint256 slot
    ) private pure returns (uint256) {
        uint256 count = limit - first;
        uint256 cursor = _consumePush(
            witnessRaw, prefix.cursor, prefix.end, count * 40, prefix.vin, slot
        );
        for (uint256 index = first; index < limit; ++index) {
            TbcBoundedTransaction.OutputView memory output = transaction.outputs[index];
            if (
                _readUint64LE(witnessRaw, cursor) != output.satoshis
                    || _readBytes32(witnessRaw, cursor + 8)
                        != sha256(
                            transactionRaw[
                                output.scriptOffset:output.scriptOffset + output.scriptLength
                            ]
                        )
            ) revert InvalidPrePreTxdata(prefix.vin, slot);
            cursor += 40;
        }
        return cursor;
    }

    function _inputCommitment(TbcBoundedTransaction.TransactionView memory transaction)
        private
        pure
        returns (bytes32)
    {
        bytes memory encoded = new bytes(uint256(transaction.inputCount) * 40);
        for (uint256 index; index < transaction.inputCount; ++index) {
            TbcBoundedTransaction.InputView memory input = transaction.inputs[index];
            _writeReversedBytes32(encoded, index * 40, input.previousTxid);
            _writeUint32LE(encoded, index * 40 + 32, input.outputIndex);
            _writeUint32LE(encoded, index * 40 + 36, input.sequence);
        }
        return sha256(encoded);
    }

    function _inputScriptCommitment(
        bytes calldata raw,
        TbcBoundedTransaction.TransactionView memory transaction
    ) private pure returns (bytes32) {
        bytes memory hashes = new bytes(uint256(transaction.inputCount) * 32);
        for (uint256 index; index < transaction.inputCount; ++index) {
            TbcBoundedTransaction.InputView memory input = transaction.inputs[index];
            bytes32 scriptHash = sha256(raw[input.scriptOffset:input.scriptOffset + input.scriptLength]);
            assembly ("memory-safe") {
                mstore(add(add(hashes, 32), mul(index, 32)), scriptHash)
            }
        }
        return sha256(hashes);
    }

    function _consumePush(
        bytes calldata raw,
        uint256 cursor,
        uint256 end,
        uint256 length,
        uint256 vin,
        uint256 slot
    ) private pure returns (uint256) {
        uint256 prefixLength = length < 76 ? 1 : length < 256 ? 2 : 3;
        if (cursor > end || prefixLength + length > end - cursor) _invalid(vin, slot);
        if (length < 76) {
            if (uint8(raw[cursor]) != length) _invalid(vin, slot);
        } else if (length < 256) {
            if (uint8(raw[cursor]) != 0x4c || uint8(raw[cursor + 1]) != length) {
                _invalid(vin, slot);
            }
        } else if (
            uint8(raw[cursor]) != 0x4d || uint8(raw[cursor + 1]) != uint8(length)
                || uint8(raw[cursor + 2]) != uint8(length >> 8)
        ) _invalid(vin, slot);
        return cursor + prefixLength;
    }

    function _invalid(uint256 vin, uint256 slot) private pure {
        if (slot == type(uint256).max) revert InvalidCurrentTxdata(vin);
        revert InvalidPrePreTxdata(vin, slot);
    }

    function _readBytes32(bytes calldata value, uint256 offset)
        private
        pure
        returns (bytes32 result)
    {
        assembly ("memory-safe") {
            result := calldataload(add(value.offset, offset))
        }
    }

    function _readUint32LE(bytes calldata value, uint256 offset)
        private
        pure
        returns (uint32 result)
    {
        result = uint32(uint8(value[offset]))
            | (uint32(uint8(value[offset + 1])) << 8)
            | (uint32(uint8(value[offset + 2])) << 16)
            | (uint32(uint8(value[offset + 3])) << 24);
    }

    function _readUint64LE(bytes calldata value, uint256 offset)
        private
        pure
        returns (uint64 result)
    {
        for (uint256 index; index < 8; ++index) {
            result |= uint64(uint8(value[offset + index])) << uint64(8 * index);
        }
    }

    function _writeReversedBytes32(bytes memory destination, uint256 offset, bytes32 value)
        private
        pure
    {
        uint256 source = uint256(value);
        for (uint256 index; index < 32; ++index) {
            destination[offset + index] = bytes1(uint8(source));
            source >>= 8;
        }
    }

    function _writeUint32LE(bytes memory destination, uint256 offset, uint32 value)
        private
        pure
    {
        destination[offset] = bytes1(uint8(value));
        destination[offset + 1] = bytes1(uint8(value >> 8));
        destination[offset + 2] = bytes1(uint8(value >> 16));
        destination[offset + 3] = bytes1(uint8(value >> 24));
    }
}
