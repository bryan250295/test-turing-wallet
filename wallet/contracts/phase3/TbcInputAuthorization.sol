// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcProofVerifier} from "./TbcProofVerifier.sol";
import {TbcBoundedTransaction} from "./TbcBoundedTransaction.sol";
import {TbcBridgeDepositVerifier} from "./TbcBridgeDepositVerifier.sol";

/// @notice Bounded ALL|FORKID ECDSA authorization for the Phase 3D route.
/// @dev This verifies the exact signature/public-key pair committed inside each
///      input script, its owner hash and its BIP143-style TBC sighash. For FT
///      inputs it also requires the exact legacy-v3 SDK parent witness after the
///      public key, including canonical pushes, parent header/input commitments,
///      Code partial hash, Tape and surrounding output hashes. It is not a
///      general TBC Script interpreter and does not claim the remaining FT
///      Covenant stack program succeeded.
library TbcInputAuthorization {
    uint256 internal constant SECP256K1_N =
        0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    uint256 internal constant SECP256K1_HALF_N =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint256 internal constant FT_V3_CONTROLLER_OFFSET = 1_857;
    uint256 internal constant FT_V3_PARTIAL_OFFSET = 1_856;
    uint256 internal constant FT_V3_CODE_BYTES = 1_884;
    uint256 internal constant FT_V3_TAPE_BYTES = 73;
    bytes32 internal constant FT_V3_CODE_PARTIAL_HASH =
        0x197cfcf91f9a14217df24cf36f567b8d0ff784a638d4d9b7c2add2d888687f9b;
    uint8 internal constant SIGHASH_ALL_FORKID = 0x41;

    struct SignatureWitness {
        uint32 signaturePushOffset;
        bytes32 publicKeyX;
        bytes32 publicKeyY;
    }

    struct SighashParts {
        bytes32 prevouts;
        bytes32 sequences;
        bytes32 outputs;
    }

    struct LocatedSignature {
        uint256 offset;
        uint256 length;
        uint256 publicKeyOffset;
    }

    struct AuthorizationTarget {
        TbcBoundedTransaction.OutputView sourceOutput;
        bytes20 owner;
    }

    error SignatureWitnessCountMismatch(uint256 supplied, uint256 expected);
    error InvalidSignatureLocation(uint256 vin);
    error InvalidSignatureEncoding(uint256 vin);
    error UnsupportedSignatureHashType(uint256 vin, uint8 supplied);
    error InvalidPublicKey(uint256 vin);
    error InputOwnerMismatch(uint256 vin, bytes20 supplied, bytes20 expected);
    error InvalidInputSignature(uint256 vin);
    error InvalidFtWitnessLayout(uint256 vin);

    function verifyAuthorizedTransition(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        bytes[][] calldata ancestorTransactions,
        SignatureWitness[] calldata signatureWitnesses,
        address expectedGateway,
        bytes20 expectedReserveController
    ) internal pure returns (TbcBridgeDepositVerifier.VerifiedTransition memory result) {
        TbcBoundedTransaction.TransactionView memory transaction;
        (result, transaction) = TbcBridgeDepositVerifier.verifyAuthenticatedTransitionWithView(
            rawTransaction,
            parentTransactions,
            ancestorTransactions,
            expectedGateway,
            expectedReserveController
        );
        if (signatureWitnesses.length != transaction.inputCount) {
            revert SignatureWitnessCountMismatch(
                signatureWitnesses.length, transaction.inputCount
            );
        }
        uint256 nativeVin = transaction.inputCount - 1;
        for (uint256 vin; vin < transaction.inputCount; ++vin) {
            _verifyVin(
                rawTransaction,
                transaction,
                parentTransactions[vin],
                signatureWitnesses[vin],
                vin,
                vin == nativeVin
            );
        }
    }

    function _verifyVin(
        bytes calldata rawTransaction,
        TbcBoundedTransaction.TransactionView memory transaction,
        bytes calldata parentTransaction,
        SignatureWitness calldata witness,
        uint256 vin,
        bool nativeInput
    ) private pure {
        (AuthorizationTarget memory target, LocatedSignature memory located) =
            _authorizationContext(
                rawTransaction,
                transaction,
                parentTransaction,
                witness,
                vin,
                nativeInput
            );
        _verifyInputSignature(
            rawTransaction,
            transaction,
            vin,
            parentTransaction,
            target,
            witness,
            located
        );
    }

    function _authorizationContext(
        bytes calldata rawTransaction,
        TbcBoundedTransaction.TransactionView memory transaction,
        bytes calldata parentTransaction,
        SignatureWitness calldata witness,
        uint256 vin,
        bool nativeInput
    ) private pure returns (
        AuthorizationTarget memory target,
        LocatedSignature memory located
    ) {
        TbcBoundedTransaction.TransactionView memory parent =
            TbcBoundedTransaction.inspectParent(parentTransaction);
        uint32 parentVout = transaction.inputs[vin].outputIndex;
        TbcBoundedTransaction.InputView memory input = transaction.inputs[vin];
        located = _locateSignature(
            rawTransaction,
            input,
            witness.signaturePushOffset,
            nativeInput,
            vin
        );
        if (!nativeInput) {
            _verifyFtParentWitness(
                rawTransaction,
                input,
                parentTransaction,
                parent,
                parentVout,
                located.publicKeyOffset + 33,
                vin
            );
        }
        TbcBoundedTransaction.OutputView memory sourceOutput = parent.outputs[parentVout];
        target = AuthorizationTarget({
            sourceOutput: sourceOutput,
            owner: _readBytes20(
                parentTransaction,
                sourceOutput.scriptOffset + (nativeInput ? 3 : FT_V3_CONTROLLER_OFFSET)
            )
        });
    }

    function signatureDigest(
        bytes calldata rawTransaction,
        bytes calldata parentTransaction,
        uint256 vin
    ) internal pure returns (bytes32) {
        TbcBoundedTransaction.TransactionView memory transaction =
            TbcBoundedTransaction.inspect(rawTransaction);
        if (vin >= transaction.inputCount) revert InvalidSignatureLocation(vin);
        TbcBoundedTransaction.TransactionView memory parent =
            TbcBoundedTransaction.inspectParent(parentTransaction);
        uint32 vout = transaction.inputs[vin].outputIndex;
        if (vout >= parent.outputCount) revert InvalidSignatureLocation(vin);
        return _sighashAllForkId(rawTransaction, transaction, vin, parentTransaction, parent.outputs[vout]);
    }

    function _verifyInputSignature(
        bytes calldata rawTransaction,
        TbcBoundedTransaction.TransactionView memory transaction,
        uint256 vin,
        bytes calldata parentTransaction,
        AuthorizationTarget memory target,
        SignatureWitness calldata witness,
        LocatedSignature memory located
    ) private pure {
        address expectedPublicKey = _verifyPublicKey(
            rawTransaction, located.publicKeyOffset, witness, target.owner, vin
        );
        (bytes32 r, bytes32 s) = _parseSignature(
            rawTransaction, located.offset, located.length, vin
        );
        bytes32 digest = _sighashAllForkId(
            rawTransaction, transaction, vin, parentTransaction, target.sourceOutput
        );
        address recovered27 = ecrecover(digest, 27, r, s);
        address recovered28 = ecrecover(digest, 28, r, s);
        if (recovered27 != expectedPublicKey && recovered28 != expectedPublicKey) {
            revert InvalidInputSignature(vin);
        }
    }

    /// @dev `FT.getFTunlock(..., false)` places getPreTxdata(parent, vout)
    ///      immediately after the compressed public key and nowhere else. By
    ///      consuming that complete encoding to the input-script boundary this
    ///      also rejects the stable-coin `isCoin` flag and trailing stack data.
    function _verifyFtParentWitness(
        bytes calldata rawTransaction,
        TbcBoundedTransaction.InputView memory input,
        bytes calldata parentTransaction,
        TbcBoundedTransaction.TransactionView memory parent,
        uint32 parentVout,
        uint256 cursor,
        uint256 vin
    ) private pure {
        uint256 end = uint256(input.scriptOffset) + input.scriptLength;
        if (cursor >= end || parentVout + 1 >= parent.outputCount) {
            revert InvalidFtWitnessLayout(vin);
        }

        cursor = _consumePush(rawTransaction, cursor, end, 16, vin);
        if (
            _readUint32LE(rawTransaction, cursor) != 10
                || _readUint32LE(rawTransaction, cursor + 4)
                    != _readUint32LE(parentTransaction, parentTransaction.length - 4)
                || _readUint32LE(rawTransaction, cursor + 8) != parent.inputCount
                || _readUint32LE(rawTransaction, cursor + 12) != parent.outputCount
        ) revert InvalidFtWitnessLayout(vin);
        cursor += 16;

        uint256 inputDataLength = uint256(parent.inputCount) * 40;
        cursor = _consumePush(rawTransaction, cursor, end, inputDataLength, vin);
        for (uint256 index; index < parent.inputCount; ++index) {
            TbcBoundedTransaction.InputView memory parentInput = parent.inputs[index];
            if (
                _readBytes32(rawTransaction, cursor)
                    != TbcProofVerifier.reverseBytes32(parentInput.previousTxid)
                    || _readUint32LE(rawTransaction, cursor + 32) != parentInput.outputIndex
                    || _readUint32LE(rawTransaction, cursor + 36) != parentInput.sequence
            ) revert InvalidFtWitnessLayout(vin);
            cursor += 40;
        }

        cursor = _consumePush(rawTransaction, cursor, end, 32, vin);
        if (_readBytes32(rawTransaction, cursor) != _parentScriptHashes(parentTransaction, parent)) {
            revert InvalidFtWitnessLayout(vin);
        }
        cursor += 32;

        cursor = _verifyOutputCommitments(
            rawTransaction, cursor, end, parentTransaction, parent, 0, parentVout, vin
        );
        cursor = _verifyCodeTapeAndTrailingOutputs(
            rawTransaction, cursor, end, parentTransaction, parent, parentVout, vin
        );
        if (cursor != end) revert InvalidFtWitnessLayout(vin);
    }

    function _verifyCodeTapeAndTrailingOutputs(
        bytes calldata rawTransaction,
        uint256 cursor,
        uint256 end,
        bytes calldata parentTransaction,
        TbcBoundedTransaction.TransactionView memory parent,
        uint32 parentVout,
        uint256 vin
    ) private pure returns (uint256) {
        TbcBoundedTransaction.OutputView memory code = parent.outputs[parentVout];
        cursor = _consumePush(rawTransaction, cursor, end, 8, vin);
        if (_readUint64LE(rawTransaction, cursor) != code.satoshis) {
            revert InvalidFtWitnessLayout(vin);
        }
        cursor += 8;
        cursor = _consumePush(
            rawTransaction, cursor, end, FT_V3_CODE_BYTES - FT_V3_PARTIAL_OFFSET, vin
        );
        if (
            keccak256(rawTransaction[cursor:cursor + FT_V3_CODE_BYTES - FT_V3_PARTIAL_OFFSET])
                != keccak256(
                    parentTransaction[
                        code.scriptOffset + FT_V3_PARTIAL_OFFSET:
                            code.scriptOffset + FT_V3_CODE_BYTES
                    ]
                )
        ) revert InvalidFtWitnessLayout(vin);
        cursor += FT_V3_CODE_BYTES - FT_V3_PARTIAL_OFFSET;
        cursor = _consumePush(rawTransaction, cursor, end, 32, vin);
        if (_readBytes32(rawTransaction, cursor) != FT_V3_CODE_PARTIAL_HASH) {
            revert InvalidFtWitnessLayout(vin);
        }
        cursor += 32;
        cursor = _consumePush(rawTransaction, cursor, end, 2, vin);
        if (uint8(rawTransaction[cursor]) != 0x5c || uint8(rawTransaction[cursor + 1]) != 0x07) {
            revert InvalidFtWitnessLayout(vin);
        }
        cursor += 2;

        TbcBoundedTransaction.OutputView memory tape = parent.outputs[parentVout + 1];
        cursor = _consumePush(rawTransaction, cursor, end, 8, vin);
        if (_readUint64LE(rawTransaction, cursor) != tape.satoshis) {
            revert InvalidFtWitnessLayout(vin);
        }
        cursor += 8;
        cursor = _consumePush(rawTransaction, cursor, end, FT_V3_TAPE_BYTES, vin);
        if (
            keccak256(rawTransaction[cursor:cursor + FT_V3_TAPE_BYTES])
                != keccak256(
                    parentTransaction[tape.scriptOffset:tape.scriptOffset + FT_V3_TAPE_BYTES]
                )
        ) revert InvalidFtWitnessLayout(vin);
        cursor += FT_V3_TAPE_BYTES;

        return _verifyOutputCommitments(
            rawTransaction,
            cursor,
            end,
            parentTransaction,
            parent,
            parentVout + 2,
            parent.outputCount,
            vin
        );
    }

    function _verifyOutputCommitments(
        bytes calldata rawTransaction,
        uint256 cursor,
        uint256 end,
        bytes calldata parentTransaction,
        TbcBoundedTransaction.TransactionView memory parent,
        uint256 first,
        uint256 limit,
        uint256 vin
    ) private pure returns (uint256) {
        uint256 count = limit - first;
        if (count == 0) {
            return _consumePush(rawTransaction, cursor, end, 0, vin);
        }
        cursor = _consumePush(rawTransaction, cursor, end, count * 40, vin);
        for (uint256 index = first; index < limit; ++index) {
            TbcBoundedTransaction.OutputView memory output = parent.outputs[index];
            if (
                _readUint64LE(rawTransaction, cursor) != output.satoshis
                    || _readBytes32(rawTransaction, cursor + 8)
                        != sha256(
                            parentTransaction[
                                output.scriptOffset:output.scriptOffset + output.scriptLength
                            ]
                        )
            ) revert InvalidFtWitnessLayout(vin);
            cursor += 40;
        }
        return cursor;
    }

    function _parentScriptHashes(
        bytes calldata parentTransaction,
        TbcBoundedTransaction.TransactionView memory parent
    ) private pure returns (bytes32) {
        bytes memory hashes = new bytes(uint256(parent.inputCount) * 32);
        for (uint256 index; index < parent.inputCount; ++index) {
            TbcBoundedTransaction.InputView memory input = parent.inputs[index];
            bytes32 scriptHash = sha256(
                parentTransaction[input.scriptOffset:input.scriptOffset + input.scriptLength]
            );
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
        uint256 vin
    ) private pure returns (uint256 dataOffset) {
        uint256 prefixLength = length < 76 ? 1 : length < 256 ? 2 : 3;
        if (cursor > end || prefixLength + length > end - cursor) {
            revert InvalidFtWitnessLayout(vin);
        }
        if (length < 76) {
            if (uint8(raw[cursor]) != length) revert InvalidFtWitnessLayout(vin);
        } else if (length < 256) {
            if (uint8(raw[cursor]) != 0x4c || uint8(raw[cursor + 1]) != length) {
                revert InvalidFtWitnessLayout(vin);
            }
        } else if (
            uint8(raw[cursor]) != 0x4d || uint8(raw[cursor + 1]) != uint8(length)
                || uint8(raw[cursor + 2]) != uint8(length >> 8)
        ) revert InvalidFtWitnessLayout(vin);
        return cursor + prefixLength;
    }

    function _locateSignature(
        bytes calldata rawTransaction,
        TbcBoundedTransaction.InputView memory input,
        uint32 signaturePushOffset,
        bool exactP2pkhUnlock,
        uint256 vin
    ) private pure returns (LocatedSignature memory located) {
        uint256 relative = signaturePushOffset;
        if (relative >= input.scriptLength) revert InvalidSignatureLocation(vin);
        uint256 pushOffset = input.scriptOffset + relative;
        uint256 signatureLength = uint8(rawTransaction[pushOffset]);
        uint256 pairLength = 1 + signatureLength + 1 + 33;
        if (
            signatureLength < 9 || signatureLength > 73
                || relative + pairLength > input.scriptLength
                || uint8(rawTransaction[pushOffset + 1 + signatureLength]) != 33
                || (exactP2pkhUnlock && (relative != 0 || pairLength != input.scriptLength))
        ) revert InvalidSignatureLocation(vin);
        located = LocatedSignature({
            offset: pushOffset + 1,
            length: signatureLength,
            publicKeyOffset: pushOffset + 1 + signatureLength + 1
        });
    }

    function _verifyPublicKey(
        bytes calldata rawTransaction,
        uint256 publicKeyOffset,
        SignatureWitness calldata witness,
        bytes20 expectedOwner,
        uint256 vin
    ) private pure returns (address expectedPublicKey) {
        uint8 publicKeyPrefix = uint8(rawTransaction[publicKeyOffset]);
        if (
            (publicKeyPrefix != 2 && publicKeyPrefix != 3)
                || _readBytes32(rawTransaction, publicKeyOffset + 1) != witness.publicKeyX
                || uint8(uint256(witness.publicKeyY)) & 1 != publicKeyPrefix - 2
        ) revert InvalidPublicKey(vin);

        bytes20 suppliedOwner = ripemd160(
            abi.encodePacked(sha256(rawTransaction[publicKeyOffset:publicKeyOffset + 33]))
        );
        if (suppliedOwner != expectedOwner) {
            revert InputOwnerMismatch(vin, suppliedOwner, expectedOwner);
        }
        expectedPublicKey = address(uint160(uint256(keccak256(
            abi.encodePacked(witness.publicKeyX, witness.publicKeyY)
        ))));
        if (expectedPublicKey == address(0)) revert InvalidPublicKey(vin);
    }

    function _parseSignature(
        bytes calldata raw,
        uint256 offset,
        uint256 length,
        uint256 vin
    ) private pure returns (bytes32 r, bytes32 s) {
        uint8 hashType = uint8(raw[offset + length - 1]);
        if (hashType != SIGHASH_ALL_FORKID) {
            revert UnsupportedSignatureHashType(vin, hashType);
        }
        if (
            uint8(raw[offset]) != 0x30 || uint8(raw[offset + 1]) != length - 3
                || uint8(raw[offset + 2]) != 0x02
        ) revert InvalidSignatureEncoding(vin);
        uint256 rLength = uint8(raw[offset + 3]);
        if (rLength == 0 || rLength > 33 || 5 + rLength >= length) {
            revert InvalidSignatureEncoding(vin);
        }
        uint256 sTagOffset = offset + 4 + rLength;
        if (uint8(raw[sTagOffset]) != 0x02) revert InvalidSignatureEncoding(vin);
        uint256 sLength = uint8(raw[sTagOffset + 1]);
        if (sLength == 0 || sLength > 33 || rLength + sLength + 7 != length) {
            revert InvalidSignatureEncoding(vin);
        }
        uint256 rOffset = offset + 4;
        uint256 sOffset = sTagOffset + 2;
        if (!_canonicalInteger(raw, rOffset, rLength) || !_canonicalInteger(raw, sOffset, sLength)) {
            revert InvalidSignatureEncoding(vin);
        }
        uint256 rValue = _readUnsignedInteger(raw, rOffset, rLength);
        uint256 sValue = _readUnsignedInteger(raw, sOffset, sLength);
        if (
            rValue == 0 || rValue >= SECP256K1_N
                || sValue == 0 || sValue > SECP256K1_HALF_N
        ) revert InvalidSignatureEncoding(vin);
        r = bytes32(rValue);
        s = bytes32(sValue);
    }

    function _canonicalInteger(bytes calldata raw, uint256 offset, uint256 length)
        private
        pure
        returns (bool)
    {
        uint8 first = uint8(raw[offset]);
        if ((first & 0x80) != 0) return false;
        return length <= 1 || first != 0 || (uint8(raw[offset + 1]) & 0x80) != 0;
    }

    function _readUnsignedInteger(bytes calldata raw, uint256 offset, uint256 length)
        private
        pure
        returns (uint256 result)
    {
        if (length == 33) {
            ++offset;
            --length;
        }
        for (uint256 index; index < length; ++index) {
            result = (result << 8) | uint8(raw[offset + index]);
        }
    }

    function _sighashAllForkId(
        bytes calldata rawTransaction,
        TbcBoundedTransaction.TransactionView memory transaction,
        uint256 vin,
        bytes calldata parentTransaction,
        TbcBoundedTransaction.OutputView memory sourceOutput
    ) private pure returns (bytes32) {
        SighashParts memory parts = SighashParts({
            prevouts: _hashPrevouts(transaction),
            sequences: _hashSequences(transaction),
            outputs: _hashOutputs(rawTransaction, transaction)
        });
        bytes memory preimage = new bytes(
            156 + _compactSizeLength(sourceOutput.scriptLength) + sourceOutput.scriptLength
        );
        uint256 cursor = _writeSighashPrefix(preimage, transaction, vin, parts);
        cursor = _writeSighashSource(
            preimage, cursor, parentTransaction, sourceOutput, transaction.inputs[vin].sequence
        );
        _writeSighashSuffix(preimage, cursor, rawTransaction, parts.outputs);
        return TbcProofVerifier.doubleSha256(preimage);
    }

    function _writeSighashPrefix(
        bytes memory preimage,
        TbcBoundedTransaction.TransactionView memory transaction,
        uint256 vin,
        SighashParts memory parts
    ) private pure returns (uint256 cursor) {
        _writeUint32LE(preimage, cursor, 10);
        cursor += 4;
        _writeBytes32(preimage, cursor, parts.prevouts);
        cursor += 32;
        _writeBytes32(preimage, cursor, parts.sequences);
        cursor += 32;
        _writeReversedBytes32(preimage, cursor, transaction.inputs[vin].previousTxid);
        cursor += 32;
        _writeUint32LE(preimage, cursor, transaction.inputs[vin].outputIndex);
        cursor += 4;
    }

    function _writeSighashSource(
        bytes memory preimage,
        uint256 cursor,
        bytes calldata parentTransaction,
        TbcBoundedTransaction.OutputView memory sourceOutput,
        uint32 sequence
    ) private pure returns (uint256) {
        cursor = _writeCompactSize(preimage, cursor, sourceOutput.scriptLength);
        _copyCalldata(
            parentTransaction,
            sourceOutput.scriptOffset,
            preimage,
            cursor,
            sourceOutput.scriptLength
        );
        cursor += sourceOutput.scriptLength;
        _writeUint64LE(preimage, cursor, sourceOutput.satoshis);
        cursor += 8;
        _writeUint32LE(preimage, cursor, sequence);
        return cursor + 4;
    }

    function _writeSighashSuffix(
        bytes memory preimage,
        uint256 cursor,
        bytes calldata rawTransaction,
        bytes32 hashOutputs
    ) private pure {
        _writeBytes32(preimage, cursor, hashOutputs);
        cursor += 32;
        _copyCalldata(rawTransaction, rawTransaction.length - 4, preimage, cursor, 4);
        cursor += 4;
        _writeUint32LE(preimage, cursor, SIGHASH_ALL_FORKID);
    }

    function _hashPrevouts(TbcBoundedTransaction.TransactionView memory transaction)
        private
        pure
        returns (bytes32)
    {
        bytes memory encoded = new bytes(uint256(transaction.inputCount) * 36);
        for (uint256 index; index < transaction.inputCount; ++index) {
            uint256 offset = index * 36;
            _writeReversedBytes32(encoded, offset, transaction.inputs[index].previousTxid);
            _writeUint32LE(encoded, offset + 32, transaction.inputs[index].outputIndex);
        }
        return TbcProofVerifier.doubleSha256(encoded);
    }

    function _hashSequences(TbcBoundedTransaction.TransactionView memory transaction)
        private
        pure
        returns (bytes32)
    {
        bytes memory encoded = new bytes(uint256(transaction.inputCount) * 4);
        for (uint256 index; index < transaction.inputCount; ++index) {
            _writeUint32LE(encoded, index * 4, transaction.inputs[index].sequence);
        }
        return TbcProofVerifier.doubleSha256(encoded);
    }

    function _hashOutputs(
        bytes calldata raw,
        TbcBoundedTransaction.TransactionView memory transaction
    ) private pure returns (bytes32) {
        uint256 length;
        for (uint256 index; index < transaction.outputCount; ++index) {
            length += 8 + _compactSizeLength(transaction.outputs[index].scriptLength)
                + transaction.outputs[index].scriptLength;
        }
        bytes memory encoded = new bytes(length);
        uint256 cursor;
        for (uint256 index; index < transaction.outputCount; ++index) {
            TbcBoundedTransaction.OutputView memory output = transaction.outputs[index];
            _writeUint64LE(encoded, cursor, output.satoshis);
            cursor += 8;
            cursor = _writeCompactSize(encoded, cursor, output.scriptLength);
            _copyCalldata(raw, output.scriptOffset, encoded, cursor, output.scriptLength);
            cursor += output.scriptLength;
        }
        return TbcProofVerifier.doubleSha256(encoded);
    }

    function _compactSizeLength(uint256 value) private pure returns (uint256) {
        if (value < 0xfd) return 1;
        if (value <= type(uint16).max) return 3;
        return 5;
    }

    function _writeCompactSize(bytes memory destination, uint256 offset, uint256 value)
        private
        pure
        returns (uint256)
    {
        if (value < 0xfd) {
            destination[offset] = bytes1(uint8(value));
            return offset + 1;
        }
        if (value <= type(uint16).max) {
            destination[offset] = 0xfd;
            destination[offset + 1] = bytes1(uint8(value));
            destination[offset + 2] = bytes1(uint8(value >> 8));
            return offset + 3;
        }
        destination[offset] = 0xfe;
        _writeUint32LE(destination, offset + 1, uint32(value));
        return offset + 5;
    }

    function _readBytes20(bytes calldata value, uint256 offset)
        private
        pure
        returns (bytes20 result)
    {
        result = bytes20(_readBytes32(value, offset));
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

    function _writeBytes32(bytes memory destination, uint256 offset, bytes32 value)
        private
        pure
    {
        assembly ("memory-safe") {
            mstore(add(add(destination, 32), offset), value)
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

    function _writeUint64LE(bytes memory destination, uint256 offset, uint64 value)
        private
        pure
    {
        for (uint256 index; index < 8; ++index) {
            destination[offset + index] = bytes1(uint8(value >> (8 * index)));
        }
    }
}
