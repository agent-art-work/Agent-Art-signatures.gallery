// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

contract PulseAllowlistVectorsTest {
    bytes32 constant ROOT = 0xd56fcadc336e04d31a7146c6472fd61dc315e9dd74f8b56b7b25166b4402b36a;
    address constant WALLET_A = 0x1111111111111111111111111111111111111111;
    address constant WALLET_B = 0x2222222222222222222222222222222222222222;

    function leaf(uint256 slotId, address wallet) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(slotId, wallet))));
    }

    function testDuplicateWalletSlotsHaveDifferentValidProofs() public pure {
        bytes32[] memory proof0 = new bytes32[](2);
        proof0[0] = 0x7b4e4429a12d7c7f52f97ac3310a7f766c8a424a830a3b5423010430bc468c18;
        proof0[1] = 0xd24381ffdbca19327cb0117d15c0a6fbb005d98ac3206a50e7b6485de726f89c;
        bytes32[] memory proof2 = new bytes32[](1);
        proof2[0] = 0x3240c86f751f8d996187613ec9d2dfe7a6d0155da0b13a82d05b94ea59838d94;
        bytes32[] memory proof1 = new bytes32[](2);
        proof1[0] = 0x53d1ea11c02bccf00efa13950923d7ec0991024794dcc0a5de4788c13baf062c;
        proof1[1] = 0xd24381ffdbca19327cb0117d15c0a6fbb005d98ac3206a50e7b6485de726f89c;
        require(leaf(0, WALLET_A) == 0x53d1ea11c02bccf00efa13950923d7ec0991024794dcc0a5de4788c13baf062c);
        require(leaf(0, WALLET_A) != leaf(2, WALLET_A));
        require(MerkleProof.verify(proof0, ROOT, leaf(0, WALLET_A)));
        require(MerkleProof.verify(proof1, ROOT, leaf(1, WALLET_B)));
        require(MerkleProof.verify(proof2, ROOT, leaf(2, WALLET_A)));
        require(!MerkleProof.verify(proof0, ROOT, leaf(0, WALLET_B)));
        require(!MerkleProof.verify(proof2, ROOT, leaf(0, WALLET_A)));
    }
}
