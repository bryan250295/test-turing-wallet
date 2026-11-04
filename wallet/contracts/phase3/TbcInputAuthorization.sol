// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcProofVerifier} from "./TbcProofVerifier.sol";
import {TbcBoundedTransaction} from "./TbcBoundedTransaction.sol";
import {TbcBridgeDepositVerifier} from "./TbcBridgeDepositVerifier.sol";

/// @notice Bounded ALL|FORKID ECDSA authorization for the Phase 3D route.
/// @dev This verifies the exact signature/public-key pair committed inside each
///      input script, its owner hash and its BIP143-style TBC sighash. It is not
///      a general TBC Script interpreter and does not claim the remaining FT
///      Covenant stack program succeeded.
library TbcInputAuthorization {
    uint256 internal constant SECP256K1_N =
        0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    uint256 internal constant SECP256K1_HALF_N =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint256 internal constant FT_V3_CONTROLLER_OFFSET = 1_857;
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
        bool exactP2pkhUnlock;
    }

    error SignatureWitnessCountMismatch(uint256 supplied, uint256 expected);
    error InvalidSignatureLocation(uint256 vin);
    error InvalidSignatureEncoding(uint256 vin);
    error UnsupportedSignatureHashType(uint256 vin, uint8 supplied);
    error InvalidPublicKey(uint256 vin);
    error InputOwnerMismatch(uint256 vin, bytes20 supplied, bytes20 expected);
    error InvalidInputSignature(uint256 vin);

    function verifyAuthorizedTransition(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        bytes[][] calldata ancestorTransactions,
        SignatureWitness[] calldata signatureWitnesses,
        address expectedGateway,
        bytes20 expectedReserveController
    ) internal pure returns (TbcBridgeDepositVerifier.VerifiedTransition memory result) {
        result = TbcBridgeDepositVerifier.verifyAuthenticatedTransition(
            rawTransaction,
            parentTransactions,
            ancestorTransactions,
            expectedGateway,
            expectedReserveController
        );
        TbcBoundedTransaction.TransactionView memory transaction =
            TbcBoundedTransaction.inspect(rawTransaction);
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
        TbcBoundedTransaction.TransactionView memory parent =
            TbcBoundedTransaction.inspectParent(parentTransaction);
        TbcBoundedTransaction.OutputView memory sourceOutput =
            parent.outputs[transaction.inputs[vin].outputIndex];
        AuthorizationTarget memory target = AuthorizationTarget({
            sourceOutput: sourceOutput,
            owner: _readBytes20(
                parentTransaction,
                sourceOutput.scriptOffset + (nativeInput ? 3 : FT_V3_CONTROLLER_OFFSET)
            ),
            exactP2pkhUnlock: nativeInput
        });
        _verifyInputSignature(
            rawTransaction,
            transaction,
            vin,
            parentTransaction,
            target,
            witness
        );
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
        SignatureWitness calldata witness
    ) private pure {
        TbcBoundedTransaction.InputView memory input = transaction.inputs[vin];
        LocatedSignature memory located = _locateSignature(
            rawTransaction,
            input,
            witness.signaturePushOffset,
            target.exactP2pkhUnlock,
            vin
        );
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
