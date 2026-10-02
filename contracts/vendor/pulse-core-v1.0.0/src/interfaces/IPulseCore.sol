// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Public stateless Pulse calculation interface, semantics version 1.0.0.
/// @dev Applications own configuration, state, time, payments, delivery and events.
///      Normative domain, rounding and error precedence: docs/evm/pulse-core-api.md.
interface IPulseCore {
    /// @dev Prices use raw payment units; time uses integer seconds. Field order is frozen.
    struct Config {
        uint256 k; // Price units * seconds.
        uint256 genesisPrice; // Anchor target, not necessarily the exact opening quote.
        uint256 genesisFloor;
        uint256 pts; // Price units / second; accepted range is 1..uint128.max.
    }

    /// @dev Caller-supplied curve snapshot. Does not establish authentic sale history.
    struct State {
        uint64 epochIndex;
        uint64 openTime;
        uint64 curveStartTime;
        uint64 anchorTime;
        uint256 floorPrice;
    }

    error InvalidCurveK();
    error InvalidGenesisPrices();
    error GenesisGapExceedsK();
    error InvalidPts();
    error TimeScaleOutOfRange();
    error StartTimeTooEarly(uint64 startTime, uint256 minimumExclusive);
    error InvalidState();
    error TimestampBeforeEpoch(uint64 timestamp, uint64 curveStartTime);
    error PriceOverflow();
    error TargetPriceOverflow();
    error EpochOverflow();

    /// @notice Calculate epoch 0 at startTime; repeatable, without activating an application.
    /// @dev Validates launch anchors and representability of the opening quote.
    ///      Does not guarantee that a subsequent advance will fit finite price bounds.
    function initialize(Config calldata config, uint64 startTime)
        external
        pure
        returns (State memory initialState);

    /// @notice Calculate an ask from supplied inputs, without reading application state.
    /// @dev Epoch 0 pins pre-open timestamps to openTime. Later epochs reject timestamps
    ///      before curveStartTime. Integer rounding and the anchor clamp are preserved.
    function quote(Config calldata config, State calldata state, uint64 timestamp)
        external
        pure
        returns (uint256 ask);

    /// @notice Calculate the current ask and the state following one hypothetical sale.
    /// @dev Rejects pre-epoch timestamps. Preserves checked ask + premium even though
    ///      the next-anchor formula can be expressed using premium alone. No sale occurs.
    function advance(Config calldata config, State calldata state, uint64 timestamp)
        external
        pure
        returns (uint256 ask, State memory nextState);

    /// @notice Return keccak256(bytes("pulse-core/1.0.0")).
    /// @dev Release identifier only; verify deployment chain, address and runtime code hash.
    function version() external pure returns (bytes32 versionId);
}
