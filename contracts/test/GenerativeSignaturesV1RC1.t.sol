// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {GenerativeSignaturesV1RC1 as Gallery} from "../src/release/GenerativeSignaturesV1RC1.sol";
import {SignatureRendererV1RC1} from "../src/release/SignatureRendererV1RC1.sol";
import {SignatureRendererCandidate} from "../src/experimental/SignatureRendererCandidate.sol";

interface ReleaseGenerativeVm {
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function warp(uint256) external;
    function chainId(uint256) external;
    function mockCallRevert(address, bytes calldata, bytes calldata) external;
    function clearMockedCalls() external;
    function getNonce(address) external view returns (uint64);
}

/// @dev Test-only counterexample: code.length is zero during construction.
/// Requires a valid operator signature specifically issued to its future address.
contract ReleaseConstructorMinter {
    constructor(Gallery gallery, Gallery.Authorization memory a, bytes memory signature) {
        gallery.mint("Constructor", "INTJ", a, signature);
    }
}
contract GenerativeSignaturesV1RC1Test {
    ReleaseGenerativeVm constant vm = ReleaseGenerativeVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant ADMIN = address(0xa001);
    address constant MANAGER = address(0xa002);
    address constant PAUSER = address(0xa003);
    address constant REVOKER = address(0xa004);
    address constant RECIPIENT = address(0xb001);
    SignatureRendererV1RC1 renderer;
    Gallery gallery;
    function setUp() public {
        vm.chainId(31337); vm.warp(1800000060);
        renderer = new SignatureRendererV1RC1();
        gallery = new Gallery(address(renderer), 48 hours, ADMIN, MANAGER, PAUSER, REVOKER, vm.addr(1));
        require(gallery.paused(), "candidate must start paused");
        vm.prank(PAUSER); gallery.unpauseMinting();
    }
    function auth(string memory handle, string memory mbti) private view returns (Gallery.Authorization memory a) {
        a = Gallery.Authorization(gallery.handleKey(handle), keccak256("OFFLINE NOT GROK"), gallery.inputDigest(handle, mbti),
            RECIPIENT, keccak256(abi.encode(handle, mbti)), 1800000000, 1800000900);
    }
    function sign(Gallery.Authorization memory a) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, gallery.authorizationDigest(a));
        return abi.encodePacked(r, s, v);
    }
    function mint(string memory handle, string memory mbti) private returns (uint256 id) {
        Gallery.Authorization memory a = auth(handle, mbti); bytes memory signature = sign(a);
        vm.prank(RECIPIENT); return gallery.mint(handle, mbti, a, signature);
    }
    function reject(Gallery.Authorization memory a, string memory handle, string memory mbti, bytes4 error_) private {
        bytes memory signature = sign(a); vm.expectRevert(error_); vm.prank(RECIPIENT);
        gallery.mint(handle, mbti, a, signature);
        require(!gallery.usedNonces(a.nonce), "revert consumed nonce");
    }
    function testMintDoesNotCallRenderer() public {
        // Even if every renderer call reverts, mint must succeed. This catches
        // accidental rendering/metadata-hash verification in the paid path.
        vm.mockCallRevert(address(renderer), bytes(""), hex"deadbeef");
        uint256 beforeGas = gasleft(); uint256 id = mint("012345678901234", "INTJ");
        require(beforeGas - gasleft() < 350000, "input-only mint budget");
        require(gallery.ownerOf(id) == RECIPIENT);
        vm.expectRevert(); gallery.svg(id);
        vm.clearMockedCalls();
        require(keccak256(bytes(gallery.svg(id))) == 0x1e0832a7ad44df9971edd271735b14b365da4d504fbdc31c99022f05b227eb73, "locked oracle");
    }
    function testPreservedCaseAndLiteralMbti() public {
        uint256 id = mint("Alice_Bob_Key", "INFP");
        (string memory h, string memory m) = gallery.inputs(id);
        require(keccak256(bytes(h)) == keccak256("Alice_Bob_Key"));
        require(keccak256(bytes(m)) == keccak256("INFP"));
        require(keccak256(bytes(gallery.svg(id))) == 0x672526df3a5df22195bc927c706c1220362f69b72f433599f392b172d8ee419f);
    }
    function testUniquenessIgnoresCaseAndMbti() public {
        mint("Alice", "INTJ");
        Gallery.Authorization memory a = auth("alice", "ENFP");
        reject(a, "alice", "ENFP", Gallery.HandleAlreadyMinted.selector);
    }
    function testInputTamperingRejected() public {
        Gallery.Authorization memory a = auth("Alice", "INTJ");
        reject(a, "Alice", "INFP", Gallery.InputDigestMismatch.selector);
        reject(a, "alice", "INTJ", Gallery.InputDigestMismatch.selector);
        reject(a, "Bob", "INTJ", Gallery.HandleKeyMismatch.selector);
    }
    function testAssessmentTamperingRejectedWithoutNonceConsumption() public {
        Gallery.Authorization memory a = auth("Alice", "INTJ"); bytes memory signature = sign(a);
        a.assessmentDigest = keccak256("USER CLAIM");
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(RECIPIENT); gallery.mint("Alice", "INTJ", a, signature);
        require(!gallery.usedNonces(a.nonce));
    }
    function testRecipientAndContractWalletGuards() public {
        Gallery.Authorization memory a = auth("Alice", "INTJ"); bytes memory signature = sign(a);
        vm.expectRevert(Gallery.WrongRecipient.selector); vm.prank(address(0xbeef)); gallery.mint("Alice", "INTJ", a, signature);
        a.recipient = address(this); signature = sign(a);
        vm.expectRevert(Gallery.ContractWalletUnsupported.selector); gallery.mint("Alice", "INTJ", a, signature);
    }
    function testNonceReplayAndRevocation() public {
        Gallery.Authorization memory a = auth("Alice", "INTJ"); bytes memory signature = sign(a);
        vm.prank(RECIPIENT); gallery.mint("Alice", "INTJ", a, signature);
        vm.expectRevert(Gallery.NonceUnavailable.selector); vm.prank(RECIPIENT); gallery.mint("Alice", "INTJ", a, signature);
        a = auth("Bob", "INFP"); vm.prank(REVOKER); gallery.revokeNonce(a.nonce);
        reject(a, "Bob", "INFP", Gallery.NonceUnavailable.selector);
    }
    function testAuthorizationWindowBounds() public {
        Gallery.Authorization memory a = auth("Alice", "INTJ");
        a.issuedAt = 0; reject(a, "Alice", "INTJ", Gallery.InvalidAuthorizationWindow.selector);
        a = auth("Alice", "INTJ"); a.deadline = a.issuedAt + 901;
        reject(a, "Alice", "INTJ", Gallery.InvalidAuthorizationWindow.selector);
        a = auth("Alice", "INTJ"); vm.warp(a.issuedAt - 1);
        reject(a, "Alice", "INTJ", Gallery.AuthorizationNotActive.selector);
        vm.warp(a.deadline + 1); reject(a, "Alice", "INTJ", Gallery.AuthorizationExpired.selector);
    }
    function testDeadlineIsInclusiveSoRecoveryMustWaitPastIt() public {
        Gallery.Authorization memory a = auth("Alice", "INTJ"); bytes memory signature = sign(a);
        vm.warp(a.deadline); vm.prank(RECIPIENT);
        gallery.mint("Alice", "INTJ", a, signature);
        require(gallery.mintedHandle(a.handleKey), "deadline is still valid");
    }
    function testExpiredAuthorityCannotCompeteWithFreshReservation() public {
        Gallery.Authorization memory old = auth("Alice", "INTJ");
        vm.warp(old.deadline + 1);
        reject(old, "Alice", "INTJ", Gallery.AuthorizationExpired.selector);
        Gallery.Authorization memory fresh = auth("Alice", "INTJ");
        fresh.nonce = keccak256("new explicit request, unchanged accepted inputs");
        fresh.issuedAt = uint64(block.timestamp); fresh.deadline = uint64(block.timestamp + 300);
        require(fresh.inputDigest == old.inputDigest && fresh.assessmentDigest == old.assessmentDigest);
        bytes memory signature = sign(fresh); vm.prank(RECIPIENT);
        gallery.mint("Alice", "INTJ", fresh, signature);
        reject(old, "Alice", "INTJ", Gallery.AuthorizationExpired.selector);
        require(gallery.usedNonces(fresh.nonce), "fresh mint not recorded");
    }
    function testWrongChainOrDeploymentSignatureRejected() public {
        Gallery.Authorization memory a = auth("Alice", "INTJ"); bytes memory signature = sign(a);
        vm.chainId(11155111);
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(RECIPIENT); gallery.mint("Alice", "INTJ", a, signature);
        vm.chainId(31337);
        Gallery other = new Gallery(address(renderer), 48 hours, ADMIN, MANAGER, PAUSER, REVOKER, vm.addr(1));
        vm.prank(PAUSER); other.unpauseMinting();
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(RECIPIENT); other.mint("Alice", "INTJ", a, signature);
    }
    function testSignerRotationInvalidatesOldAuthorityNotArt() public {
        uint256 id = mint("x", "ENFP"); bytes32 beforeHash = keccak256(bytes(gallery.tokenURI(id)));
        Gallery.Authorization memory a = auth("Alice", "INTJ"); bytes memory signature = sign(a);
        vm.prank(MANAGER); gallery.setTrustedAuthorizer(vm.addr(2));
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(RECIPIENT); gallery.mint("Alice", "INTJ", a, signature);
        require(keccak256(bytes(gallery.tokenURI(id))) == beforeHash);
    }
    function testRestoringSignerRevivesUnusedUnexpiredAuthority() public {
        Gallery.Authorization memory a = auth("Alice", "INTJ"); bytes memory signature = sign(a);
        address original = vm.addr(1); address replacement = vm.addr(2);
        vm.prank(MANAGER); gallery.setTrustedAuthorizer(replacement);
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(RECIPIENT);
        gallery.mint("Alice", "INTJ", a, signature);
        require(!gallery.usedNonces(a.nonce));
        vm.prank(MANAGER); gallery.setTrustedAuthorizer(original);
        vm.prank(RECIPIENT); gallery.mint("Alice", "INTJ", a, signature);
        require(gallery.usedNonces(a.nonce), "rotation is not permanent revocation");
    }
    function testRevocationSurvivesRestoringSigner() public {
        Gallery.Authorization memory a = auth("Alice", "INTJ"); bytes memory signature = sign(a);
        address original = vm.addr(1); address replacement = vm.addr(2);
        vm.prank(MANAGER); gallery.setTrustedAuthorizer(replacement);
        vm.prank(REVOKER); gallery.revokeNonce(a.nonce);
        vm.prank(MANAGER); gallery.setTrustedAuthorizer(original);
        vm.expectRevert(Gallery.NonceUnavailable.selector); vm.prank(RECIPIENT);
        gallery.mint("Alice", "INTJ", a, signature);
        require(!gallery.usedNonces(a.nonce) && !gallery.mintedHandle(a.handleKey));
    }
    function testWaitingOneWindowCannotMakeACompromisedSignerSafeToRestore() public {
        Gallery.Authorization memory a = auth("Alice", "INTJ");
        // A dishonest signer can pre-sign a future window. The 900-second cap
        // limits window duration, not how far in the future it can begin.
        a.issuedAt = uint64(block.timestamp + 1 days); a.deadline = a.issuedAt + 900;
        bytes memory signature = sign(a);
        address original = vm.addr(1); address replacement = vm.addr(2);
        vm.prank(MANAGER); gallery.setTrustedAuthorizer(replacement);
        vm.warp(a.issuedAt);
        vm.prank(MANAGER); gallery.setTrustedAuthorizer(original);
        vm.prank(RECIPIENT); gallery.mint("Alice", "INTJ", a, signature);
        require(gallery.usedNonces(a.nonce), "never restore a compromised signer");
    }
    function testPauseDoesNotRevokeOutstandingAuthorization() public {
        Gallery.Authorization memory a = auth("Alice", "INTJ"); bytes memory signature = sign(a);
        vm.prank(PAUSER); gallery.pauseMinting();
        vm.expectRevert(); vm.prank(RECIPIENT); gallery.mint("Alice", "INTJ", a, signature);
        vm.prank(PAUSER); gallery.unpauseMinting();
        vm.prank(RECIPIENT); gallery.mint("Alice", "INTJ", a, signature);
        require(gallery.usedNonces(a.nonce), "pause is not revocation");
    }
    function constructorAuthorization() private view returns (Gallery.Authorization memory a) {
        uint64 nonce = vm.getNonce(address(this));
        require(nonce > 0 && nonce < 128, "test prediction uses short CREATE nonce RLP");
        address predicted = address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), bytes1(uint8(nonce)))))));
        a = auth("Constructor", "INTJ"); a.recipient = predicted;
    }
    function testConstructionBypassesCodeLengthOnlyWithExplicitAuthority() public {
        Gallery.Authorization memory a = constructorAuthorization();
        ReleaseConstructorMinter minter = new ReleaseConstructorMinter(gallery, a, sign(a));
        require(address(minter) == a.recipient && address(minter).code.length > 0);
        require(gallery.ownerOf(uint256(a.handleKey)) == address(minter), "code length is not proof of EOA");
    }
    function testConstructionStillCannotForgeBackendAuthority() public {
        Gallery.Authorization memory a = constructorAuthorization();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(2, gallery.authorizationDigest(a));
        vm.expectRevert(Gallery.InvalidAttestation.selector);
        new ReleaseConstructorMinter(gallery, a, abi.encodePacked(r, s, v));
        require(!gallery.usedNonces(a.nonce) && !gallery.mintedHandle(a.handleKey));
    }
    function testTransferAndPauseDoNotChangeArt() public {
        uint256 id = mint("x", "ENFP"); bytes32 beforeHash = keccak256(bytes(gallery.tokenURI(id)));
        vm.prank(PAUSER); gallery.pauseMinting();
        vm.prank(RECIPIENT); gallery.transferFrom(RECIPIENT, address(0xbeef), id);
        require(gallery.ownerOf(id) == address(0xbeef));
        require(keccak256(bytes(gallery.tokenURI(id))) == beforeHash);
        Gallery.Authorization memory a = auth("Alice", "INTJ"); bytes memory signature = sign(a);
        vm.expectRevert(); vm.prank(RECIPIENT); gallery.mint("Alice", "INTJ", a, signature);
    }
    function testNoArtworkForNonexistentToken() public {
        vm.expectRevert(); gallery.inputs(1);
        vm.expectRevert(); gallery.svg(1);
        vm.expectRevert(); gallery.tokenURI(1);
    }
    function testDeploymentRefusesMainnetAndArbitraryRenderer() public {
        vm.expectRevert(Gallery.InvalidRenderer.selector);
        new Gallery(address(this), 48 hours, ADMIN, MANAGER, PAUSER, REVOKER, vm.addr(1));
        vm.chainId(1); vm.expectRevert(Gallery.UnsupportedReleaseChain.selector);
        new Gallery(address(renderer), 48 hours, ADMIN, MANAGER, PAUSER, REVOKER, vm.addr(1));
    }
    function testRolesProtected() public {
        vm.expectRevert(); gallery.setTrustedAuthorizer(address(1));
        vm.expectRevert(); gallery.pauseMinting();
        vm.expectRevert(); gallery.revokeNonce(keccak256("a"));
    }
    function testZeroCommitmentsAndMalformedSignatures() public {
        Gallery.Authorization memory a = auth("Alice", "INTJ");
        a.assessmentDigest = bytes32(0); reject(a, "Alice", "INTJ", Gallery.ZeroCommitment.selector);
        a = auth("Alice", "INTJ"); a.nonce = bytes32(0); reject(a, "Alice", "INTJ", Gallery.ZeroCommitment.selector);
        a = auth("Alice", "INTJ");
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(RECIPIENT); gallery.mint("Alice", "INTJ", a, hex"1234");
        require(!gallery.usedNonces(a.nonce));
    }
    function testInvalidInputRejectedBeforeIssuance() public {
        vm.expectRevert(Gallery.InvalidInput.selector); gallery.inputDigest("abcdefghijklmnop", "INTJ");
        vm.expectRevert(Gallery.InvalidInput.selector); gallery.inputDigest("<script>", "INTJ");
        vm.expectRevert(Gallery.InvalidInput.selector); gallery.inputDigest("Alice", "intj");
        vm.expectRevert(Gallery.InvalidInput.selector); gallery.inputDigest("Alice", "INTJx");
        vm.expectRevert(Gallery.InvalidInput.selector); gallery.inputDigest("Alice", "XXXX");
    }
    function testInputDigestBindsExactRendererDeployment() public {
        SignatureRendererV1RC1 anotherRenderer = new SignatureRendererV1RC1();
        Gallery other = new Gallery(address(anotherRenderer), 48 hours, ADMIN, MANAGER, PAUSER, REVOKER, vm.addr(1));
        require(other.rendererIdentity() != gallery.rendererIdentity());
        require(other.inputDigest("Alice", "INTJ") != gallery.inputDigest("Alice", "INTJ"));
    }
    function testFuzzPackedInputRoundTrip(bytes15 seed, uint8 size) public {
        bytes memory alphabet = bytes("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_");
        bytes memory h = new bytes(1 + uint256(size) % 15);
        for (uint256 i; i < h.length; ++i) h[i] = alphabet[uint8(seed[i]) % 63];
        bytes memory m = new bytes(4);
        m[0] = uint8(seed[0]) & 1 == 0 ? bytes1("I") : bytes1("E");
        m[1] = uint8(seed[0]) & 2 == 0 ? bytes1("S") : bytes1("N");
        m[2] = uint8(seed[0]) & 4 == 0 ? bytes1("T") : bytes1("F");
        m[3] = uint8(seed[0]) & 8 == 0 ? bytes1("J") : bytes1("P");
        uint256 id = mint(string(h), string(m));
        (string memory savedH, string memory savedM) = gallery.inputs(id);
        require(keccak256(bytes(savedH)) == keccak256(h));
        require(keccak256(bytes(savedM)) == keccak256(m));
        require(id == uint256(gallery.handleKey(string(h))));
        require(gallery.ownerOf(id) == RECIPIENT);
    }
    function testSepoliaDeploymentStartsPausedAndActivationIsSeparate() public {
        vm.chainId(11155111);
        Gallery candidate = new Gallery(address(renderer), 48 hours, ADMIN, MANAGER, PAUSER, REVOKER, vm.addr(1));
        require(candidate.paused());
        require(keccak256(bytes(candidate.VERSION())) == keccak256("sg-generative-mint-1.0.0-rc.1"));
        Gallery.Authorization memory a = auth("Alice", "INTJ");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, candidate.authorizationDigest(a));
        vm.expectRevert(); vm.prank(RECIPIENT); candidate.mint("Alice", "INTJ", a, abi.encodePacked(r, s, v));
        vm.expectRevert(); candidate.unpauseMinting();
        vm.prank(PAUSER); candidate.unpauseMinting();
        require(!candidate.paused());
        vm.prank(RECIPIENT); candidate.mint("Alice", "INTJ", a, abi.encodePacked(r, s, v));
        require(candidate.ownerOf(uint256(a.handleKey)) == RECIPIENT);
    }
    function testExperimentalRendererIsNotAReleaseRenderer() public {
        SignatureRendererCandidate old = new SignatureRendererCandidate();
        vm.expectRevert(Gallery.InvalidRenderer.selector);
        new Gallery(address(old), 48 hours, ADMIN, MANAGER, PAUSER, REVOKER, vm.addr(1));
    }
    function testExperimentalDomainCannotAuthorizeReleaseMint() public {
        Gallery.Authorization memory a = auth("Alice", "INTJ");
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("SignaturesGenerativeMintExperimental"), keccak256("1"), block.chainid, address(gallery)
        ));
        bytes32 body = keccak256(abi.encode(gallery.AUTHORIZATION_TYPEHASH(), a.handleKey, a.assessmentDigest,
            a.inputDigest, a.recipient, a.nonce, a.issuedAt, a.deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, keccak256(abi.encodePacked(hex"1901", domain, body)));
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(RECIPIENT);
        gallery.mint("Alice", "INTJ", a, abi.encodePacked(r, s, v));
        require(!gallery.usedNonces(a.nonce));
    }
    function testCollectionMetadataIsSelfContained() public view {
        bytes memory uri = bytes(gallery.contractURI());
        bytes memory prefix = bytes("data:application/json;base64,");
        require(uri.length > prefix.length);
        for (uint256 i; i < prefix.length; ++i) require(uri[i] == prefix[i]);
        require(keccak256(bytes(gallery.INPUT_PROFILE())) == keccak256("sg-generative-inputs-v1-rc1"));
    }
    function testRuntimeSize() public view { require(address(gallery).code.length <= 24576); }
}
