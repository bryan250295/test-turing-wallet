// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcBridgeDepositVerifier} from "./TbcBridgeDepositVerifier.sol";

/// @notice Storage primitive for consuming a proof-verified TBC deposit once.
/// @dev A proof-only gateway should inherit this contract and call
///      `_consumeVerifiedDeposit` after every proof gate passes but before minting.
///      Keeping the write and mint in one EVM transaction makes both operations
///      atomic: a later revert rolls the replay marks back as well.
abstract contract TbcDepositReplayProtection {
    bytes32 internal constant SOURCE_DOMAIN_HASH =
        0x170fd6ecf53e485cfe0df6a4e3977ae78d3e1fca9ceb05a79c2bca1c79e45c8b;
    uint32 internal constant SOURCE_VOUT = 1;

    mapping(bytes32 depositId => bool) public processedDeposits;
    mapping(bytes32 sourceOutpoint => bool) public processedSourceOutpoints;

    error DepositAlreadyProcessed(bytes32 depositId);
    error SourceOutpointAlreadyProcessed(bytes32 sourceOutpoint);

    event DepositConsumed(
        bytes32 indexed depositId,
        bytes32 indexed sourceOutpoint,
        bytes32 indexed sourceTxid,
        uint32 sourceVout
    );

    /// @notice Domain-separated identity for one FT contract outpoint on TBC Testnet.
    function sourceOutpointId(
        bytes32 sourceContractId,
        bytes32 sourceTxid,
        uint32 sourceVout
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(
            SOURCE_DOMAIN_HASH,
            sourceContractId,
            sourceTxid,
            sourceVout
        ));
    }

    function _consumeVerifiedDeposit(
        TbcBridgeDepositVerifier.VerifiedDeposit memory verified
    ) internal returns (bytes32 sourceOutpoint) {
        bytes32 depositId = verified.depositId;
        if (processedDeposits[depositId]) revert DepositAlreadyProcessed(depositId);

        sourceOutpoint = sourceOutpointId(
            verified.intent.sourceContractId,
            verified.txid,
            SOURCE_VOUT
        );
        if (processedSourceOutpoints[sourceOutpoint]) {
            revert SourceOutpointAlreadyProcessed(sourceOutpoint);
        }

        processedDeposits[depositId] = true;
        processedSourceOutpoints[sourceOutpoint] = true;
        emit DepositConsumed(depositId, sourceOutpoint, verified.txid, SOURCE_VOUT);
    }
}
