// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SignatureRendererCandidate} from "../src/experimental/SignatureRendererCandidate.sol";

interface RendererVm { function expectRevert(bytes4) external; }

/// @dev Oracle hashes were read from the unchanged locked TypeScript renderer,
/// itself checked against vendored Python goldens. Never bless candidate output.
contract SignatureRendererCandidateTest {
    RendererVm constant vm = RendererVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    SignatureRendererCandidate renderer;
    function setUp() public { renderer = new SignatureRendererCandidate(); }
    function same(string memory handle, string memory mbti, bytes32 oracle) private view {
        require(keccak256(bytes(renderer.render(handle, mbti))) == oracle, "locked oracle byte mismatch");
    }
    function testSingleCharacter() public view {
        same("x", "ENFP", 0x8ac9063c7b67d6512a639cc640a1bf00309a0762ce075bb036cf12d1017bd423);
    }
    function testSampledOutline() public view {
        same("karpathy", "INTJ", 0x07d6690739255c8f5ab55d8b99c100b99f17baef9229b53989a076a3e5016a48);
    }
    function testCaseAndUnderscores() public view {
        same("Alice_Bob_Key", "INFP", 0x672526df3a5df22195bc927c706c1220362f69b72f433599f392b172d8ee419f);
    }
    function testMaximumUppercase() public view {
        same("ABCDEFGHIJKLMNO", "ENTP", 0x5ad069df090f699aa3fe5912f92aa571bc0e72542a9788d05d87ed20c951cbcd);
    }
    function testMaximumDigits() public view {
        same("012345678901234", "ISTJ", 0x8f4487ffbe0a1ba5849e4aa6f614f55064017e0997346e28ebcc63396c712035);
    }
    function testZeroWidthUnderscores() public view {
        same("_______________", "ISFJ", 0x817761516f98ed0dab5579003df74e508de284bef91ff2044190c08d2be3811b);
    }
    function testCaseIsNotCanonicalizedForArtwork() public view {
        same("a", "ISFJ", 0xc150ad7600bedc1619b3e3c0c8299460f770dbffbfa482b66f5779f0423b7a2e);
        same("A", "ISFJ", 0x007fb00a97be9f94621bdc035bba4cf05f14d34f5a15f5962017ee4b5032e0f5);
    }
    function testInvalidHandleLengths() public {
        vm.expectRevert(SignatureRendererCandidate.InvalidInput.selector); renderer.render("", "INTJ");
        vm.expectRevert(SignatureRendererCandidate.InvalidInput.selector); renderer.render("abcdefghijklmnop", "INTJ");
    }
    function testInvalidIdentityAndXmlInjection() public {
        vm.expectRevert(SignatureRendererCandidate.InvalidInput.selector); renderer.render("@alice", "INTJ");
        vm.expectRevert(SignatureRendererCandidate.InvalidInput.selector); renderer.render("a\n", "INTJ");
        vm.expectRevert(SignatureRendererCandidate.InvalidInput.selector); renderer.render("<script>", "INTJ");
        vm.expectRevert(SignatureRendererCandidate.InvalidInput.selector); renderer.render(unicode"爱", "INTJ");
    }
    function testInvalidMbti() public {
        vm.expectRevert(SignatureRendererCandidate.InvalidInput.selector); renderer.render("alice", "XXXX");
        vm.expectRevert(SignatureRendererCandidate.InvalidInput.selector); renderer.render("alice", "INTJx");
        vm.expectRevert(SignatureRendererCandidate.InvalidInput.selector); renderer.render("alice", "");
    }
    function testFuzzRejectNonHandleBytes(uint8 character) public {
        if ((character >= 65 && character <= 90) || (character >= 97 && character <= 122)
            || (character >= 48 && character <= 57) || character == 95) return;
        vm.expectRevert(SignatureRendererCandidate.InvalidInput.selector);
        renderer.render(string(abi.encodePacked(bytes1(character))), "INTJ");
    }
    function testRuntimeSizeAndExperimentalIdentity() public view {
        require(address(renderer).code.length <= 24576, "EIP170");
        require(keccak256(bytes(renderer.VERSION())) == keccak256("experimental-fixed18-not-locked"));
    }
}
