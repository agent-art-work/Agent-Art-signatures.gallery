// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPulseCore} from "../interfaces/IPulseCore.sol";

/// @dev V1 integer curve and domain checks. All inputs come from the caller.
library PulseMath {
    function initialize(IPulseCore.Config calldata config, uint64 startTime)
        internal
        pure
        returns (IPulseCore.State memory initialState)
    {
        _validateConfig(config);

        uint256 initialDistance = config.k / (config.genesisPrice - config.genesisFloor);
        uint256 transitionDistance = config.k / config.pts;
        uint256 minimumExclusive = initialDistance > transitionDistance
            ? initialDistance
            : transitionDistance;
        if (uint256(startTime) <= minimumExclusive) {
            revert IPulseCore.StartTimeTooEarly(startTime, minimumExclusive);
        }

        // The comparison above proves the offset fits uint64 and is strictly
        // smaller than startTime; the resulting anchor is positive.
        initialState = IPulseCore.State({
            epochIndex: 0,
            openTime: startTime,
            curveStartTime: startTime,
            anchorTime: startTime - uint64(initialDistance),
            floorPrice: config.genesisFloor
        });
        _priceAt(config.k, initialState.floorPrice, initialState.anchorTime, startTime);
    }

    function quote(IPulseCore.Config calldata config, IPulseCore.State calldata state, uint64 timestamp)
        internal
        pure
        returns (uint256 ask)
    {
        _validateState(config, state);
        if (state.epochIndex == 0) {
            if (timestamp < state.openTime) timestamp = state.openTime;
        } else if (timestamp < state.curveStartTime) {
            revert IPulseCore.TimestampBeforeEpoch(timestamp, state.curveStartTime);
        }
        return _priceAt(config.k, state.floorPrice, state.anchorTime, timestamp);
    }

    function advance(IPulseCore.Config calldata config, IPulseCore.State calldata state, uint64 timestamp)
        internal
        pure
        returns (uint256 ask, IPulseCore.State memory nextState)
    {
        _validateState(config, state);
        if (timestamp < state.curveStartTime) {
            revert IPulseCore.TimestampBeforeEpoch(timestamp, state.curveStartTime);
        }
        if (state.epochIndex == type(uint64).max) revert IPulseCore.EpochOverflow();

        ask = _priceAt(config.k, state.floorPrice, state.anchorTime, timestamp);
        uint256 elapsed = uint256(timestamp) - uint256(state.curveStartTime);
        uint256 premium = (elapsed == 0 ? 1 : elapsed) * config.pts;

        // Preserve the legacy ask + premium rejection, even though only the
        // premium is needed to derive the new anchor.
        if (premium > type(uint256).max - ask) revert IPulseCore.TargetPriceOverflow();

        // initialize() established openTime > k / pts. Since premium >= pts
        // and timestamp >= openTime, this subtraction cannot underflow.
        uint64 nextAnchor = timestamp - uint64(config.k / premium);
        nextState = IPulseCore.State({
            epochIndex: state.epochIndex + 1,
            openTime: state.openTime,
            curveStartTime: timestamp,
            anchorTime: nextAnchor,
            floorPrice: ask
        });
        _priceAt(config.k, nextState.floorPrice, nextAnchor, timestamp);
    }

    function _validateConfig(IPulseCore.Config calldata config) private pure {
        if (config.k == 0) revert IPulseCore.InvalidCurveK();
        if (config.genesisPrice <= config.genesisFloor) revert IPulseCore.InvalidGenesisPrices();
        if (config.genesisPrice - config.genesisFloor > config.k) {
            revert IPulseCore.GenesisGapExceedsK();
        }
        if (config.pts == 0 || config.pts > type(uint128).max) revert IPulseCore.InvalidPts();
        if (config.k / config.pts > type(uint64).max) revert IPulseCore.TimeScaleOutOfRange();
    }

    function _validateState(IPulseCore.Config calldata config, IPulseCore.State calldata state)
        private
        pure
    {
        IPulseCore.State memory initialState = initialize(config, state.openTime);
        if (
            state.curveStartTime < state.openTime || state.anchorTime == 0
                || state.anchorTime > state.curveStartTime || state.floorPrice < config.genesisFloor
        ) revert IPulseCore.InvalidState();

        if (
            state.epochIndex == 0
                && (
                    state.curveStartTime != initialState.curveStartTime
                        || state.anchorTime != initialState.anchorTime
                        || state.floorPrice != initialState.floorPrice
                )
        ) revert IPulseCore.InvalidState();

        _priceAt(config.k, state.floorPrice, state.anchorTime, state.curveStartTime);
    }

    function _priceAt(uint256 k, uint256 floorPrice, uint64 anchorTime, uint64 timestamp)
        private
        pure
        returns (uint256 ask)
    {
        uint256 increment = timestamp <= anchorTime ? k : k / uint256(timestamp - anchorTime);
        if (increment > type(uint256).max - floorPrice) revert IPulseCore.PriceOverflow();
        return floorPrice + increment;
    }
}
