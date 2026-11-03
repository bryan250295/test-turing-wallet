// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcProofVerifier} from "./TbcProofVerifier.sol";

/// @notice Canonical parser and TXID calculator for the bounded Phase 2 deposit shape.
/// @dev TBC version 10 is transmitted in the legacy transaction serialization, but
///      its TXID hashes TBC's 112-byte newTxHeader commitment rather than the raw
///      bytes directly. This parser accepts only the frozen bridge bounds; it is
///      not a general TBC transaction library.
library TbcBoundedTransaction {
    uint256 internal constant MAX_RAW_TRANSACTION_BYTES = 131_072;
    uint8 internal constant MIN_INPUTS = 2;
    uint8 internal constant MAX_INPUTS = 7;
    uint8 internal constant MIN_OUTPUTS = 3;
    uint8 internal constant MAX_OUTPUTS = 6;
    uint8 internal constant MAX_PARENT_OUTPUTS = 16;

    struct InputView {
        bytes32 previousTxid;
        uint32 outputIndex;
        uint32 scriptOffset;
        uint32 scriptLength;
        uint32 sequence;
    }

    struct OutputView {
        uint64 satoshis;
        uint32 scriptOffset;
        uint32 scriptLength;
    }

    struct TransactionView {
        bytes32 txid;
        uint8 inputCount;
        uint8 outputCount;
        InputView[7] inputs;
        OutputView[16] outputs;
    }

    struct TxidParts {
        bytes inputOutpointsAndSequences;
        bytes inputScriptHashes;
        bytes outputValuesAndScriptHashes;
    }

    error RawTransactionTooLarge(uint256 actual, uint256 maximum);
    error TruncatedTransaction(uint256 offset, uint256 required, uint256 actual);
    error UnsupportedTransactionVersion(uint32 supplied);
    error NonCanonicalCompactSize(uint256 offset);
    error CompactSizeTooLarge(uint256 offset);
    error InputCountOutOfRange(uint256 supplied);
    error OutputCountOutOfRange(uint256 supplied);
    error TrailingTransactionBytes(uint256 parsed, uint256 actual);

    function inspect(bytes calldata rawTransaction)
        internal
        pure
        returns (TransactionView memory parsed)
    {
        return _inspect(rawTransaction, false);
    }

    /// @notice Parse a supplied input parent under the narrower on-chain route bounds.
    function inspectParent(bytes calldata rawTransaction)
        internal
        pure
        returns (TransactionView memory parsed)
    {
        return _inspect(rawTransaction, true);
    }

    function _inspect(bytes calldata rawTransaction, bool parent)
        private
        pure
        returns (TransactionView memory parsed)
    {
        if (rawTransaction.length > MAX_RAW_TRANSACTION_BYTES) {
            revert RawTransactionTooLarge(rawTransaction.length, MAX_RAW_TRANSACTION_BYTES);
        }
        _requireAvailable(rawTransaction, 0, 4);
        uint32 version = _readUint32LE(rawTransaction, 0);
        if (version != 10) revert UnsupportedTransactionVersion(version);

        uint256 cursor = 4;
        uint256 count;
        (count, cursor) = _readCompactSize(rawTransaction, cursor);
        if (count < (parent ? 1 : MIN_INPUTS) || count > MAX_INPUTS) {
            revert InputCountOutOfRange(count);
        }
        parsed.inputCount = uint8(count);
        TxidParts memory parts;
        parts.inputOutpointsAndSequences = new bytes(count * 40);
        parts.inputScriptHashes = new bytes(count * 32);
        cursor = _parseInputs(
            rawTransaction,
            cursor,
            count,
            parsed,
            parts
        );

        (count, cursor) = _readCompactSize(rawTransaction, cursor);
        if (
            count < (parent ? 1 : MIN_OUTPUTS)
                || count > (parent ? MAX_PARENT_OUTPUTS : MAX_OUTPUTS)
        ) {
            revert OutputCountOutOfRange(count);
        }
        parsed.outputCount = uint8(count);
        parts.outputValuesAndScriptHashes = new bytes(count * 40);
        cursor = _parseOutputs(
            rawTransaction, cursor, count, parsed, parts.outputValuesAndScriptHashes
        );

        uint256 lockTimeOffset = cursor;
        _requireAvailable(rawTransaction, cursor, 4);
        cursor += 4;
        if (cursor != rawTransaction.length) {
            revert TrailingTransactionBytes(cursor, rawTransaction.length);
        }
        parsed.txid = _version10Txid(
            rawTransaction,
            lockTimeOffset,
            parsed.inputCount,
            parsed.outputCount,
            parts
        );
    }

    function _parseInputs(
        bytes calldata rawTransaction,
        uint256 cursor,
        uint256 count,
        TransactionView memory parsed,
        TxidParts memory parts
    ) private pure returns (uint256) {
        for (uint256 inputIndex; inputIndex < count; ++inputIndex) {
            _requireAvailable(rawTransaction, cursor, 36);
            InputView memory input;
            input.previousTxid = TbcProofVerifier.reverseBytes32(
                _readBytes32(rawTransaction, cursor)
            );
            input.outputIndex = _readUint32LE(rawTransaction, cursor + 32);
            _copyCalldata(
                rawTransaction,
                cursor,
                parts.inputOutpointsAndSequences,
                inputIndex * 40,
                36
            );
            cursor += 36;
            uint256 scriptLength;
            (scriptLength, cursor) = _readCompactSize(rawTransaction, cursor);
            if (scriptLength > type(uint32).max) revert CompactSizeTooLarge(cursor);
            _requireAvailable(rawTransaction, cursor, scriptLength + 4);
            input.scriptOffset = uint32(cursor);
            input.scriptLength = uint32(scriptLength);
            _writeBytes32(
                parts.inputScriptHashes,
                inputIndex * 32,
                sha256(rawTransaction[cursor:cursor + scriptLength])
            );
            cursor += scriptLength;
            _copyCalldata(
                rawTransaction,
                cursor,
                parts.inputOutpointsAndSequences,
                inputIndex * 40 + 36,
                4
            );
            input.sequence = _readUint32LE(rawTransaction, cursor);
            parsed.inputs[inputIndex] = input;
            cursor += 4;
        }
        return cursor;
    }

    function _parseOutputs(
        bytes calldata rawTransaction,
        uint256 cursor,
        uint256 count,
        TransactionView memory parsed,
        bytes memory valuesAndScriptHashes
    ) private pure returns (uint256) {
        for (uint256 outputIndex; outputIndex < count; ++outputIndex) {
            _requireAvailable(rawTransaction, cursor, 8);
            uint64 satoshis = _readUint64LE(rawTransaction, cursor);
            _copyCalldata(
                rawTransaction,
                cursor,
                valuesAndScriptHashes,
                outputIndex * 40,
                8
            );
            cursor += 8;
            uint256 scriptLength;
            (scriptLength, cursor) = _readCompactSize(rawTransaction, cursor);
            if (scriptLength > type(uint32).max) revert CompactSizeTooLarge(cursor);
            _requireAvailable(rawTransaction, cursor, scriptLength);
            parsed.outputs[outputIndex] = OutputView({
                satoshis: satoshis,
                scriptOffset: uint32(cursor),
                scriptLength: uint32(scriptLength)
            });
            bytes32 scriptHash = sha256(rawTransaction[cursor:cursor + scriptLength]);
            _writeBytes32(valuesAndScriptHashes, outputIndex * 40 + 8, scriptHash);
            cursor += scriptLength;
        }
        return cursor;
    }

    function _version10Txid(
        bytes calldata rawTransaction,
        uint256 lockTimeOffset,
        uint8 inputCount,
        uint8 outputCount,
        TxidParts memory parts
    ) private pure returns (bytes32) {
        bytes memory header = new bytes(112);
        _copyCalldata(rawTransaction, 0, header, 0, 4);
        _copyCalldata(rawTransaction, lockTimeOffset, header, 4, 4);
        _writeUint32LE(header, 8, inputCount);
        _writeUint32LE(header, 12, outputCount);
        _writeBytes32(header, 16, sha256(parts.inputOutpointsAndSequences));
        _writeBytes32(header, 48, sha256(parts.inputScriptHashes));
        _writeBytes32(header, 80, sha256(parts.outputValuesAndScriptHashes));
        return TbcProofVerifier.reverseBytes32(TbcProofVerifier.doubleSha256(header));
    }

    function _readCompactSize(bytes calldata value, uint256 offset)
        private
        pure
        returns (uint256 result, uint256 next)
    {
        _requireAvailable(value, offset, 1);
        uint8 prefix = uint8(value[offset]);
        if (prefix < 0xfd) return (prefix, offset + 1);
        if (prefix == 0xfd) {
            _requireAvailable(value, offset, 3);
            result = uint16(uint8(value[offset + 1]))
                | (uint16(uint8(value[offset + 2])) << 8);
            if (result < 0xfd) revert NonCanonicalCompactSize(offset);
            return (result, offset + 3);
        }
        if (prefix == 0xfe) {
            _requireAvailable(value, offset, 5);
            result = _readUint32LE(value, offset + 1);
            if (result <= type(uint16).max) revert NonCanonicalCompactSize(offset);
            return (result, offset + 5);
        }
        _requireAvailable(value, offset, 9);
        result = _readUint64LE(value, offset + 1);
        if (result <= type(uint32).max) revert NonCanonicalCompactSize(offset);
        return (result, offset + 9);
    }

    function _requireAvailable(bytes calldata value, uint256 offset, uint256 length) private pure {
        if (offset > value.length || length > value.length - offset) {
            revert TruncatedTransaction(offset, length, value.length);
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

    function _readBytes32(bytes calldata value, uint256 offset)
        private
        pure
        returns (bytes32 result)
    {
        assembly ("memory-safe") {
            result := calldataload(add(value.offset, offset))
        }
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

    function _copyCalldata(
        bytes calldata source,
        uint256 sourceOffset,
        bytes memory destination,
        uint256 destinationOffset,
        uint256 length
    ) private pure {
        assembly ("memory-safe") {
            calldatacopy(
                add(add(destination, 32), destinationOffset),
                add(source.offset, sourceOffset),
                length
            )
        }
    }

    function _writeBytes32(bytes memory destination, uint256 offset, bytes32 value) private pure {
        assembly ("memory-safe") {
            mstore(add(add(destination, 32), offset), value)
        }
    }

    function _writeUint32LE(bytes memory destination, uint256 offset, uint32 value) private pure {
        destination[offset] = bytes1(uint8(value));
        destination[offset + 1] = bytes1(uint8(value >> 8));
        destination[offset + 2] = bytes1(uint8(value >> 16));
        destination[offset + 3] = bytes1(uint8(value >> 24));
    }
}
