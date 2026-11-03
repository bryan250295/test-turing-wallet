// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TbcProofVerifier} from "./TbcProofVerifier.sol";

/// @notice Exact arithmetic for TBCNODE v3.3.1's post-fork main-parameter DAA.
/// @dev Points passed here must be authenticated by a header relay. This pure
///      library deliberately does not treat relayer-supplied context as trusted.
library TbcDifficultyVerifier {
    uint32 internal constant MAIN_TARGET_SPACING_SECONDS = 600;
    uint32 internal constant POST_FORK_SPACING_WINDOW = 8_064;
    uint32 internal constant DAA_WORK_WINDOW = 144;
    uint32 internal constant POST_FORK_FIRST_PARENT_HEIGHT = 824_189;

    struct Point {
        uint32 height;
        uint32 time;
        uint32 bits;
        uint256 chainWork;
    }

    error MissingDifficultyPoint(uint32 height);
    error DuplicateDifficultyPoint(uint32 height);
    error InvalidDifficultyPoint(uint32 height);
    error InvalidPreviousHeight(uint32 height);
    error InvalidSpacingAncestor();
    error InvalidWorkWindow();
    error PreviousTargetAbovePowLimit();

    function expectedPostForkBits(Point[] memory points, uint32 previousHeight, uint256 powLimit)
        internal
        pure
        returns (uint32)
    {
        if (previousHeight < POST_FORK_FIRST_PARENT_HEIGHT) revert InvalidPreviousHeight(previousHeight);
        assertNoDuplicateHeights(points);

        Point memory last = suitablePoint(points, previousHeight);
        Point memory first = suitablePoint(points, previousHeight - DAA_WORK_WINDOW);
        uint32 spacing = targetSpacing(
            lookup(points, previousHeight),
            lookup(points, previousHeight - POST_FORK_SPACING_WINDOW)
        );
        uint256 nextTarget = workWindowTarget(first, last, spacing);

        return boundNextTarget(points, previousHeight, powLimit, nextTarget);
    }

    function boundNextTarget(
        Point[] memory points,
        uint32 previousHeight,
        uint256 powLimit,
        uint256 nextTarget
    ) private pure returns (uint32) {
        Point memory previous = lookup(points, previousHeight);

        (uint256 previousTarget, bool negative, bool overflowed) =
            TbcProofVerifier.decodeCompactTarget(previous.bits);
        if (negative || overflowed || previousTarget == 0) revert InvalidDifficultyPoint(previous.height);
        if (previousTarget > powLimit) revert PreviousTargetAbovePowLimit();

        uint256 delta = previousTarget >> 4;
        uint256 upper = delta >= powLimit - previousTarget ? powLimit : previousTarget + delta;
        uint256 lower = previousTarget - delta;
        if (nextTarget > upper) nextTarget = upper;
        else if (
            uint256(medianTimePast(points, previousHeight))
                > uint256(medianTimePast(points, previousHeight - 12)) + 6 hours
        ) nextTarget = upper;
        else if (nextTarget < lower) nextTarget = lower;
        return TbcProofVerifier.encodeCompactTarget(nextTarget);
    }

    function targetSpacing(Point memory previous, Point memory windowAncestor)
        internal
        pure
        returns (uint32)
    {
        if (
            previous.height < windowAncestor.height
                || previous.height - windowAncestor.height != POST_FORK_SPACING_WINDOW
                || previous.time < windowAncestor.time
        ) revert InvalidSpacingAncestor();
        uint256 promisedBlocks = (previous.time - windowAncestor.time) / MAIN_TARGET_SPACING_SECONDS;
        if (promisedBlocks <= POST_FORK_SPACING_WINDOW) return MAIN_TARGET_SPACING_SECONDS;
        uint256 maximum = uint256(POST_FORK_SPACING_WINDOW) * 2;
        if (promisedBlocks > maximum) promisedBlocks = maximum;
        return uint32(uint256(MAIN_TARGET_SPACING_SECONDS) * POST_FORK_SPACING_WINDOW / promisedBlocks);
    }

    function workWindowTarget(Point memory first, Point memory last, uint32 spacing)
        internal
        pure
        returns (uint256)
    {
        if (spacing == 0 || last.height <= first.height || last.chainWork <= first.chainWork) {
            revert InvalidWorkWindow();
        }
        uint256 work = last.chainWork - first.chainWork;
        unchecked {
            // TBCNODE performs this multiplication in arith_uint256.
            work *= spacing;
        }
        int256 actualTimespan = int256(uint256(last.time)) - int256(uint256(first.time));
        int256 minimum = int256(uint256(72 * spacing));
        int256 maximum = int256(uint256(288 * spacing));
        if (actualTimespan < minimum) actualTimespan = minimum;
        else if (actualTimespan > maximum) actualTimespan = maximum;
        work /= uint256(actualTimespan);
        if (work == 0) revert InvalidWorkWindow();
        return (type(uint256).max - work + 1) / work;
    }

    function suitablePoint(Point[] memory points, uint32 height) internal pure returns (Point memory) {
        Point[3] memory blocks = [lookup(points, height - 2), lookup(points, height - 1), lookup(points, height)];
        if (blocks[0].time > blocks[2].time) (blocks[0], blocks[2]) = (blocks[2], blocks[0]);
        if (blocks[0].time > blocks[1].time) (blocks[0], blocks[1]) = (blocks[1], blocks[0]);
        if (blocks[1].time > blocks[2].time) (blocks[1], blocks[2]) = (blocks[2], blocks[1]);
        return blocks[1];
    }

    function medianTimePast(Point[] memory points, uint32 height) internal pure returns (uint32) {
        uint32[11] memory times;
        uint256 count;
        uint32 cursor = height;
        while (count < 11) {
            times[count++] = lookup(points, cursor).time;
            if (cursor == 0) break;
            --cursor;
        }
        for (uint256 index = 1; index < count; ++index) {
            uint32 value = times[index];
            uint256 position = index;
            while (position > 0 && times[position - 1] > value) {
                times[position] = times[position - 1];
                --position;
            }
            times[position] = value;
        }
        return times[count / 2];
    }

    function lookup(Point[] memory points, uint32 height) internal pure returns (Point memory found) {
        bool exists;
        for (uint256 index; index < points.length; ++index) {
            if (points[index].height == height) {
                found = points[index];
                exists = true;
                break;
            }
        }
        if (!exists) revert MissingDifficultyPoint(height);
        (uint256 target, bool negative, bool overflowed) = TbcProofVerifier.decodeCompactTarget(found.bits);
        if (negative || overflowed || target == 0) revert InvalidDifficultyPoint(height);
    }

    function assertNoDuplicateHeights(Point[] memory points) private pure {
        for (uint256 left; left < points.length; ++left) {
            for (uint256 right = left + 1; right < points.length; ++right) {
                if (points[left].height == points[right].height) {
                    revert DuplicateDifficultyPoint(points[left].height);
                }
            }
        }
    }
}
