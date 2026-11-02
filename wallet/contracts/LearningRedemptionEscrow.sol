// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWrappedFTBinding {
    function sourceContractId() external view returns (bytes32);
    function decimals() external view returns (uint8);
    function TARGET_CHAIN_ID() external view returns (uint256);
}

/// @notice Permanently locks the existing lwFT for a separately verified TBC release.
/// @dev No withdrawal, rescue, approval, upgrade or token forwarding function exists.
///      This is permanent escrow, not a burn: the wrapped token totalSupply is unchanged.
///      No TBC transaction is performed or verified by this contract.
contract LearningRedemptionEscrow is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TARGET_CHAIN_ID = 998;
    IERC20 public immutable wrappedToken;
    bytes32 public immutable sourceContractId;
    uint8 public immutable sourceDecimals;
    uint256 public totalLocked;
    mapping(bytes32 redemptionId => bool) public processedRedemptions;

    error WrongChain();
    error InvalidTokenBinding();
    error InvalidRedemption();
    error InvalidTbcRecipient();
    error RedemptionAlreadyProcessed();
    error TokenAmountMismatch();
    error OwnershipRequired();

    event RedemptionLocked(
        bytes32 indexed redemptionId,
        address indexed holder,
        bytes32 indexed recipientHash,
        address wrappedToken,
        bytes32 sourceContractId,
        string tbcRecipient,
        uint256 amountRaw
    );

    constructor(address token, address admin, bytes32 sourceContractId_, uint8 sourceDecimals_)
        Ownable(admin)
    {
        if (block.chainid != TARGET_CHAIN_ID) revert WrongChain();
        if (token == address(this) || token.code.length == 0 || sourceContractId_ == bytes32(0)) revert InvalidTokenBinding();
        IWrappedFTBinding binding = IWrappedFTBinding(token);
        if (binding.sourceContractId() != sourceContractId_ || binding.decimals() != sourceDecimals_
            || binding.TARGET_CHAIN_ID() != TARGET_CHAIN_ID) revert InvalidTokenBinding();
        wrappedToken = IERC20(token);
        sourceContractId = sourceContractId_;
        sourceDecimals = sourceDecimals_;
        // Unpause only when source reserves, fees and the release service are ready.
        _pause();
    }

    /// @notice Exact-amount approval and a separately prepared release order are required.
    /// @dev The server must verify the full event and reserve against this specific escrow.
    function lockForRedemption(bytes32 redemptionId, string calldata tbcRecipient, uint256 amountRaw)
        external whenNotPaused nonReentrant
    {
        if (redemptionId == bytes32(0) || amountRaw == 0) revert InvalidRedemption();
        if (processedRedemptions[redemptionId]) revert RedemptionAlreadyProcessed();
        bytes calldata recipient = bytes(tbcRecipient);
        if (recipient.length < 26 || recipient.length > 35 || recipient[0] != bytes1("1")) revert InvalidTbcRecipient();
        bytes memory alphabet = bytes("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz");
        for (uint256 i; i < recipient.length; i++) {
            bool valid;
            for (uint256 j; j < alphabet.length; j++) {
                if (recipient[i] == alphabet[j]) { valid = true; break; }
            }
            if (!valid) revert InvalidTbcRecipient();
        }
        // Base58Check validation and the frozen recipient binding are also required off-chain.
        processedRedemptions[redemptionId] = true;
        uint256 beforeBalance = wrappedToken.balanceOf(address(this));
        wrappedToken.safeTransferFrom(_msgSender(), address(this), amountRaw);
        if (wrappedToken.balanceOf(address(this)) != beforeBalance + amountRaw) revert TokenAmountMismatch();
        totalLocked += amountRaw;
        emit RedemptionLocked(redemptionId, _msgSender(), keccak256(recipient), address(wrappedToken), sourceContractId, tbcRecipient, amountRaw);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
    function renounceOwnership() public view override onlyOwner { revert OwnershipRequired(); }
}
