// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Proof-only representation of the pinned MT legacy FT on HyperEVM Testnet.
/// @dev There is no owner, admin, alternate minter or burn path. Phase 4 must add
///      a separately reviewed redemption design before any burn can be enabled.
contract WrappedFTV2 is ERC20 {
    uint256 public constant TARGET_CHAIN_ID = 998;
    bytes32 public constant SOURCE_CONTRACT_ID =
        0xac54e83d476839a11bbb7d0a2495e50c9d0d23c9283f94e11222bad589259e6c;
    uint8 public constant SOURCE_DECIMALS = 1;
    uint256 public constant MAX_SUPPLY_RAW = 10_000_000;

    address public immutable gateway;

    error WrongDestinationChain(uint256 actual);
    error InvalidGateway();
    error UnauthorizedGateway(address caller);
    error InvalidRecipient(address recipient);
    error InvalidAmount();
    error MaximumSupplyExceeded(uint256 requestedSupply, uint256 maximumSupply);

    constructor(address gateway_) ERC20("Proof Wrapped Mega Token", "pwMT") {
        if (block.chainid != TARGET_CHAIN_ID) revert WrongDestinationChain(block.chainid);
        if (gateway_ == address(0)) revert InvalidGateway();
        gateway = gateway_;
    }

    function decimals() public pure override returns (uint8) {
        return SOURCE_DECIMALS;
    }

    function mintFromProof(address recipient, uint256 amountRaw) external {
        if (msg.sender != gateway) revert UnauthorizedGateway(msg.sender);
        if (recipient == address(0) || recipient == address(this) || recipient == gateway) {
            revert InvalidRecipient(recipient);
        }
        if (amountRaw == 0) revert InvalidAmount();
        uint256 requestedSupply = totalSupply() + amountRaw;
        if (requestedSupply > MAX_SUPPLY_RAW) {
            revert MaximumSupplyExceeded(requestedSupply, MAX_SUPPLY_RAW);
        }
        _mint(recipient, amountRaw);
    }
}
