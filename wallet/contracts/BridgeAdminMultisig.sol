// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal fixed 2-of-2 administrator for the learning bridge on HyperEVM Testnet.
/// @dev This contract deliberately holds no mint role. It is only intended to own a
///      BridgeWrappedFT contract and approve rare administrative calls such as pause,
///      unpause and minter rotation. Both configured signers must approve every action.
contract BridgeAdminMultisig {
    uint256 public constant TARGET_CHAIN_ID = 998;
    uint256 public constant threshold = 2;

    address public immutable signer1;
    address public immutable signer2;
    uint256 public nonce;

    struct Action {
        address target;
        bytes data;
        bool executed;
    }

    mapping(bytes32 actionId => Action) private actions;
    mapping(bytes32 actionId => mapping(address signer => bool)) public approved;

    error WrongChain(uint256 actualChainId);
    error InvalidSigner();
    error UnauthorizedSigner(address caller);
    error InvalidTarget();
    error InvalidCallData();
    error UnknownAction(bytes32 actionId);
    error AlreadyApproved(bytes32 actionId, address signer);
    error AlreadyExecuted(bytes32 actionId);
    error ExecutionFailed(bytes returnData);

    event ActionProposed(bytes32 indexed actionId, address indexed proposer, address indexed target, bytes data);
    event ActionApproved(bytes32 indexed actionId, address indexed signer);
    event ActionExecuted(bytes32 indexed actionId, address indexed target);

    modifier onlySigner() {
        if (msg.sender != signer1 && msg.sender != signer2) revert UnauthorizedSigner(msg.sender);
        _;
    }

    constructor(address signer1_, address signer2_) {
        if (block.chainid != TARGET_CHAIN_ID) revert WrongChain(block.chainid);
        if (signer1_ == address(0) || signer2_ == address(0) || signer1_ == signer2_) revert InvalidSigner();
        signer1 = signer1_;
        signer2 = signer2_;
    }

    /// @notice Create an administrative action and record the proposer's first approval.
    function propose(address target, bytes calldata data) external onlySigner returns (bytes32 actionId) {
        if (target == address(0) || target == address(this)) revert InvalidTarget();
        if (data.length < 4) revert InvalidCallData();
        uint256 actionNonce = nonce++;
        actionId = keccak256(abi.encode(block.chainid, address(this), actionNonce, target, keccak256(data)));
        actions[actionId] = Action({target: target, data: data, executed: false});
        approved[actionId][msg.sender] = true;
        emit ActionProposed(actionId, msg.sender, target, data);
        emit ActionApproved(actionId, msg.sender);
    }

    /// @notice Supply the second approval and execute the exact proposed call atomically.
    function approveAndExecute(bytes32 actionId) external onlySigner returns (bytes memory returnData) {
        Action storage pendingAction = actions[actionId];
        if (pendingAction.target == address(0)) revert UnknownAction(actionId);
        if (pendingAction.executed) revert AlreadyExecuted(actionId);
        if (approved[actionId][msg.sender]) revert AlreadyApproved(actionId, msg.sender);
        approved[actionId][msg.sender] = true;
        pendingAction.executed = true;
        emit ActionApproved(actionId, msg.sender);
        (bool success, bytes memory result) = pendingAction.target.call(pendingAction.data);
        if (!success) revert ExecutionFailed(result);
        emit ActionExecuted(actionId, pendingAction.target);
        return result;
    }

    function action(bytes32 actionId) external view returns (address target, bytes memory data, bool executed) {
        Action storage stored = actions[actionId];
        return (stored.target, stored.data, stored.executed);
    }
}
