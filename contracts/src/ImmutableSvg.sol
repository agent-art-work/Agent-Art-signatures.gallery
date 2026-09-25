// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Runtime starts with STOP; subsequent bytes are inert artwork, not code
/// that can be reached through a call. No updater, proxy or selfdestruct exists.
contract SvgData {
    constructor(bytes memory data) {
        bytes memory runtime = abi.encodePacked(hex"00", data);
        assembly ("memory-safe") {
            return(add(runtime, 32), mload(runtime))
        }
    }
}

library ImmutableSvg {
    error InvalidSvgSize();
    error MissingSvg();

    function write(bytes memory data) internal returns (address pointer) {
        // Leave substantial room beneath EIP-170's 24,576-byte limit.
        if (data.length == 0 || data.length > 16_384) revert InvalidSvgSize();
        pointer = address(new SvgData(data));
    }

    function read(address pointer) internal view returns (bytes memory data) {
        uint256 size = pointer.code.length;
        if (size < 2 || size > 16_385) revert MissingSvg();
        data = new bytes(size - 1);
        assembly ("memory-safe") {
            extcodecopy(pointer, add(data, 32), 1, sub(size, 1))
        }
    }
}
