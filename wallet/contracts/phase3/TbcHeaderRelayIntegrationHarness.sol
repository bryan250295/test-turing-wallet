// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcHeaderRelayV2} from "./TbcHeaderRelayV2.sol";

/// @notice Test-only stateful relay runner for read-only HyperEVM RPC vectors.
/// @dev The deployed relay and all writes exist only for the duration of eth_call.
contract TbcHeaderRelayIntegrationHarness is TbcHeaderRelayV2 {
    function validateSixHeaders(
        bytes[] calldata rawHeaders,
        TbcHeaderRelayV2.BootstrapWitness[][] calldata witnesses,
        bytes32 expectedTip,
        bytes32 expectedFirst
    ) external returns (uint32 bestHeight, uint256 bestChainWork) {
        require(rawHeaders.length == 6 && witnesses.length == 6, "six headers required");
        TbcHeaderRelayV2 relay = new TbcHeaderRelayV2();
        for (uint256 index; index < rawHeaders.length; ++index) {
            relay.submitHeader(rawHeaders[index], witnesses[index]);
        }
        require(relay.bestTip() == expectedTip, "unexpected best tip");
        require(!relay.bestWorkTie(), "unexpected equal-work tie");
        require(relay.isFinalized(expectedFirst), "first header is not finalized");
        TbcHeaderRelayV2.HeaderNode memory tip = relay.header(expectedTip);
        require(relay.ancestor(expectedTip, tip.height - 5) == expectedFirst, "wrong ancestry");
        return (tip.height, tip.chainWork);
    }

    function validateEqualWorkFailClosed() external returns (bool) {
        bytes32 first = keccak256("first");
        bytes32 competing = keccak256("competing");
        bytes32 winner = keccak256("winner");
        uint256 initialWork = bestChainWork;
        _considerBest(first, CHECKPOINT_HEIGHT + 1, initialWork + 10);
        require(bestTip == first && !bestWorkTie, "first branch not selected");
        _considerBest(competing, CHECKPOINT_HEIGHT + 1, initialWork + 10);
        require(bestTip == first && bestWorkTie, "equal-work tie not closed");
        _considerBest(winner, CHECKPOINT_HEIGHT + 2, initialWork + 11);
        require(bestTip == winner && !bestWorkTie, "greater-work branch did not resolve tie");
        return true;
    }

    /// @notice Read-only RPC benchmark; values exclude the outer transaction's
    ///         intrinsic/calldata gas and include the Solidity external-call wrapper.
    function profileSixHeaders(
        bytes[] calldata rawHeaders,
        TbcHeaderRelayV2.BootstrapWitness[][] calldata witnesses
    ) external returns (uint256 deploymentExecutionGas, uint256[] memory submissionExecutionGas) {
        require(rawHeaders.length == 6 && witnesses.length == 6, "six headers required");
        submissionExecutionGas = new uint256[](rawHeaders.length);
        uint256 beforeOperation = gasleft();
        TbcHeaderRelayV2 relay = new TbcHeaderRelayV2();
        deploymentExecutionGas = beforeOperation - gasleft();
        for (uint256 index; index < rawHeaders.length; ++index) {
            beforeOperation = gasleft();
            relay.submitHeader(rawHeaders[index], witnesses[index]);
            submissionExecutionGas[index] = beforeOperation - gasleft();
        }
    }
}
