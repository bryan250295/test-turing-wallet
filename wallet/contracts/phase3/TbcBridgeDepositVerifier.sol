// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcProofVerifier} from "./TbcProofVerifier.sol";
import {TbcBoundedTransaction} from "./TbcBoundedTransaction.sol";

interface ITbcHeaderRelayV2 {
    struct HeaderNode {
        bytes32 parentHash;
        bytes32 merkleRoot;
        bytes32 skipHash;
        uint256 chainWork;
        uint32 height;
        uint32 time;
        uint32 bits;
        bool exists;
    }

    function header(bytes32 blockHash) external view returns (HeaderNode memory);
    function isFinalized(bytes32 blockHash) external view returns (bool);
}

/// @notice Phase 3D verifier for a finalized TBC transaction and its frozen v3
///         Bridge Covenant output envelope.
/// @dev This proves canonical transaction bytes, TXID, Merkle inclusion, Covenant
///      intent and the pinned v3 Code/Tape output encoding. It intentionally does
///      NOT claim to execute the legacy FT input scripts or prove UTXO unspentness.
library TbcBridgeDepositVerifier {
    uint256 internal constant TARGET_CHAIN_ID = 998;
    uint32 internal constant SOURCE_VOUT = 1;
    uint64 internal constant COVENANT_SATOSHIS = 100;
    uint64 internal constant FT_CODE_SATOSHIS = 500;
    uint256 internal constant COVENANT_SCRIPT_BYTES = 291;
    uint256 internal constant FT_V3_CODE_BYTES = 1_884;
    uint256 internal constant FT_V3_CONTROLLER_OFFSET = 1_857;
    uint256 internal constant FT_V3_TAPE_BYTES = 73;

    bytes32 internal constant SOURCE_DOMAIN_HASH =
        0x170fd6ecf53e485cfe0df6a4e3977ae78d3e1fca9ceb05a79c2bca1c79e45c8b;
    bytes32 internal constant DEPOSIT_DOMAIN_HASH =
        0x17a434e20a40ff4ee406974b50f279ce6f08bc91db025396d92f2871bdaaee46;
    bytes32 internal constant SOURCE_CONTRACT_ID =
        0xac54e83d476839a11bbb7d0a2495e50c9d0d23c9283f94e11222bad589259e6c;
    bytes32 internal constant FT_V3_CODE_PREFIX_HASH =
        0x587af8d9c41a35a8dcb830f461f56045a3938897cdc4d1cfb5f0fa26e6ab4336;
    bytes32 internal constant FT_V3_CONTRACT_SUFFIX_HASH =
        0x6d7328472a8bce3b6a53519087fd2f83f703e8b450240d9ce9c10cb4cfcbc33a;
    bytes32 internal constant FT_V3_TAPE_METADATA_HASH =
        0x6bce1d21c42a5aa9546f367748dc9f0727e1b2d912fb106443e71ee034ff1ca8;

    struct DepositIntent {
        bytes32 sourceContractId;
        uint256 destinationChainId;
        address destinationGateway;
        address recipient;
        uint256 amountRaw;
        uint256 depositNonce;
        bytes20 reserveControllerPubKeyHash;
    }

    struct VerifiedDeposit {
        bytes32 txid;
        bytes32 depositId;
        bytes20 covenantController;
        DepositIntent intent;
    }

    error InvalidCovenantValue(uint64 supplied);
    error InvalidCovenantScript();
    error InvalidCovenantDomain();
    error InvalidSourceContract(bytes32 supplied);
    error InvalidDestination(uint256 chainId, address gateway);
    error InvalidRecipient();
    error InvalidAmount(uint256 supplied);
    error InvalidReserveController(bytes20 supplied);
    error InvalidFtCodeValue(uint64 supplied);
    error InvalidFtCodeScript();
    error InvalidFtTapeValue(uint64 supplied);
    error InvalidFtTapeScript();
    error FtTapeAmountMismatch(uint256 supplied, uint256 committed);
    error BlockNotFinalized(bytes32 blockHash);
    error UnknownRelayHeader(bytes32 blockHash);
    error MerkleRootMismatch(bytes32 supplied, bytes32 committed);

    function verifyEnvelope(
        bytes calldata rawTransaction,
        address expectedGateway,
        bytes20 expectedReserveController
    ) internal pure returns (VerifiedDeposit memory verified) {
        TbcBoundedTransaction.TransactionView memory transaction =
            TbcBoundedTransaction.inspect(rawTransaction);
        TbcBoundedTransaction.OutputView memory covenantOutput = transaction.outputs[0];
        if (covenantOutput.satoshis != COVENANT_SATOSHIS) {
            revert InvalidCovenantValue(covenantOutput.satoshis);
        }

        DepositIntent memory intent = _parseCovenant(
            rawTransaction, covenantOutput.scriptOffset, covenantOutput.scriptLength
        );
        if (intent.sourceContractId != SOURCE_CONTRACT_ID) {
            revert InvalidSourceContract(intent.sourceContractId);
        }
        if (
            intent.destinationChainId != TARGET_CHAIN_ID
                || intent.destinationGateway != expectedGateway
        ) revert InvalidDestination(intent.destinationChainId, intent.destinationGateway);
        if (intent.recipient == address(0)) revert InvalidRecipient();
        if (intent.amountRaw == 0 || intent.amountRaw > type(uint64).max) {
            revert InvalidAmount(intent.amountRaw);
        }
        if (intent.reserveControllerPubKeyHash != expectedReserveController) {
            revert InvalidReserveController(intent.reserveControllerPubKeyHash);
        }

        bytes20 covenantController = _covenantController(
            rawTransaction, covenantOutput.scriptOffset, covenantOutput.scriptLength
        );
        _verifyFtCode(rawTransaction, transaction.outputs[1], covenantController);
        _verifyFtTape(rawTransaction, transaction.outputs[2], intent.amountRaw);

        bytes32 depositId = keccak256(abi.encode(
            DEPOSIT_DOMAIN_HASH,
            SOURCE_DOMAIN_HASH,
            intent.sourceContractId,
            transaction.txid,
            SOURCE_VOUT,
            intent.destinationChainId,
            intent.destinationGateway,
            intent.recipient,
            intent.amountRaw,
            intent.depositNonce
        ));
        verified = VerifiedDeposit({
            txid: transaction.txid,
            depositId: depositId,
            covenantController: covenantController,
            intent: intent
        });
    }

    function verifyFinalizedInclusion(
        ITbcHeaderRelayV2 relay,
        bytes32 blockHash,
        bytes calldata rawTransaction,
        uint32 transactionIndex,
        uint32 transactionCount,
        bytes32[] calldata displayedSiblings,
        address expectedGateway,
        bytes20 expectedReserveController
    ) internal view returns (VerifiedDeposit memory verified) {
        if (!relay.isFinalized(blockHash)) revert BlockNotFinalized(blockHash);
        ITbcHeaderRelayV2.HeaderNode memory node = relay.header(blockHash);
        if (!node.exists) revert UnknownRelayHeader(blockHash);
        verified = verifyEnvelope(rawTransaction, expectedGateway, expectedReserveController);
        bytes32 reconstructed = TbcProofVerifier.merkleRoot(
            verified.txid, transactionIndex, transactionCount, displayedSiblings
        );
        if (reconstructed != node.merkleRoot) {
            revert MerkleRootMismatch(reconstructed, node.merkleRoot);
        }
    }

    function verifyMerkleEnvelope(
        bytes32 committedMerkleRoot,
        bytes calldata rawTransaction,
        uint32 transactionIndex,
        uint32 transactionCount,
        bytes32[] calldata displayedSiblings,
        address expectedGateway,
        bytes20 expectedReserveController
    ) internal pure returns (VerifiedDeposit memory verified) {
        verified = verifyEnvelope(rawTransaction, expectedGateway, expectedReserveController);
        bytes32 reconstructed = TbcProofVerifier.merkleRoot(
            verified.txid, transactionIndex, transactionCount, displayedSiblings
        );
        if (reconstructed != committedMerkleRoot) {
            revert MerkleRootMismatch(reconstructed, committedMerkleRoot);
        }
    }

    function _parseCovenant(bytes calldata raw, uint256 offset, uint256 length)
        private
        pure
        returns (DepositIntent memory intent)
    {
        if (length != COVENANT_SCRIPT_BYTES) revert InvalidCovenantScript();
        if (
            uint8(raw[offset]) != 0x4d || uint8(raw[offset + 1]) != 0x06
                || uint8(raw[offset + 2]) != 0x01
                || bytes8(_readBytes32(raw, offset + 3)) != bytes8("LMBV2DEP")
                || uint8(raw[offset + 11]) != 0 || uint8(raw[offset + 12]) != 1
        ) revert InvalidCovenantScript();
        if (
            _readBytes32(raw, offset + 13) != SOURCE_DOMAIN_HASH
                || _readBytes32(raw, offset + 45) != DEPOSIT_DOMAIN_HASH
        ) revert InvalidCovenantDomain();

        intent.sourceContractId = _readBytes32(raw, offset + 77);
        intent.destinationChainId = uint256(_readBytes32(raw, offset + 109));
        intent.destinationGateway = _readAddress(raw, offset + 141);
        intent.recipient = _readAddress(raw, offset + 161);
        intent.amountRaw = uint256(_readBytes32(raw, offset + 181));
        intent.depositNonce = uint256(_readBytes32(raw, offset + 213));
        intent.reserveControllerPubKeyHash = _readBytes20(raw, offset + 245);
        if (
            uint8(raw[offset + 265]) != 0x75 || uint8(raw[offset + 266]) != 0x76
                || uint8(raw[offset + 267]) != 0xa9 || uint8(raw[offset + 268]) != 0x14
                || _readBytes20(raw, offset + 269) != intent.reserveControllerPubKeyHash
                || uint8(raw[offset + 289]) != 0x88 || uint8(raw[offset + 290]) != 0xac
        ) revert InvalidCovenantScript();
    }

    function _verifyFtCode(
        bytes calldata raw,
        TbcBoundedTransaction.OutputView memory output,
        bytes20 covenantController
    ) private pure {
        if (output.satoshis != FT_CODE_SATOSHIS) revert InvalidFtCodeValue(output.satoshis);
        uint256 offset = output.scriptOffset;
        if (
            output.scriptLength != FT_V3_CODE_BYTES
                || keccak256(raw[offset:offset + FT_V3_CONTROLLER_OFFSET])
                    != FT_V3_CODE_PREFIX_HASH
                || _readBytes20(raw, offset + FT_V3_CONTROLLER_OFFSET) != covenantController
                || keccak256(raw[offset + FT_V3_CONTROLLER_OFFSET + 20:offset + FT_V3_CODE_BYTES])
                    != FT_V3_CONTRACT_SUFFIX_HASH
        ) revert InvalidFtCodeScript();
    }

    function _verifyFtTape(
        bytes calldata raw,
        TbcBoundedTransaction.OutputView memory output,
        uint256 committedAmount
    ) private pure {
        if (output.satoshis != 0) revert InvalidFtTapeValue(output.satoshis);
        uint256 offset = output.scriptOffset;
        if (
            output.scriptLength != FT_V3_TAPE_BYTES || uint8(raw[offset]) != 0x00
                || uint8(raw[offset + 1]) != 0x6a || uint8(raw[offset + 2]) != 0x30
                || keccak256(raw[offset + 51:offset + FT_V3_TAPE_BYTES])
                    != FT_V3_TAPE_METADATA_HASH
        ) revert InvalidFtTapeScript();
        uint256 tapeAmount;
        for (uint256 slot; slot < 6; ++slot) {
            tapeAmount += _readUint64LE(raw, offset + 3 + slot * 8);
        }
        if (tapeAmount != committedAmount) {
            revert FtTapeAmountMismatch(tapeAmount, committedAmount);
        }
    }

    function _covenantController(bytes calldata raw, uint256 offset, uint256 length)
        private
        pure
        returns (bytes20)
    {
        bytes memory script = raw[offset:offset + length];
        bytes32 once = sha256(script);
        bytes32 twice = sha256(abi.encodePacked(once));
        return ripemd160(abi.encodePacked(twice));
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

    function _readBytes20(bytes calldata value, uint256 offset)
        private
        pure
        returns (bytes20 result)
    {
        result = bytes20(_readBytes32(value, offset));
    }

    function _readAddress(bytes calldata value, uint256 offset)
        private
        pure
        returns (address result)
    {
        result = address(_readBytes20(value, offset));
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
}
