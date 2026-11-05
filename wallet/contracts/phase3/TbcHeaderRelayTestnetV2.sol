// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcProofVerifier} from "./TbcProofVerifier.sol";
import {TbcDifficultyVerifier} from "./TbcDifficultyVerifier.sol";
import {TbcBootstrapVerifierV2} from "./TbcBootstrapVerifierV2.sol";

/// @notice Permissionless, checkpoint-anchored TBC header relay for HyperEVM testnet.
/// @dev This contract validates headers only. It cannot mint, burn, release or move assets.
///      Pre-checkpoint DAA points must be proven against the frozen public Testnet v2 commitment.
contract TbcHeaderRelayTestnetV2 {
    uint256 public constant TARGET_CHAIN_ID = 998;
    uint256 public constant TBC_MAIN_POW_LIMIT =
        0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
    uint32 public constant CHECKPOINT_HEIGHT = 840_039;
    bytes32 public constant CHECKPOINT_HASH =
        0x000000000000005270e8447f4c71c6952ef28e40625fc58ddd38c027f5ef1cda;
    bytes32 public constant CHECKPOINT_MERKLE_ROOT =
        0x4d6188f659cc62d213cf062d817a3306521d457859af9fedd4a06bee11c15be0;
    uint32 public constant CHECKPOINT_TIME = 1_793_865_664;
    uint32 public constant CHECKPOINT_BITS = 0x1a043383;
    uint256 public constant CHECKPOINT_CHAIN_WORK =
        0x0000000000000000000000000000000000000000014f15b4de5118dc88bc13c7;
    bytes32 public constant BOOTSTRAP_COMMITMENT_ROOT =
        0x471d082663e7ce837793ab0ea19606b3dd6ea66020708f29e9987519154337c5;
    uint32 public constant MIN_CONFIRMATIONS = 6;
    uint32 public constant MAX_FUTURE_BLOCK_TIME = 20 minutes;

    struct HeaderNode {
        bytes32 parentHash;
        bytes32 merkleRoot;
        bytes32 skipHash;
        uint256 chainWork;
        uint32 height;
        uint32 time;
        uint32 bits;
        bool exists;
    }

    struct BootstrapWitness {
        TbcBootstrapVerifierV2.Point point;
        bytes32[] siblings;
    }

    mapping(bytes32 blockHash => HeaderNode) private _headers;

    bytes32 public bestTip;
    uint256 public bestChainWork;
    bool public bestWorkTie;

    error WrongDestinationChain(uint256 actual);
    error UnknownParent(bytes32 parentHash);
    error HeaderAlreadyKnown(bytes32 blockHash);
    error ObsoleteHeaderVersion(uint32 version);
    error IncorrectDifficulty(uint32 supplied, uint32 expected);
    error TimestampTooOld(uint32 supplied, uint32 medianTimePast);
    error TimestampTooNew(uint32 supplied, uint256 maximum);
    error WrongBootstrapWitnessCount(uint256 supplied, uint256 expected);
    error MissingBootstrapWitness(uint32 height);
    error InvalidBootstrapWitness(uint32 height);
    error HeightBeforeCheckpoint(uint32 height);
    error InvalidAncestorHeight(uint32 requested, uint32 available);
    error InsufficientConfirmations(uint32 supplied, uint32 minimum);

    event HeaderSubmitted(
        bytes32 indexed blockHash,
        bytes32 indexed parentHash,
        uint32 indexed height,
        uint256 chainWork
    );
    event BestChainUpdated(bytes32 indexed bestTip, uint32 height, uint256 chainWork);
    event EqualWorkTie(bytes32 indexed retainedTip, bytes32 indexed competingTip, uint256 chainWork);

    constructor() {
        if (block.chainid != TARGET_CHAIN_ID) revert WrongDestinationChain(block.chainid);
        _headers[CHECKPOINT_HASH] = HeaderNode({
            parentHash: bytes32(0),
            merkleRoot: CHECKPOINT_MERKLE_ROOT,
            skipHash: bytes32(0),
            chainWork: CHECKPOINT_CHAIN_WORK,
            height: CHECKPOINT_HEIGHT,
            time: CHECKPOINT_TIME,
            bits: CHECKPOINT_BITS,
            exists: true
        });
        bestTip = CHECKPOINT_HASH;
        bestChainWork = CHECKPOINT_CHAIN_WORK;
        emit BestChainUpdated(CHECKPOINT_HASH, CHECKPOINT_HEIGHT, CHECKPOINT_CHAIN_WORK);
    }

    /// @notice Validate and retain one TBC header extending any known branch.
    /// @param witnesses Exact pre-checkpoint DAA points required for this transition,
    ///        each authenticated against the immutable Phase 3B commitment.
    function submitHeader(bytes calldata rawHeader, BootstrapWitness[] calldata witnesses)
        external
        returns (bytes32 blockHash)
    {
        TbcProofVerifier.Header memory parsed;
        (parsed,) = TbcProofVerifier.verifyHeader(rawHeader, TBC_MAIN_POW_LIMIT);
        blockHash = parsed.blockHash;
        if (_headers[blockHash].exists) revert HeaderAlreadyKnown(blockHash);

        HeaderNode storage parent = _headers[parsed.previousBlockHash];
        if (!parent.exists) revert UnknownParent(parsed.previousBlockHash);
        // TBCNODE stores nVersion as int32_t and rejects versions below 4 here.
        if (parsed.version < 4 || parsed.version > uint32(type(int32).max)) {
            revert ObsoleteHeaderVersion(parsed.version);
        }

        TbcDifficultyVerifier.Point[] memory points =
            _difficultyPoints(parsed.previousBlockHash, witnesses);
        uint32 expectedBits = TbcDifficultyVerifier.expectedPostForkBits(
            points, parent.height, TBC_MAIN_POW_LIMIT
        );
        if (parsed.bits != expectedBits) revert IncorrectDifficulty(parsed.bits, expectedBits);

        uint32 medianTimePast = TbcDifficultyVerifier.medianTimePast(points, parent.height);
        if (parsed.time <= medianTimePast) revert TimestampTooOld(parsed.time, medianTimePast);
        uint256 maximumTime = block.timestamp + MAX_FUTURE_BLOCK_TIME;
        if (uint256(parsed.time) > maximumTime) revert TimestampTooNew(parsed.time, maximumTime);

        uint32 height = parent.height + 1;
        uint256 chainWork = parent.chainWork + TbcProofVerifier.blockWork(parsed.bits);
        uint32 skipHeight = _skipHeight(height);
        bytes32 skipHash = skipHeight >= CHECKPOINT_HEIGHT
            ? _ancestor(parsed.previousBlockHash, skipHeight)
            : bytes32(0);
        _headers[blockHash] = HeaderNode({
            parentHash: parsed.previousBlockHash,
            merkleRoot: parsed.merkleRoot,
            skipHash: skipHash,
            chainWork: chainWork,
            height: height,
            time: parsed.time,
            bits: parsed.bits,
            exists: true
        });
        emit HeaderSubmitted(blockHash, parsed.previousBlockHash, height, chainWork);
        _considerBest(blockHash, height, chainWork);
    }

    function header(bytes32 blockHash) external view returns (HeaderNode memory) {
        return _headers[blockHash];
    }

    function ancestor(bytes32 descendantHash, uint32 height) external view returns (bytes32) {
        return _ancestor(descendantHash, height);
    }

    /// @notice True only when the block is on the unique greatest-work branch and finalized.
    /// @dev Confirmation count includes the queried block, matching explorer convention.
    function isCanonical(bytes32 blockHash, uint32 requiredConfirmations)
        public
        view
        returns (bool)
    {
        if (requiredConfirmations < MIN_CONFIRMATIONS) {
            revert InsufficientConfirmations(requiredConfirmations, MIN_CONFIRMATIONS);
        }
        HeaderNode storage candidate = _headers[blockHash];
        if (!candidate.exists || bestWorkTie) return false;
        HeaderNode storage tip = _headers[bestTip];
        if (uint256(tip.height) + 1 < uint256(candidate.height) + requiredConfirmations) return false;
        return _ancestor(bestTip, candidate.height) == blockHash;
    }

    function isFinalized(bytes32 blockHash) external view returns (bool) {
        return isCanonical(blockHash, MIN_CONFIRMATIONS);
    }

    function _difficultyPoints(bytes32 parentHash, BootstrapWitness[] calldata witnesses)
        private
        view
        returns (TbcDifficultyVerifier.Point[] memory points)
    {
        uint32 previousHeight = _headers[parentHash].height;
        uint32[27] memory heights;
        heights[0] = previousHeight - 8_064;
        heights[1] = previousHeight - 146;
        heights[2] = previousHeight - 145;
        heights[3] = previousHeight - 144;
        for (uint32 offset; offset < 23; ++offset) heights[4 + offset] = previousHeight - 22 + offset;

        uint256 bootstrapCount;
        for (uint256 index; index < heights.length; ++index) {
            if (heights[index] < CHECKPOINT_HEIGHT) ++bootstrapCount;
        }
        if (witnesses.length != bootstrapCount) {
            revert WrongBootstrapWitnessCount(witnesses.length, bootstrapCount);
        }

        points = new TbcDifficultyVerifier.Point[](heights.length);
        for (uint256 index; index < heights.length; ++index) {
            uint32 requestedHeight = heights[index];
            if (requestedHeight < CHECKPOINT_HEIGHT) {
                BootstrapWitness calldata witness = _findWitness(witnesses, requestedHeight);
                if (!TbcBootstrapVerifierV2.verify(witness.point, witness.siblings)) {
                    revert InvalidBootstrapWitness(requestedHeight);
                }
                points[index] = TbcDifficultyVerifier.Point({
                    height: witness.point.height,
                    time: witness.point.time,
                    bits: witness.point.bits,
                    chainWork: witness.point.chainWork
                });
            } else {
                bytes32 pointHash = _ancestor(parentHash, requestedHeight);
                HeaderNode storage point = _headers[pointHash];
                points[index] = TbcDifficultyVerifier.Point({
                    height: point.height,
                    time: point.time,
                    bits: point.bits,
                    chainWork: point.chainWork
                });
            }
        }
    }

    function _findWitness(BootstrapWitness[] calldata witnesses, uint32 height)
        private
        pure
        returns (BootstrapWitness calldata witness)
    {
        for (uint256 index; index < witnesses.length; ++index) {
            if (witnesses[index].point.height == height) return witnesses[index];
        }
        revert MissingBootstrapWitness(height);
    }

    function _considerBest(bytes32 blockHash, uint32 height, uint256 chainWork) internal {
        if (chainWork > bestChainWork) {
            bestTip = blockHash;
            bestChainWork = chainWork;
            bestWorkTie = false;
            emit BestChainUpdated(blockHash, height, chainWork);
        } else if (chainWork == bestChainWork && blockHash != bestTip) {
            bestWorkTie = true;
            emit EqualWorkTie(bestTip, blockHash, chainWork);
        }
    }

    function _ancestor(bytes32 descendantHash, uint32 requestedHeight)
        private
        view
        returns (bytes32 cursorHash)
    {
        HeaderNode storage descendant = _headers[descendantHash];
        if (!descendant.exists) revert UnknownParent(descendantHash);
        if (requestedHeight < CHECKPOINT_HEIGHT) revert HeightBeforeCheckpoint(requestedHeight);
        if (requestedHeight > descendant.height) {
            revert InvalidAncestorHeight(requestedHeight, descendant.height);
        }

        cursorHash = descendantHash;
        uint32 cursorHeight = descendant.height;
        while (cursorHeight > requestedHeight) {
            HeaderNode storage cursor = _headers[cursorHash];
            uint32 skip = _skipHeight(cursorHeight);
            uint32 previousSkip = _skipHeight(cursorHeight - 1);
            if (
                cursor.skipHash != bytes32(0)
                    && (skip == requestedHeight
                        || (skip > requestedHeight
                            && !(previousSkip < skip - 2 && previousSkip >= requestedHeight)))
            ) {
                cursorHash = cursor.skipHash;
                cursorHeight = skip;
            } else {
                cursorHash = cursor.parentHash;
                --cursorHeight;
            }
        }
    }

    function _skipHeight(uint32 height) private pure returns (uint32) {
        if (height < 2) return 0;
        if ((height & 1) == 1) return _invertLowestOne(_invertLowestOne(height - 1)) + 1;
        return _invertLowestOne(height);
    }

    function _invertLowestOne(uint32 value) private pure returns (uint32) {
        // C++ unsigned arithmetic wraps for zero; returning zero is the same
        // result and keeps skip construction defined at power-of-two boundaries.
        if (value == 0) return 0;
        return value & (value - 1);
    }
}

