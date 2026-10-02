// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPulseCore} from "../interfaces/IPulseCore.sol";
import {PulseMath} from "./PulseMath.sol";

/// @notice Stateless, public Pulse V1 calculations. Applications own all auction state.
contract PulseCoreV1 is IPulseCore {
    function initialize(Config calldata config, uint64 startTime)
        external
        pure
        override
        returns (State memory initialState)
    {
        return PulseMath.initialize(config, startTime);
    }

    function quote(Config calldata config, State calldata state, uint64 timestamp)
        external
        pure
        override
        returns (uint256 ask)
    {
        return PulseMath.quote(config, state, timestamp);
    }

    function advance(Config calldata config, State calldata state, uint64 timestamp)
        external
        pure
        override
        returns (uint256 ask, State memory nextState)
    {
        return PulseMath.advance(config, state, timestamp);
    }

    function version() external pure override returns (bytes32 versionId) {
        return keccak256("pulse-core/1.0.0");
    }
}
