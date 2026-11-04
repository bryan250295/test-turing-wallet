// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    ITbcHeaderRelayV2,
    TbcBridgeDepositVerifier
} from "./TbcBridgeDepositVerifier.sol";
import {TbcInputAuthorization} from "./TbcInputAuthorization.sol";
import {TbcDepositReplayProtection} from "./TbcDepositReplayProtection.sol";
import {TbcHeaderRelayV2} from "./TbcHeaderRelayV2.sol";
import {WrappedFTV2} from "./WrappedFTV2.sol";

interface ITbcAuthorizedTransitionVerifier {
    function verifyAuthorizedTransition(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        bytes[][] calldata ancestorTransactions,
        TbcInputAuthorization.SignatureWitness[] calldata signatureWitnesses,
        address expectedGateway,
        bytes20 expectedReserveController
    ) external pure returns (TbcBridgeDepositVerifier.VerifiedTransition memory);
}

interface ITbcFtUnlockPrefixVerifierModule {
    function verifyFtUnlockPrefixes(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        bytes[][] calldata ancestorTransactions,
        uint32[] calldata signaturePushOffsets
    ) external pure returns (bool);
}

/// @notice Permissionless proof-to-mint gateway for the frozen TBC Testnet MT route.
/// @dev No owner, operator, pause key or alternate mint path exists. Constructor
///      codehash checks pin the exact relay and verifier runtimes compiled for this phase.
contract TbcProofMintGateway is TbcDepositReplayProtection {
    uint256 public constant TARGET_CHAIN_ID = 998;
    bytes32 public constant SOURCE_CONTRACT_ID =
        0xac54e83d476839a11bbb7d0a2495e50c9d0d23c9283f94e11222bad589259e6c;

    bytes32 public constant RELAY_RUNTIME_CODEHASH =
        0x8056986ffcc5d8f1fa018aee82fe5fc36e27bbd10d4f5141871768c43554ef03;
    bytes32 public constant AUTHORIZATION_RUNTIME_CODEHASH =
        0xbd25c07c5a57d79532cd829a650346ddc00863d92ba833cee49099916173d4c5;
    bytes32 public constant PREFIX_RUNTIME_CODEHASH =
        0xdca851d9c2013789f5da598adc15136b0ca003de58a652be20e1fc0f6203fa49;

    ITbcHeaderRelayV2 public immutable relay;
    ITbcAuthorizedTransitionVerifier public immutable authorizationVerifier;
    ITbcFtUnlockPrefixVerifierModule public immutable prefixVerifier;
    bytes20 public immutable reserveController;
    WrappedFTV2 public immutable wrappedToken;

    struct MintProof {
        bytes32 blockHash;
        bytes rawTransaction;
        uint32 transactionIndex;
        uint32 transactionCount;
        bytes32[] displayedSiblings;
        bytes[] parentTransactions;
        bytes[][] ancestorTransactions;
        TbcInputAuthorization.SignatureWitness[] signatureWitnesses;
        uint32[] signaturePushOffsets;
    }

    error WrongDestinationChain(uint256 actual);
    error InvalidRouteAddress();
    error InvalidReserveController();
    error UnexpectedRuntimeCodeHash(address target, bytes32 actual, bytes32 expected);
    error MismatchedVerifierResult();
    error MismatchedSignatureOffset(uint256 vin);
    error PrefixVerificationFailed();
    error InvalidMintRecipient(address recipient);

    event ProofMinted(
        bytes32 indexed depositId,
        bytes32 indexed sourceTxid,
        address indexed recipient,
        uint256 amountRaw,
        bytes32 blockHash
    );

    constructor(
        ITbcAuthorizedTransitionVerifier authorizationVerifier_,
        ITbcFtUnlockPrefixVerifierModule prefixVerifier_,
        bytes20 reserveController_
    ) {
        if (block.chainid != TARGET_CHAIN_ID) revert WrongDestinationChain(block.chainid);
        if (
            address(authorizationVerifier_) == address(0)
                || address(prefixVerifier_) == address(0)
        ) revert InvalidRouteAddress();
        if (reserveController_ == bytes20(0)) revert InvalidReserveController();
        _requireCodehash(address(authorizationVerifier_), AUTHORIZATION_RUNTIME_CODEHASH);
        _requireCodehash(address(prefixVerifier_), PREFIX_RUNTIME_CODEHASH);

        TbcHeaderRelayV2 relay_ = new TbcHeaderRelayV2();
        _requireCodehash(address(relay_), RELAY_RUNTIME_CODEHASH);
        relay = ITbcHeaderRelayV2(address(relay_));
        authorizationVerifier = authorizationVerifier_;
        prefixVerifier = prefixVerifier_;
        reserveController = reserveController_;
        wrappedToken = new WrappedFTV2(address(this));
    }

    /// @notice Verify a finalized TBC deposit and atomically mint its exact raw amount.
    /// @dev Any caller may relay a proof and pays this transaction's HyperEVM gas.
    function mintFromProof(MintProof calldata proof) external returns (bytes32 depositId) {
        TbcBridgeDepositVerifier.VerifiedDeposit memory finalized =
            TbcBridgeDepositVerifier.verifyFinalizedInclusion(
                relay,
                proof.blockHash,
                proof.rawTransaction,
                proof.transactionIndex,
                proof.transactionCount,
                proof.displayedSiblings,
                address(this),
                reserveController
            );
        _requireUnprocessed(finalized);
        if (
            finalized.intent.recipient == address(this)
                || finalized.intent.recipient == address(wrappedToken)
        ) revert InvalidMintRecipient(finalized.intent.recipient);
        _requireMatchedSignatureOffsets(
            proof.signatureWitnesses, proof.signaturePushOffsets
        );

        TbcBridgeDepositVerifier.VerifiedTransition memory authorized =
            authorizationVerifier.verifyAuthorizedTransition(
                proof.rawTransaction,
                proof.parentTransactions,
                proof.ancestorTransactions,
                proof.signatureWitnesses,
                address(this),
                reserveController
            );
        if (!_sameDeposit(authorized.deposit, finalized)) revert MismatchedVerifierResult();

        if (
            !prefixVerifier.verifyFtUnlockPrefixes(
                proof.rawTransaction,
                proof.parentTransactions,
                proof.ancestorTransactions,
                proof.signaturePushOffsets
            )
        ) revert PrefixVerificationFailed();

        _consumeVerifiedDeposit(authorized.deposit);
        wrappedToken.mintFromProof(
            authorized.deposit.intent.recipient,
            authorized.deposit.intent.amountRaw
        );
        depositId = authorized.deposit.depositId;
        emit ProofMinted(
            depositId,
            authorized.deposit.txid,
            authorized.deposit.intent.recipient,
            authorized.deposit.intent.amountRaw,
            proof.blockHash
        );
    }

    function _requireCodehash(address target, bytes32 expected) private view {
        bytes32 actual = target.codehash;
        if (actual != expected) revert UnexpectedRuntimeCodeHash(target, actual, expected);
    }

    function _requireMatchedSignatureOffsets(
        TbcInputAuthorization.SignatureWitness[] calldata witnesses,
        uint32[] calldata offsets
    ) private pure {
        if (witnesses.length != offsets.length) {
            revert MismatchedSignatureOffset(type(uint256).max);
        }
        for (uint256 vin; vin < offsets.length; ++vin) {
            if (witnesses[vin].signaturePushOffset != offsets[vin]) {
                revert MismatchedSignatureOffset(vin);
            }
        }
    }

    function _sameDeposit(
        TbcBridgeDepositVerifier.VerifiedDeposit memory left,
        TbcBridgeDepositVerifier.VerifiedDeposit memory right
    ) private pure returns (bool) {
        return left.txid == right.txid
            && left.depositId == right.depositId
            && left.covenantController == right.covenantController
            && left.intent.sourceContractId == SOURCE_CONTRACT_ID
            && left.intent.sourceContractId == right.intent.sourceContractId
            && left.intent.destinationChainId == right.intent.destinationChainId
            && left.intent.destinationGateway == right.intent.destinationGateway
            && left.intent.recipient == right.intent.recipient
            && left.intent.amountRaw == right.intent.amountRaw
            && left.intent.depositNonce == right.intent.depositNonce
            && left.intent.reserveControllerPubKeyHash
                == right.intent.reserveControllerPubKeyHash;
    }
}
