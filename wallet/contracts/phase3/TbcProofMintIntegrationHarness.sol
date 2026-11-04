// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcProofMintGateway} from "./TbcProofMintGateway.sol";
import {WrappedFTV2} from "./WrappedFTV2.sol";

/// @notice Test-only atomic proof/replay/mint runner for read-only RPC state overrides.
contract TbcProofMintIntegrationHarness {
    bytes4 private constant DEPOSIT_ALREADY_PROCESSED =
        bytes4(keccak256("DepositAlreadyProcessed(bytes32)"));

    function executeAndRejectReplay(
        TbcProofMintGateway gateway,
        TbcProofMintGateway.MintProof calldata proof,
        bytes32 expectedDepositId,
        address expectedRecipient,
        uint256 expectedAmount
    ) external returns (
        address tokenAddress,
        uint256 recipientBalance,
        uint256 totalSupply,
        bool replayRejected
    ) {
        bytes32 depositId = gateway.mintFromProof(proof);
        require(depositId == expectedDepositId, "wrong deposit id");

        WrappedFTV2 token = gateway.wrappedToken();
        tokenAddress = address(token);
        recipientBalance = token.balanceOf(expectedRecipient);
        totalSupply = token.totalSupply();
        require(
            recipientBalance == expectedAmount && totalSupply == expectedAmount,
            "wrong minted amount"
        );

        try gateway.mintFromProof(proof) {
            replayRejected = false;
        } catch (bytes memory reason) {
            replayRejected =
                _selector(reason) == DEPOSIT_ALREADY_PROCESSED;
        }
        require(replayRejected, "replay not rejected");
        require(gateway.processedDeposits(depositId), "deposit not consumed");
    }

    function _selector(bytes memory reason) private pure returns (bytes4 selector) {
        if (reason.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            selector := mload(add(reason, 0x20))
        }
    }
}
