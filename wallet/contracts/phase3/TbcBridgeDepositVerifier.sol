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

/// @notice Phase 3D verifier for a finalized TBC transaction, its frozen v3
///         Bridge Covenant envelope and bounded parent/outpoint conservation.
/// @dev This proves canonical transaction bytes, TXID, Merkle inclusion, Covenant
///      intent, pinned v3 Code/Tape encoding, referenced parent bytes and balance
///      conservation and the exact one-level ancestor set selected by the
///      legacy-v3 Tape. It intentionally does NOT claim to execute the legacy
///      FT input scripts/signatures or prove UTXO unspentness.
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
    bytes32 internal constant FT_V3_ADDRESS_SUFFIX_HASH =
        0x1996d1d2f449942cebe17805cd8a7526992f6510674f6c162c97339be3bd5a7b;
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

    struct VerifiedTransition {
        VerifiedDeposit deposit;
        uint256 ftInputTotal;
        uint256 feeRaw;
    }

    struct TransitionState {
        uint256 nativeInputTotal;
        uint256 ftInputTotal;
        bytes20 inputController;
        uint64[6] balances;
    }

    struct AuthenticatedViews {
        TbcBoundedTransaction.TransactionView deposit;
        TbcBoundedTransaction.TransactionView[] parents;
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
    error ParentCountMismatch(uint256 supplied, uint256 expected);
    error ParentTxidMismatch(uint256 vin, bytes32 supplied, bytes32 expected);
    error ParentOutputMissing(uint256 vin, uint32 vout);
    error DuplicateInputOutpoint(uint256 vin);
    error InvalidNativeFeeInput();
    error InvalidFtInput(uint256 vin);
    error MixedFtInputControllers(uint256 vin);
    error InsufficientFtInput(uint256 supplied, uint256 required);
    error InvalidFtChange();
    error InvalidOutputShape(uint256 supplied, uint256 expectedBase);
    error InvalidNativeChange();
    error InvalidNativeFee(uint256 inputs, uint256 outputs);
    error InvalidTapeAllocation(uint256 slot, uint64 supplied, uint64 expected);
    error AncestorGroupCountMismatch(uint256 supplied, uint256 expected);
    error AncestorCountMismatch(uint256 vin, uint256 supplied, uint256 expected);
    error AncestorInputSlotMissing(uint256 vin, uint256 slot);
    error AncestorTxidMismatch(uint256 vin, uint256 slot, bytes32 supplied, bytes32 expected);
    error AncestorOutputMissing(uint256 vin, uint256 slot, uint32 vout);
    error NativeAncestorsNotEmpty(uint256 supplied);

    function verifyEnvelope(
        bytes calldata rawTransaction,
        address expectedGateway,
        bytes20 expectedReserveController
    ) internal pure returns (VerifiedDeposit memory verified) {
        TbcBoundedTransaction.TransactionView memory transaction =
            TbcBoundedTransaction.inspect(rawTransaction);
        return _verifyEnvelope(
            rawTransaction, transaction, expectedGateway, expectedReserveController
        );
    }

    function _verifyEnvelope(
        bytes calldata rawTransaction,
        TbcBoundedTransaction.TransactionView memory transaction,
        address expectedGateway,
        bytes20 expectedReserveController
    ) private pure returns (VerifiedDeposit memory verified) {
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
        bytes20 outputController = _ftController(rawTransaction, transaction.outputs[1], true);
        if (outputController != covenantController) revert InvalidFtCodeScript();
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

    /// @notice Verify the bounded parent/outpoint and FT/native conservation layer.
    /// @dev Parent raw bytes are authenticated by the version-10 TXIDs committed by
    ///      each deposit input. Full ancestor traversal and script execution remain
    ///      a separate gate.
    function verifyTransition(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        address expectedGateway,
        bytes20 expectedReserveController
    ) internal pure returns (VerifiedTransition memory result) {
        AuthenticatedViews memory views;
        views.deposit = TbcBoundedTransaction.inspect(rawTransaction);
        views.parents = new TbcBoundedTransaction.TransactionView[](
            views.deposit.inputCount
        );
        return _verifyTransition(
            rawTransaction,
            views.deposit,
            parentTransactions,
            views.parents,
            expectedGateway,
            expectedReserveController
        );
    }

    function _verifyTransition(
        bytes calldata rawTransaction,
        TbcBoundedTransaction.TransactionView memory depositTransaction,
        bytes[] calldata parentTransactions,
        TbcBoundedTransaction.TransactionView[] memory parentViews,
        address expectedGateway,
        bytes20 expectedReserveController
    ) private pure returns (VerifiedTransition memory result) {
        result.deposit = _verifyEnvelope(
            rawTransaction, depositTransaction, expectedGateway, expectedReserveController
        );
        TransitionState memory state =
            _verifyInputs(depositTransaction, parentTransactions, parentViews);
        uint256 nextOutput = _verifyFtOutputs(
            rawTransaction,
            depositTransaction,
            state,
            result.deposit.intent.amountRaw
        );
        result.ftInputTotal = state.ftInputTotal;
        result.feeRaw = _verifyNativeOutputsAndFee(
            rawTransaction,
            depositTransaction,
            parentTransactions,
            parentViews,
            nextOutput,
            state.nativeInputTotal
        );
    }

    function _verifyFtOutputs(
        bytes calldata rawTransaction,
        TbcBoundedTransaction.TransactionView memory depositTransaction,
        TransitionState memory state,
        uint256 depositAmount
    ) private pure returns (uint256 nextOutput) {
        if (state.ftInputTotal < depositAmount) {
            revert InsufficientFtInput(state.ftInputTotal, depositAmount);
        }
        _verifyTapeAllocation(
            rawTransaction,
            depositTransaction.outputs[2],
            state.balances,
            depositTransaction.inputCount - 1,
            depositAmount,
            false
        );

        nextOutput = 3;
        if (state.ftInputTotal > depositAmount) {
            if (depositTransaction.outputCount < 5) revert InvalidFtChange();
            bytes20 changeController = _ftController(
                rawTransaction, depositTransaction.outputs[3], false
            );
            if (changeController != state.inputController) revert InvalidFtChange();
            uint256 change = state.ftInputTotal - depositAmount;
            _verifyFtTape(rawTransaction, depositTransaction.outputs[4], change);
            _verifyTapeAllocation(
                rawTransaction,
                depositTransaction.outputs[4],
                state.balances,
                depositTransaction.inputCount - 1,
                depositAmount,
                true
            );
            nextOutput = 5;
        }
    }

    function _verifyNativeOutputsAndFee(
        bytes calldata rawTransaction,
        TbcBoundedTransaction.TransactionView memory depositTransaction,
        bytes[] calldata parentTransactions,
        TbcBoundedTransaction.TransactionView[] memory parentViews,
        uint256 nextOutput,
        uint256 nativeInputTotal
    ) private pure returns (uint256 feeRaw) {
        if (
            depositTransaction.outputCount != nextOutput
                && depositTransaction.outputCount != nextOutput + 1
        ) revert InvalidOutputShape(depositTransaction.outputCount, nextOutput);
        if (depositTransaction.outputCount == nextOutput + 1) {
            uint256 nativeVin = depositTransaction.inputCount - 1;
            uint32 nativeVout = depositTransaction.inputs[nativeVin].outputIndex;
            if (
                !_sameScript(
                    rawTransaction,
                    depositTransaction.outputs[nextOutput],
                    parentTransactions[nativeVin],
                    parentViews[nativeVin].outputs[nativeVout]
                )
            ) revert InvalidNativeChange();
        }

        uint256 outputTotal;
        for (uint256 index; index < depositTransaction.outputCount; ++index) {
            outputTotal += depositTransaction.outputs[index].satoshis;
        }
        if (nativeInputTotal <= outputTotal) {
            revert InvalidNativeFee(nativeInputTotal, outputTotal);
        }
        return nativeInputTotal - outputTotal;
    }

    /// @notice Add the exact one-level ancestor set consumed by legacy-v3 FT
    ///         `buildFtPrePreTxData` to the bounded transition proof.
    /// @dev Each FT group is canonically ordered by ascending non-zero Tape slot.
    ///      The final native fee input must have an empty group. This binds all
    ///      ancestor bytes used by the later script verifier, but does not itself
    ///      execute that script or verify its signature.
    function verifyAuthenticatedTransition(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        bytes[][] calldata ancestorTransactions,
        address expectedGateway,
        bytes20 expectedReserveController
    ) internal pure returns (VerifiedTransition memory result) {
        (result,) = verifyAuthenticatedTransitionWithViews(
            rawTransaction,
            parentTransactions,
            ancestorTransactions,
            expectedGateway,
            expectedReserveController
        );
    }

    /// @dev Lets the authorization layer reuse the already parsed deposit and
    ///      parent views instead of hashing and decoding those transactions again.
    function verifyAuthenticatedTransitionWithViews(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        bytes[][] calldata ancestorTransactions,
        address expectedGateway,
        bytes20 expectedReserveController
    ) internal pure returns (
        VerifiedTransition memory result,
        AuthenticatedViews memory views
    ) {
        views.deposit = TbcBoundedTransaction.inspect(rawTransaction);
        views.parents = new TbcBoundedTransaction.TransactionView[](
            views.deposit.inputCount
        );
        result = _verifyTransition(
            rawTransaction,
            views.deposit,
            parentTransactions,
            views.parents,
            expectedGateway,
            expectedReserveController
        );
        _verifyAncestors(
            views.deposit, parentTransactions, ancestorTransactions, views.parents
        );
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

    function _verifyInputs(
        TbcBoundedTransaction.TransactionView memory deposit,
        bytes[] calldata parents,
        TbcBoundedTransaction.TransactionView[] memory parentViews
    ) private pure returns (TransitionState memory state) {
        if (parents.length != deposit.inputCount) {
            revert ParentCountMismatch(parents.length, deposit.inputCount);
        }
        uint256 ftInputCount = deposit.inputCount - 1;
        for (uint256 vin; vin < deposit.inputCount; ++vin) {
            TbcBoundedTransaction.InputView memory input = deposit.inputs[vin];
            for (uint256 previous; previous < vin; ++previous) {
                TbcBoundedTransaction.InputView memory seen = deposit.inputs[previous];
                if (
                    seen.previousTxid == input.previousTxid
                        && seen.outputIndex == input.outputIndex
                ) revert DuplicateInputOutpoint(vin);
            }
            parentViews[vin] = TbcBoundedTransaction.inspectParent(parents[vin]);
            TbcBoundedTransaction.TransactionView memory parent = parentViews[vin];
            if (parent.txid != input.previousTxid) {
                revert ParentTxidMismatch(vin, parent.txid, input.previousTxid);
            }
            if (input.outputIndex >= parent.outputCount) {
                revert ParentOutputMissing(vin, input.outputIndex);
            }
            TbcBoundedTransaction.OutputView memory source = parent.outputs[input.outputIndex];
            state.nativeInputTotal += source.satoshis;
            if (vin == ftInputCount) {
                if (!_isP2pkh(parents[vin], source)) revert InvalidNativeFeeInput();
                continue;
            }
            if (input.outputIndex + 1 >= parent.outputCount) revert InvalidFtInput(vin);
            bytes20 controller = _ftController(parents[vin], source, false);
            if (vin == 0) state.inputController = controller;
            else if (controller != state.inputController) revert MixedFtInputControllers(vin);
            uint256 balance = _tapeAmount(parents[vin], parent.outputs[input.outputIndex + 1]);
            if (balance == 0 || balance > type(uint64).max) revert InvalidFtInput(vin);
            state.balances[vin] = uint64(balance);
            state.ftInputTotal += balance;
        }
    }

    function _verifyAncestors(
        TbcBoundedTransaction.TransactionView memory deposit,
        bytes[] calldata parents,
        bytes[][] calldata ancestorGroups,
        TbcBoundedTransaction.TransactionView[] memory parentViews
    ) private pure {
        if (ancestorGroups.length != deposit.inputCount) {
            revert AncestorGroupCountMismatch(ancestorGroups.length, deposit.inputCount);
        }
        uint256 nativeVin = deposit.inputCount - 1;
        if (ancestorGroups[nativeVin].length != 0) {
            revert NativeAncestorsNotEmpty(ancestorGroups[nativeVin].length);
        }
        for (uint256 vin; vin < nativeVin; ++vin) {
            TbcBoundedTransaction.TransactionView memory parent = parentViews[vin];
            uint32 parentVout = deposit.inputs[vin].outputIndex;
            if (parentVout + 1 >= parent.outputCount) revert InvalidFtInput(vin);
            TbcBoundedTransaction.OutputView memory tape = parent.outputs[parentVout + 1];
            _tapeAmount(parents[vin], tape);
            uint256 suppliedIndex;
            for (uint256 slot; slot < 6; ++slot) {
                if (_readUint64LE(parents[vin], tape.scriptOffset + 3 + slot * 8) == 0) {
                    continue;
                }
                if (slot >= parent.inputCount) revert AncestorInputSlotMissing(vin, slot);
                if (suppliedIndex >= ancestorGroups[vin].length) {
                    revert AncestorCountMismatch(
                        vin, ancestorGroups[vin].length, suppliedIndex + 1
                    );
                }
                TbcBoundedTransaction.TransactionView memory ancestor =
                    TbcBoundedTransaction.inspectParent(ancestorGroups[vin][suppliedIndex]);
                TbcBoundedTransaction.InputView memory sourceInput = parent.inputs[slot];
                if (ancestor.txid != sourceInput.previousTxid) {
                    revert AncestorTxidMismatch(
                        vin, slot, ancestor.txid, sourceInput.previousTxid
                    );
                }
                if (sourceInput.outputIndex >= ancestor.outputCount) {
                    revert AncestorOutputMissing(vin, slot, sourceInput.outputIndex);
                }
                ++suppliedIndex;
            }
            if (suppliedIndex != ancestorGroups[vin].length) {
                revert AncestorCountMismatch(vin, ancestorGroups[vin].length, suppliedIndex);
            }
        }
    }

    function _ftController(
        bytes calldata raw,
        TbcBoundedTransaction.OutputView memory output,
        bool contractControlled
    ) private pure returns (bytes20 controller) {
        if (output.satoshis != FT_CODE_SATOSHIS) revert InvalidFtCodeValue(output.satoshis);
        uint256 offset = output.scriptOffset;
        bytes32 expectedSuffix = contractControlled
            ? FT_V3_CONTRACT_SUFFIX_HASH
            : FT_V3_ADDRESS_SUFFIX_HASH;
        if (
            output.scriptLength != FT_V3_CODE_BYTES
                || keccak256(raw[offset:offset + FT_V3_CONTROLLER_OFFSET])
                    != FT_V3_CODE_PREFIX_HASH
                || keccak256(raw[offset + FT_V3_CONTROLLER_OFFSET + 20:offset + FT_V3_CODE_BYTES])
                    != expectedSuffix
        ) revert InvalidFtCodeScript();
        controller = _readBytes20(raw, offset + FT_V3_CONTROLLER_OFFSET);
    }

    function _verifyFtTape(
        bytes calldata raw,
        TbcBoundedTransaction.OutputView memory output,
        uint256 committedAmount
    ) private pure {
        uint256 tapeAmount = _tapeAmount(raw, output);
        if (tapeAmount != committedAmount) {
            revert FtTapeAmountMismatch(tapeAmount, committedAmount);
        }
    }

    function _tapeAmount(
        bytes calldata raw,
        TbcBoundedTransaction.OutputView memory output
    ) private pure returns (uint256 tapeAmount) {
        if (output.satoshis != 0) revert InvalidFtTapeValue(output.satoshis);
        uint256 offset = output.scriptOffset;
        if (
            output.scriptLength != FT_V3_TAPE_BYTES || uint8(raw[offset]) != 0x00
                || uint8(raw[offset + 1]) != 0x6a || uint8(raw[offset + 2]) != 0x30
                || keccak256(raw[offset + 51:offset + FT_V3_TAPE_BYTES])
                    != FT_V3_TAPE_METADATA_HASH
        ) revert InvalidFtTapeScript();
        for (uint256 slot; slot < 6; ++slot) {
            tapeAmount += _readUint64LE(raw, offset + 3 + slot * 8);
        }
    }

    function _verifyTapeAllocation(
        bytes calldata raw,
        TbcBoundedTransaction.OutputView memory output,
        uint64[6] memory balances,
        uint256 inputCount,
        uint256 paid,
        bool change
    ) private pure {
        uint256 remaining = paid;
        uint256 offset = output.scriptOffset + 3;
        for (uint256 slot; slot < 6; ++slot) {
            uint64 spent;
            if (slot < inputCount && remaining != 0) {
                spent = remaining < balances[slot] ? uint64(remaining) : balances[slot];
                remaining -= spent;
            }
            uint64 expected = change ? balances[slot] - spent : spent;
            uint64 supplied = _readUint64LE(raw, offset + slot * 8);
            if (supplied != expected) {
                revert InvalidTapeAllocation(slot, supplied, expected);
            }
        }
        if (remaining != 0) revert InsufficientFtInput(paid - remaining, paid);
    }

    function _isP2pkh(
        bytes calldata raw,
        TbcBoundedTransaction.OutputView memory output
    ) private pure returns (bool) {
        uint256 offset = output.scriptOffset;
        return output.scriptLength == 25 && uint8(raw[offset]) == 0x76
            && uint8(raw[offset + 1]) == 0xa9 && uint8(raw[offset + 2]) == 0x14
            && uint8(raw[offset + 23]) == 0x88 && uint8(raw[offset + 24]) == 0xac;
    }

    function _sameScript(
        bytes calldata leftRaw,
        TbcBoundedTransaction.OutputView memory left,
        bytes calldata rightRaw,
        TbcBoundedTransaction.OutputView memory right
    ) private pure returns (bool) {
        return left.scriptLength == right.scriptLength
            && keccak256(leftRaw[left.scriptOffset:left.scriptOffset + left.scriptLength])
                == keccak256(rightRaw[right.scriptOffset:right.scriptOffset + right.scriptLength]);
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
