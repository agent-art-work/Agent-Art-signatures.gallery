// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OnchainSignatures} from "../src/OnchainSignatures.sol";
import {ImmutableSvg} from "../src/ImmutableSvg.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

interface OnchainVm {
    function addr(uint256 key) external returns (address);
    function sign(uint256 key, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function prank(address sender) external;
    function expectRevert() external;
    function expectRevert(bytes4 error_) external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 id) external;
    function etch(address target, bytes calldata code) external;
}

contract SvgStoreHarness {
    function write(bytes memory value) external returns (address) { return ImmutableSvg.write(value); }
    function read(address pointer) external view returns (bytes memory) { return ImmutableSvg.read(pointer); }
}

/// @dev Explicit comparison baseline, never used by the application.
contract OnchainStorageBaseline {
    mapping(uint256 => string) public svg;
    function store(uint256 id, string calldata value) external { svg[id] = value; }
}

contract OnchainSignaturesTest {
    OnchainVm constant vm = OnchainVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant ADMIN = address(0xa001);
    address constant MANAGER = address(0xa002);
    address constant PAUSER = address(0xa003);
    address constant REVOKER = address(0xa004);
    address constant RECIPIENT = address(0xb001);
    uint256 constant SIGNER_KEY = 1;
    OnchainSignatures gallery;
    string constant SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>';

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1_800_000_060);
        gallery = new OnchainSignatures("Signatures Gallery", "SG", 48 hours, ADMIN, MANAGER, PAUSER, REVOKER, vm.addr(SIGNER_KEY));
    }
    function art() internal pure returns (OnchainSignatures.ArtworkInput memory) {
        return OnchainSignatures.ArtworkInput("Alice_Bob_Key", "INTJ", SVG);
    }
    function authorization(OnchainSignatures.ArtworkInput memory value) internal view returns (OnchainSignatures.OpenMintAuthorization memory a) {
        a.handleKey = gallery.handleKey("alice_bob_key");
        a.assessmentDigest = keccak256("offline-test-not-real-Grok");
        a.recipient = RECIPIENT;
        a.tokenURIHash = keccak256(bytes(gallery.metadataURI(value.renderHandle, value.mbti, value.svg, a.assessmentDigest)));
        a.artifactDigest = gallery.artifactDigest("alice_bob_key", value.renderHandle, value.mbti, a.assessmentDigest, sha256(bytes(value.svg)), a.tokenURIHash);
        a.nonce = keccak256("nonce"); a.issuedAt = 1_800_000_000; a.deadline = 1_800_000_900;
    }
    function signature(OnchainSignatures.OpenMintAuthorization memory a) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, gallery.authorizationDigest(a));
        return abi.encodePacked(r, s, v);
    }
    function mint() internal returns (uint256) {
        OnchainSignatures.ArtworkInput memory value = art();
        OnchainSignatures.OpenMintAuthorization memory a = authorization(value);
        bytes memory sig = signature(a);
        vm.prank(RECIPIENT);
        return gallery.mint("alice_bob_key", a, value, sig);
    }
    function reject(OnchainSignatures.OpenMintAuthorization memory a, OnchainSignatures.ArtworkInput memory value, bytes4 error_) internal {
        bytes memory sig = signature(a);
        vm.expectRevert(error_); vm.prank(a.recipient);
        gallery.mint("alice_bob_key", a, value, sig);
    }
    function testOnchainRecoveryWithoutAnyWebsiteOrFile() public {
        uint256 id = mint();
        require(keccak256(bytes(gallery.svg(id))) == keccak256(bytes(SVG)), "exact SVG");
        (address data, string memory handle, string memory mbti) = gallery.artwork(id);
        require(data.code.length == bytes(SVG).length + 1 && data.code[0] == 0, "STOP-prefixed state");
        require(keccak256(bytes(handle)) == keccak256("Alice_Bob_Key"), "case preserved");
        require(keccak256(bytes(mbti)) == keccak256("INTJ"), "MBTI saved");
        require(keccak256(bytes(gallery.tokenURI(id))) == authorization(art()).tokenURIHash, "self-contained URI");
        (bool ok,) = data.call(hex"ffffffff"); require(ok, "data contract only stops");
        require(keccak256(bytes(gallery.svg(id))) == keccak256(bytes(SVG)), "cannot modify data");
    }
    function testNoExternalTokenURIEntryPoint() public {
        vm.prank(RECIPIENT);
        (bool ok,) = address(gallery).call(abi.encodeWithSignature(
            "mint(string,(bytes32,bytes32,bytes32,address,bytes32,bytes32,uint64,uint64),string,bytes)",
            "alice_bob_key", authorization(art()), "https://example.com/mutable.json", hex"00"));
        require(!ok, "legacy external URI entry point disabled");
    }
    function testCollectionMetadataSelfContained() public view {
        string memory expected = string.concat("data:application/json;base64,", Base64.encode(bytes(
            '{"name":"Signatures Gallery","description":"Fully on-chain signature artwork. One token per canonical X handle."}'
        )));
        require(keccak256(bytes(gallery.contractURI())) == keccak256(bytes(expected)), "collection is on-chain");
    }
    function testNonexistentTokenCannotReadArtwork() public {
        vm.expectRevert(); gallery.svg(123);
        vm.expectRevert(); gallery.tokenURI(123);
    }
    function testTransferAndPauseDoNotChangeArtwork() public {
        uint256 id = mint(); bytes32 uri = keccak256(bytes(gallery.tokenURI(id)));
        vm.prank(PAUSER); gallery.pauseMinting();
        vm.prank(RECIPIENT); gallery.transferFrom(RECIPIENT, address(0xc001), id);
        require(gallery.ownerOf(id) == address(0xc001), "transfer allowed");
        require(keccak256(bytes(gallery.tokenURI(id))) == uri, "unchanged URI");
        vm.prank(PAUSER); vm.expectRevert(); gallery.unpauseMinting();
        vm.prank(ADMIN); gallery.unpauseMinting();
    }
    function testOneHandleNotOneHandleTimesMbti() public {
        mint();
        OnchainSignatures.ArtworkInput memory value = art(); value.mbti = "ENFP";
        OnchainSignatures.OpenMintAuthorization memory a = authorization(value); a.nonce = keccak256("second");
        reject(a, value, OnchainSignatures.HandleAlreadyMinted.selector);
    }
    function testTamperedSvgMbtiCaseAndAssessmentFail() public {
        OnchainSignatures.ArtworkInput memory value = art();
        OnchainSignatures.OpenMintAuthorization memory a = authorization(value);
        value.svg = '<svg/>'; reject(a, value, OnchainSignatures.TokenURIHashMismatch.selector);
        value = art(); value.mbti = "ENTJ"; reject(a, value, OnchainSignatures.TokenURIHashMismatch.selector);
        value = art(); value.renderHandle = "alice_bob_key"; reject(a, value, OnchainSignatures.TokenURIHashMismatch.selector);
        value = art(); a.assessmentDigest = keccak256("other"); reject(a, value, OnchainSignatures.TokenURIHashMismatch.selector);
    }
    function testArtifactBindingCheckedOnchain() public {
        OnchainSignatures.OpenMintAuthorization memory a = authorization(art());
        a.artifactDigest = keccak256("fake"); reject(a, art(), OnchainSignatures.ArtifactDigestMismatch.selector);
    }
    function testInvalidHandleAndMbti() public {
        OnchainSignatures.ArtworkInput memory value = art();
        OnchainSignatures.OpenMintAuthorization memory a = authorization(value);
        value.renderHandle = "Bob"; reject(a, value, OnchainSignatures.HandleKeyMismatch.selector);
        value.renderHandle = 'Alice"'; reject(a, value, OnchainSignatures.InvalidHandle.selector);
        value = art(); value.mbti = "intj"; reject(a, value, OnchainSignatures.InvalidArtwork.selector);
        value.mbti = "INTJx"; reject(a, value, OnchainSignatures.InvalidArtwork.selector);
    }
    function testBoundedSvgAndAtomicFailure() public {
        OnchainSignatures.OpenMintAuthorization memory a = authorization(art());
        OnchainSignatures.ArtworkInput memory value = art(); value.svg = "";
        reject(a, value, OnchainSignatures.InvalidArtwork.selector);
        value.svg = string(new bytes(16_385)); reject(a, value, OnchainSignatures.InvalidArtwork.selector);
        require(!gallery.usedNonces(a.nonce) && !gallery.mintedHandle(a.handleKey), "guards unchanged");
    }
    function testAuthorizationGuards() public {
        OnchainSignatures.OpenMintAuthorization memory a = authorization(art());
        a.deadline = 1_800_000_050; reject(a, art(), OnchainSignatures.AuthorizationExpired.selector);
        a = authorization(art()); a.issuedAt = 1_800_000_061; reject(a, art(), OnchainSignatures.AuthorizationNotActive.selector);
        a = authorization(art()); a.deadline = a.issuedAt + 901; reject(a, art(), OnchainSignatures.InvalidAuthorizationWindow.selector);
        a = authorization(art()); a.nonce = bytes32(0); reject(a, art(), OnchainSignatures.ZeroCommitment.selector);
        a = authorization(art());
        vm.prank(REVOKER); gallery.revokeNonce(a.nonce);
        reject(a, art(), OnchainSignatures.NonceUnavailable.selector);
    }
    function testWrongSignerRecipientAndChain() public {
        OnchainSignatures.OpenMintAuthorization memory a = authorization(art()); bytes memory sig = signature(a);
        vm.expectRevert(OnchainSignatures.WrongRecipient.selector); vm.prank(address(0xc001));
        gallery.mint("alice_bob_key", a, art(), sig);
        vm.chainId(11155111);
        vm.expectRevert(OnchainSignatures.InvalidAttestation.selector); vm.prank(RECIPIENT);
        gallery.mint("alice_bob_key", a, art(), sig);
        vm.chainId(31337); vm.prank(MANAGER); gallery.setTrustedAuthorizer(vm.addr(2));
        vm.expectRevert(OnchainSignatures.InvalidAttestation.selector); vm.prank(RECIPIENT);
        gallery.mint("alice_bob_key", a, art(), sig);
    }
    function testDomainDistinctFromLegacy() public view {
        (, string memory name, string memory version,,,,) = gallery.eip712Domain();
        require(keccak256(bytes(name)) == keccak256("SignaturesOnchainMint"), "distinct signing domain");
        require(keccak256(bytes(version)) == keccak256("1"), "version");
    }
    function testFuzzDataRoundTrip(bytes memory value) public {
        if (value.length == 0 || value.length > 16_384) return;
        SvgStoreHarness store = new SvgStoreHarness();
        address pointer = store.write(value);
        require(keccak256(store.read(pointer)) == keccak256(value), "all bytes preserved");
    }
    function testDataSizeBounds() public {
        SvgStoreHarness store = new SvgStoreHarness();
        vm.expectRevert(ImmutableSvg.InvalidSvgSize.selector); store.write(new bytes(0));
        vm.expectRevert(ImmutableSvg.InvalidSvgSize.selector); store.write(new bytes(16_385));
        address pointer = store.write(new bytes(16_384));
        require(store.read(pointer).length == 16_384, "maximum supported");
        vm.expectRevert(ImmutableSvg.MissingSvg.selector); store.read(address(0));
    }
}
