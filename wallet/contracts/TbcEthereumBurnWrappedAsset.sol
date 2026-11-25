// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Custodial representation of either native TBC or one TBC FT on Ethereum Sepolia.
/// @dev A limited relayer mints only after a canonical TBC custody deposit. Returning to TBC
///      destroys supply here and emits the exact TBC recipient that the release service verifies.
contract TbcEthereumBurnWrappedAsset is ERC20, Ownable2Step, Pausable {
    uint256 public constant TARGET_CHAIN_ID = 11155111;
    bytes32 public constant SOURCE_DOMAIN = keccak256("learning-bridge/tbc-testnet-to-ethereum-sepolia/burn/v1");

    enum SourceAssetKind { NativeTbc, FungibleToken }

    bytes32 public immutable sourceAssetId;
    uint8 public immutable sourceDecimals;
    SourceAssetKind public immutable sourceAssetKind;

    address public minter;
    mapping(bytes32 orderId => bool) public processedOrders;
    mapping(bytes32 depositId_ => bool) public processedDeposits;
    mapping(bytes32 redemptionId => bool) public processedRedemptions;

    error WrongChain(uint256 actualChainId);
    error InvalidMinter();
    error InvalidSourceAsset();
    error SourceAssetMismatch(bytes32 receivedAssetId, uint8 receivedKind);
    error UnauthorizedMinter(address caller);
    error InvalidOrder();
    error InvalidSourceTransaction();
    error InvalidRecipient();
    error InvalidAmount();
    error OrderAlreadyProcessed(bytes32 orderId);
    error DepositAlreadyProcessed(bytes32 depositId_);
    error InvalidRedemption();
    error InvalidTbcRecipient();
    error RedemptionAlreadyProcessed(bytes32 redemptionId);
    error OwnershipRequired();

    event MinterChanged(address indexed previousMinter, address indexed newMinter);
    event DepositMinted(
        bytes32 indexed orderId,
        bytes32 indexed depositId,
        address indexed recipient,
        bytes32 sourceAssetId,
        uint8 sourceAssetKind,
        bytes32 sourceTxid,
        uint32 sourceVout,
        uint256 amountRaw
    );
    event RedemptionBurned(
        bytes32 indexed redemptionId,
        address indexed holder,
        bytes32 indexed recipientHash,
        bytes32 sourceAssetId,
        uint8 sourceAssetKind,
        string tbcRecipient,
        uint256 amountRaw
    );

    constructor(
        address admin,
        address initialMinter,
        bytes32 sourceAssetId_,
        uint8 sourceDecimals_,
        SourceAssetKind sourceAssetKind_,
        string memory wrappedName_,
        string memory wrappedSymbol_
    ) ERC20(wrappedName_, wrappedSymbol_) Ownable(admin) {
        if (block.chainid != TARGET_CHAIN_ID) revert WrongChain(block.chainid);
        if (sourceAssetId_ == bytes32(0)) revert InvalidSourceAsset();
        require(bytes(wrappedName_).length > 0 && bytes(wrappedName_).length <= 64, "Invalid name");
        require(bytes(wrappedSymbol_).length > 0 && bytes(wrappedSymbol_).length <= 11, "Invalid symbol");
        sourceAssetId = sourceAssetId_;
        sourceDecimals = sourceDecimals_;
        sourceAssetKind = sourceAssetKind_;
        _setMinter(initialMinter);
        // The operator must verify custody, relayer and administrator configuration first.
        _pause();
    }

    function decimals() public view override returns (uint8) { return sourceDecimals; }

    function depositId(bytes32 sourceTxid, uint32 sourceVout) public view returns (bytes32) {
        return keccak256(abi.encode(SOURCE_DOMAIN, sourceAssetKind, sourceAssetId, sourceTxid, sourceVout));
    }

    function mintFromDeposit(
        bytes32 orderId,
        bytes32 sourceAssetId_,
        uint8 sourceAssetKind_,
        bytes32 sourceTxid,
        uint32 sourceVout,
        address recipient,
        uint256 amountRaw
    ) external whenNotPaused {
        if (_msgSender() != minter) revert UnauthorizedMinter(_msgSender());
        if (sourceAssetId_ != sourceAssetId || sourceAssetKind_ != uint8(sourceAssetKind)) {
            revert SourceAssetMismatch(sourceAssetId_, sourceAssetKind_);
        }
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
        emit DepositMinted(orderId, paymentId, recipient, sourceAssetId, uint8(sourceAssetKind), sourceTxid, sourceVout, amountRaw);
    }

    /// @notice Burn wrapped supply and bind the burn receipt to one TBC Testnet recipient.
    /// @dev The release service must verify this exact canonical event and validate the full
    ///      Base58Check address before spending custody. The contract validates only its format.
    function burnForRedemption(bytes32 redemptionId, string calldata tbcRecipient, uint256 amountRaw)
        external whenNotPaused
    {
        if (redemptionId == bytes32(0) || amountRaw == 0) revert InvalidRedemption();
        if (processedRedemptions[redemptionId]) revert RedemptionAlreadyProcessed(redemptionId);
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
        processedRedemptions[redemptionId] = true;
        _burn(_msgSender(), amountRaw);
        emit RedemptionBurned(
            redemptionId,
            _msgSender(),
            keccak256(recipient),
            sourceAssetId,
            uint8(sourceAssetKind),
            tbcRecipient,
            amountRaw
        );
    }

    function setMinter(address newMinter) external onlyOwner { _setMinter(newMinter); }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
    function renounceOwnership() public view override onlyOwner { revert OwnershipRequired(); }

    function _setMinter(address newMinter) private {
        if (newMinter == address(0) || newMinter == address(this)) revert InvalidMinter();
        address previous = minter;
        minter = newMinter;
        emit MinterChanged(previous, newMinter);
    }
}
