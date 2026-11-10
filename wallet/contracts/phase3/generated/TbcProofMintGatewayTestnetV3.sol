// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    ITbcHeaderRelayV2,
    TbcBridgeDepositVerifier
} from "../TbcBridgeDepositVerifier.sol";
import {TbcStandaloneInputAuthorization} from "../TbcStandaloneInputAuthorization.sol";
import {TbcDepositReplayProtection} from "../TbcDepositReplayProtection.sol";
import {WrappedFTV2} from "../WrappedFTV2.sol";

interface ITbcFinalizedDepositVerifier {
    function verifyFinalizedDeposit(
        ITbcHeaderRelayV2 relay,
        bytes32 blockHash,
        bytes calldata rawTransaction,
        uint32 transactionIndex,
        uint32 transactionCount,
        bytes32[] calldata displayedSiblings,
        address expectedGateway,
        bytes20 expectedReserveController
    ) external view returns (TbcBridgeDepositVerifier.VerifiedDeposit memory);
}

interface ITbcAuthenticatedTransitionVerifier {
    function verifyAuthenticatedTransition(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        bytes[][] calldata ancestorTransactions,
        address expectedGateway,
        bytes20 expectedReserveController
    ) external pure returns (TbcBridgeDepositVerifier.VerifiedTransition memory);
}

interface ITbcInputSignatureVerifier {
    function verifyInputSignatures(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        TbcStandaloneInputAuthorization.SignatureWitness[] calldata signatureWitnesses
    ) external pure returns (bool);
}

interface ITbcFtUnlockPrefixVerifierModule {
    function verifyFtUnlockPrefixes(
        bytes calldata rawTransaction,
        bytes[] calldata parentTransactions,
        bytes[][] calldata ancestorTransactions,
        uint32[] calldata signaturePushOffsets
    ) external pure returns (bool);
}

/// @notice Permissionless proof-to-mint gateway for the public TBC Testnet MT route anchored at checkpoint v3.
/// @dev No owner, operator, pause key or alternate mint path exists. Constructor
///      codehash checks pin the exact relay and verifier runtimes compiled for this phase.
contract TbcProofMintGatewayTestnetV3 is TbcDepositReplayProtection {
    uint256 public constant TARGET_CHAIN_ID = 998;
    bytes32 public constant SOURCE_CONTRACT_ID =
        0xac54e83d476839a11bbb7d0a2495e50c9d0d23c9283f94e11222bad589259e6c;

    bytes32 public constant RELAY_RUNTIME_CODEHASH = 0xa304f4e24311fa2178e29647e1f2afaa0d4096c448e1c475381dc3a5c5a60a8a;
    bytes32 public constant FINALIZED_RUNTIME_CODEHASH =
        0xdcb75adcfe25c35695f757962f3f978c0fd63c8c1ec243a6abef1c30b27c5679;
    bytes32 public constant TRANSITION_RUNTIME_CODEHASH =
        0xb7df554b5c15adf2d969a84becb29681d529e52bbe373c1e2ed360972269ebc9;
    bytes32 public constant SIGNATURE_RUNTIME_CODEHASH =
        0xf4df7751f0b7fd2d515e1b1cd11096a974c0cf52f8ec92b51811e2af4d43a763;
    bytes32 public constant PREFIX_RUNTIME_CODEHASH =
        0xdca851d9c2013789f5da598adc15136b0ca003de58a652be20e1fc0f6203fa49;

    ITbcHeaderRelayV2 public immutable relay;
    ITbcFinalizedDepositVerifier public immutable finalizedVerifier;
    ITbcAuthenticatedTransitionVerifier public immutable transitionVerifier;
    ITbcInputSignatureVerifier public immutable signatureVerifier;
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
        TbcStandaloneInputAuthorization.SignatureWitness[] signatureWitnesses;
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
        ITbcHeaderRelayV2 relay_,
        ITbcFinalizedDepositVerifier finalizedVerifier_,
        ITbcAuthenticatedTransitionVerifier transitionVerifier_,
        ITbcInputSignatureVerifier signatureVerifier_,
        ITbcFtUnlockPrefixVerifierModule prefixVerifier_,
        bytes20 reserveController_
    ) {
        if (block.chainid != TARGET_CHAIN_ID) revert WrongDestinationChain(block.chainid);
        if (
            address(relay_) == address(0)
                || address(finalizedVerifier_) == address(0)
                || address(transitionVerifier_) == address(0)
                || address(signatureVerifier_) == address(0)
                || address(prefixVerifier_) == address(0)
        ) revert InvalidRouteAddress();
        if (reserveController_ == bytes20(0)) revert InvalidReserveController();
        _requireCodehash(address(relay_), RELAY_RUNTIME_CODEHASH);
        _requireCodehash(address(finalizedVerifier_), FINALIZED_RUNTIME_CODEHASH);
        _requireCodehash(address(transitionVerifier_), TRANSITION_RUNTIME_CODEHASH);
        _requireCodehash(address(signatureVerifier_), SIGNATURE_RUNTIME_CODEHASH);
        _requireCodehash(address(prefixVerifier_), PREFIX_RUNTIME_CODEHASH);

        relay = relay_;
        finalizedVerifier = finalizedVerifier_;
        transitionVerifier = transitionVerifier_;
        signatureVerifier = signatureVerifier_;
        prefixVerifier = prefixVerifier_;
        reserveController = reserveController_;
        wrappedToken = new WrappedFTV2(address(this));
    }

    /// @notice Verify a finalized TBC deposit and atomically mint its exact raw amount.
    /// @dev Any caller may relay a proof and pays this transaction's HyperEVM gas.
    function mintFromProof(MintProof calldata proof) external returns (bytes32 depositId) {
        TbcBridgeDepositVerifier.VerifiedDeposit memory finalized =
            finalizedVerifier.verifyFinalizedDeposit(
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
            transitionVerifier.verifyAuthenticatedTransition(
                proof.rawTransaction,
                proof.parentTransactions,
                proof.ancestorTransactions,
                address(this),
                reserveController
            );
        if (!_sameDeposit(authorized.deposit, finalized)) revert MismatchedVerifierResult();

        if (
            !signatureVerifier.verifyInputSignatures(
                proof.rawTransaction,
                proof.parentTransactions,
                proof.signatureWitnesses
            )
        ) revert MismatchedVerifierResult();

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
        TbcStandaloneInputAuthorization.SignatureWitness[] calldata witnesses,
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

