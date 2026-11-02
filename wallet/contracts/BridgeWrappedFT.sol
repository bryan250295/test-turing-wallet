// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Experimental custodial representation of one TBC Testnet FT on HyperEVM Testnet.
/// @dev The minter must verify FT identity, ownership and amount off-chain. No TBC proofs are verified here.
///      No premine, public mint, native HYPE deposit or redemption mechanism is provided.
contract BridgeWrappedFT is ERC20, Ownable2Step, Pausable {
    uint256 public constant TARGET_CHAIN_ID = 998;
    bytes32 public constant SOURCE_DOMAIN = keccak256("learning-bridge/tbc-testnet/legacy-ft/v1");

    bytes32 public immutable sourceContractId;
    uint8 public immutable sourceDecimals;

    address public minter;
    mapping(bytes32 orderId => bool) public processedOrders;
    mapping(bytes32 depositId => bool) public processedDeposits;

    error WrongChain(uint256 actualChainId);
    error InvalidMinter();
    error InvalidSourceContract();
    error SourceAssetMismatch(bytes32 receivedContractId);
    error UnauthorizedMinter(address caller);
    error InvalidOrder();
    error InvalidSourceTransaction();
    error InvalidRecipient();
    error InvalidAmount();
    error OrderAlreadyProcessed(bytes32 orderId);
    error DepositAlreadyProcessed(bytes32 depositId);
    error OwnershipRequired();

    event MinterChanged(address indexed previousMinter, address indexed newMinter);
    event DepositMinted(
        bytes32 indexed orderId,
        bytes32 indexed depositId,
        address indexed recipient,
        bytes32 sourceContractId,
        bytes32 sourceTxid,
        uint32 sourceVout,
        uint256 amountRaw
    );

    constructor(address admin, address initialMinter, bytes32 sourceContractId_, uint8 sourceDecimals_, string memory wrappedName_, string memory wrappedSymbol_)
        ERC20(wrappedName_, wrappedSymbol_)
        Ownable(admin)
    {
        if (block.chainid != TARGET_CHAIN_ID) revert WrongChain(block.chainid);
        if (sourceContractId_ == bytes32(0)) revert InvalidSourceContract();
        require(bytes(wrappedName_).length > 0 && bytes(wrappedName_).length <= 64, "Invalid name");
        require(bytes(wrappedSymbol_).length > 0 && bytes(wrappedSymbol_).length <= 11, "Invalid symbol");
        sourceContractId = sourceContractId_;
        sourceDecimals = sourceDecimals_;
        _setMinter(initialMinter);
        // Enable minting only after the verifier and custody configuration are ready.
        _pause();
    }

    function decimals() public view override returns (uint8) {
        return sourceDecimals;
    }

    /// @notice Hash the FT identity, display-order TXID and zero-based FT code output index.
    /// @dev TXIDs are bytes32 hex as shown by the TBC API, without byte reversal.
    function depositId(bytes32 sourceTxid, uint32 sourceVout) public view returns (bytes32) {
        return keccak256(abi.encode(SOURCE_DOMAIN, sourceContractId, sourceTxid, sourceVout));
    }

    /// @notice Mint once for a verified order and a unique FT payment output.
    /// @dev Replay protection is scoped to this contract. The backend must pin its address.
    function mintFromDeposit(
        bytes32 orderId,
        bytes32 sourceContractId_,
        bytes32 sourceTxid,
        uint32 sourceVout,
        address recipient,
        uint256 amountRaw
    ) external whenNotPaused {
        if (_msgSender() != minter) revert UnauthorizedMinter(_msgSender());
        if (sourceContractId_ != sourceContractId) revert SourceAssetMismatch(sourceContractId_);
        if (orderId == bytes32(0)) revert InvalidOrder();
        if (sourceTxid == bytes32(0)) revert InvalidSourceTransaction();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (amountRaw == 0) revert InvalidAmount();
        if (processedOrders[orderId]) revert OrderAlreadyProcessed(orderId);

        bytes32 paymentId = depositId(sourceTxid, sourceVout);
        if (processedDeposits[paymentId]) revert DepositAlreadyProcessed(paymentId);

        processedOrders[orderId] = true;
        processedDeposits[paymentId] = true;
        _mint(recipient, amountRaw);
        emit DepositMinted(orderId, paymentId, recipient, sourceContractId, sourceTxid, sourceVout, amountRaw);
    }

    function setMinter(address newMinter) external onlyOwner {
        _setMinter(newMinter);
    }

    /// @notice Pause new mints. Existing ERC-20 transfers remain available.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Preserve an administrator capable of pausing and rotating the minter.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRequired();
    }

    function _setMinter(address newMinter) private {
        if (newMinter == address(0) || newMinter == address(this)) revert InvalidMinter();
        address previous = minter;
        minter = newMinter;
        emit MinterChanged(previous, newMinter);
    }
}
