// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcBridgeDepositVerifier} from "./TbcBridgeDepositVerifier.sol";
import {TbcDepositReplayProtection} from "./TbcDepositReplayProtection.sol";

/// @notice Stateful replay-protection test harness only; it has no mint authority.
contract TbcDepositReplayHarness is TbcDepositReplayProtection {
    function consume(
        bytes32 sourceContractId,
        bytes32 sourceTxid,
        bytes32 depositId
    ) external returns (bytes32) {
        return _consumeVerifiedDeposit(_verified(sourceContractId, sourceTxid, depositId));
    }

    /// @notice Proves both replay dimensions reject independently in one simulation.
    function exerciseReplayProtection(
        bytes32 sourceContractId,
        bytes32 sourceTxid,
        bytes32 depositId,
        bytes32 differentSourceTxid,
        bytes32 differentDepositId
    ) external returns (bytes32 sourceOutpoint, bool protected) {
        sourceOutpoint = _consumeVerifiedDeposit(
            _verified(sourceContractId, sourceTxid, depositId)
        );

        bool logicalDepositRejected;
        try this.consume(sourceContractId, differentSourceTxid, depositId) {
            logicalDepositRejected = false;
        } catch (bytes memory reason) {
            logicalDepositRejected = _selector(reason) == DepositAlreadyProcessed.selector;
        }

        bool sourceOutpointRejected;
        try this.consume(sourceContractId, sourceTxid, differentDepositId) {
            sourceOutpointRejected = false;
        } catch (bytes memory reason) {
            sourceOutpointRejected =
                _selector(reason) == SourceOutpointAlreadyProcessed.selector;
        }

        bytes32 unusedOutpoint = sourceOutpointId(
            sourceContractId, differentSourceTxid, SOURCE_VOUT
        );
        protected = logicalDepositRejected
            && sourceOutpointRejected
            && processedDeposits[depositId]
            && processedSourceOutpoints[sourceOutpoint]
            && !processedDeposits[differentDepositId]
            && !processedSourceOutpoints[unusedOutpoint];
    }

    function consumeThenRevert(
        bytes32 sourceContractId,
        bytes32 sourceTxid,
        bytes32 depositId
    ) external {
        _consumeVerifiedDeposit(_verified(sourceContractId, sourceTxid, depositId));
        revert("ROLLBACK");
    }

    function exerciseRollback(
        bytes32 sourceContractId,
        bytes32 sourceTxid,
        bytes32 depositId
    ) external returns (bool) {
        bool expectedRevert;
        try this.consumeThenRevert(sourceContractId, sourceTxid, depositId) {
            return false;
        } catch Error(string memory reason) {
            expectedRevert = keccak256(bytes(reason)) == keccak256("ROLLBACK");
        } catch {
            return false;
        }
        bytes32 sourceOutpoint = sourceOutpointId(
            sourceContractId, sourceTxid, SOURCE_VOUT
        );
        return expectedRevert
            && !processedDeposits[depositId]
            && !processedSourceOutpoints[sourceOutpoint];
    }

    function _verified(
        bytes32 sourceContractId,
        bytes32 sourceTxid,
        bytes32 depositId
    ) private pure returns (TbcBridgeDepositVerifier.VerifiedDeposit memory verified) {
        verified.txid = sourceTxid;
        verified.depositId = depositId;
        verified.intent.sourceContractId = sourceContractId;
    }

    function _selector(bytes memory reason) private pure returns (bytes4 selector) {
        if (reason.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            selector := mload(add(reason, 0x20))
        }
    }
}
