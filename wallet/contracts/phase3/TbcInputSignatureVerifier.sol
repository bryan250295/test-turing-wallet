// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcStandaloneInputAuthorization} from "./TbcStandaloneInputAuthorization.sol";
import {TbcBoundedTransaction} from "./TbcBoundedTransaction.sol";

/// @notice Stateless ALL|FORKID signature and exact parent-witness verifier.
contract TbcInputSignatureVerifier {
    error ParentTransactionCountMismatch(uint256 supplied, uint256 expected);
    error ParentTransactionMismatch(uint256 vin, bytes32 supplied, bytes32 expected);

    function verifyInputSignatures(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        TbcStandaloneInputAuthorization.SignatureWitness[] calldata signatureWitnesses
    ) external pure returns (bool) {
        TbcBoundedTransaction.TransactionView memory transaction =
            TbcBoundedTransaction.inspect(rawTransaction);
        if (parentTransactions.length != transaction.inputCount) {
            revert ParentTransactionCountMismatch(
                parentTransactions.length, transaction.inputCount
            );
        }
        if (signatureWitnesses.length != transaction.inputCount) {
            revert TbcStandaloneInputAuthorization.SignatureWitnessCountMismatch(
                signatureWitnesses.length, transaction.inputCount
            );
        }
        uint256 nativeVin = transaction.inputCount - 1;
        for (uint256 vin; vin < transaction.inputCount; ++vin) {
            TbcBoundedTransaction.TransactionView memory parent =
                TbcBoundedTransaction.inspectParent(parentTransactions[vin]);
            bytes32 expected = transaction.inputs[vin].previousTxid;
            if (parent.txid != expected) {
                revert ParentTransactionMismatch(vin, parent.txid, expected);
            }
            TbcStandaloneInputAuthorization._verifyVin(
                rawTransaction,
                transaction,
                parentTransactions[vin],
                parent,
                signatureWitnesses[vin],
                vin,
                vin == nativeVin
            );
        }
        return true;
    }
}
