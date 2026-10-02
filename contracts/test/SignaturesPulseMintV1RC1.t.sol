// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SignaturesPulseMintV1RC1 as Gallery} from "../src/release/SignaturesPulseMintV1RC1.sol";
import {ISignaturesPulseMintV1RC1 as MintInterface} from "../src/release/ISignaturesPulseMintV1RC1.sol";
import {SignatureRendererV1RC1} from "../src/release/SignatureRendererV1RC1.sol";
import {IPulseCore} from "../vendor/pulse-core-v1.0.0/IPulseCore.sol";
import {PulseCoreReleaseData} from "./fixtures/PulseCoreReleaseData.sol";

interface PulseMintVm {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function warp(uint256) external;
    function roll(uint256) external;
    function chainId(uint256) external;
    function deal(address, uint256) external;
    function etch(address, bytes calldata) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function mockCallRevert(address, bytes calldata, bytes calldata) external;
    function clearMockedCalls() external;
}

contract TogglePulseTreasury {
    bool public reject = true;
    function allow() external { reject = false; }
    receive() external payable { require(!reject, "reject ETH"); }
}

contract PulseCallbackProbe {
    address public target;
    bytes[] private _calls;
    uint256 public blocked;
    function configure(address target_, bytes[] memory calls_) external { target = target_; _calls = calls_; }
    receive() external payable {
        for (uint256 i; i < _calls.length; ++i) {
            (bool ok, bytes memory result) = target.call(_calls[i]);
            require(!ok && result.length == 4 && bytes4(result) == bytes4(keccak256("ReentrancyGuardReentrantCall()")), "unguarded mutation");
            ++blocked;
        }
    }
}

abstract contract PulseMintFixture {
    PulseMintVm internal constant vm = PulseMintVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint64 internal constant START = 1800000000;
    address internal constant A = 0x1111111111111111111111111111111111111111;
    address internal constant B = 0x2222222222222222222222222222222222222222;
    address internal constant TREASURY = address(0x7000);
    address internal constant ADMIN = address(0xa001);
    address internal constant MANAGER = address(0xa002);
    address internal constant PAUSER = address(0xa003);
    address internal constant REVOKER = address(0xa004);
    bytes32 internal constant ROOT = 0xd56fcadc336e04d31a7146c6472fd61dc315e9dd74f8b56b7b25166b4402b36a;
    bytes32 internal constant CORE_HASH = 0xfb48657163202d3cdb28060f1eb511fd1f5b93a6e0eb8657242b5632e2200a90;
    Gallery internal gallery;
    SignatureRendererV1RC1 internal renderer;
    address internal core;
    address internal signer;

    function setUp() public virtual {
        vm.chainId(31337); vm.warp(START); vm.roll(100);
        signer = vm.addr(1);
        // Deploy the exact released 0.8.24/Shanghai creation artifact. Compiling
        // the vendored source under the consumer compiler would be a different core.
        bytes memory creation = PulseCoreReleaseData.creationCode();
        address deployed;
        assembly ("memory-safe") { deployed := create(0, add(creation, 32), mload(creation)) }
        require(deployed != address(0) && deployed.codehash == CORE_HASH, "released core");
        core = deployed;
        renderer = new SignatureRendererV1RC1();
        gallery = deploy(sale());
        vm.prank(PAUSER); gallery.unpauseMinting();
        vm.deal(A, 10 ether); vm.deal(B, 10 ether);
    }

    function authorities() internal view returns (MintInterface.Authorities memory) {
        return MintInterface.Authorities(2 days, ADMIN, MANAGER, PAUSER, REVOKER, signer);
    }
    function sale() internal pure returns (MintInterface.SaleConfig memory) {
        return MintInterface.SaleConfig(ROOT, 3, START + 3600, payable(TREASURY), IPulseCore.Config(600, 1000, 900, 1));
    }
    function deploy(MintInterface.SaleConfig memory config) internal returns (Gallery) {
        return new Gallery(address(renderer), MintInterface.CoreBinding(block.chainid, core), config, authorities());
    }
    function activate(Gallery target) internal { vm.prank(PAUSER); target.unpauseMinting(); }
    function proof(uint256 slot) internal pure returns (bytes32[] memory p) {
        if (slot == 2) {
            p = new bytes32[](1);
            p[0] = 0x3240c86f751f8d996187613ec9d2dfe7a6d0155da0b13a82d05b94ea59838d94;
        } else {
            p = new bytes32[](2);
            p[0] = slot == 0 ? bytes32(0x7b4e4429a12d7c7f52f97ac3310a7f766c8a424a830a3b5423010430bc468c18)
                : bytes32(0x53d1ea11c02bccf00efa13950923d7ec0991024794dcc0a5de4788c13baf062c);
            p[1] = 0xd24381ffdbca19327cb0117d15c0a6fbb005d98ac3206a50e7b6485de726f89c;
        }
    }
    function auth(string memory handle, uint8 mode, uint256 slot, uint256 cap, address recipient)
        internal view returns (MintInterface.Authorization memory a)
    {
        uint64 deadline = uint64(block.timestamp) + 900;
        if (mode == 0 && deadline > gallery.freeDeadline()) deadline = gallery.freeDeadline();
        return MintInterface.Authorization(gallery.handleKey(handle), keccak256("OFFLINE C3 ASSESSMENT"),
            gallery.inputDigest(handle, "INTJ"), recipient, keccak256(abi.encode(handle, mode, slot, cap, recipient, block.timestamp)),
            uint64(block.timestamp), deadline, mode, slot, cap);
    }
    function sign(MintInterface.Authorization memory a) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, gallery.authorizationDigest(a));
        return abi.encodePacked(r, s, v);
    }
    function mintFree(string memory handle, uint256 slot, address recipient) internal returns (uint256 id) {
        MintInterface.Authorization memory a = auth(handle, 0, slot, 0, recipient);
        bytes memory signature = sign(a); bytes32[] memory p = proof(slot);
        vm.prank(recipient); return gallery.mintFree(handle, "INTJ", a, signature, p);
    }
    function mintPaid(string memory handle, uint256 cap) internal returns (uint256 id) {
        MintInterface.Authorization memory a = auth(handle, 1, type(uint256).max, cap, A);
        bytes memory signature = sign(a);
        vm.prank(A); return gallery.mintPaid{value: cap}(handle, "INTJ", a, signature);
    }
    function unused(MintInterface.Authorization memory a) internal view {
        require(!gallery.usedNonces(a.nonce), "nonce consumed");
        require(!gallery.mintedHandle(a.handleKey), "handle consumed");
        (bytes32 assessment, bytes32 authorization, address recipient) = gallery.provenance(uint256(a.handleKey));
        require(assessment == 0 && authorization == 0 && recipient == address(0), "provenance written");
        (bool exists,) = address(gallery).staticcall(abi.encodeCall(gallery.ownerOf, (uint256(a.handleKey))));
        require(!exists, "NFT created");
    }
    function rejectFree(MintInterface.Authorization memory a, string memory handle, bytes32[] memory p, bytes4 selector) internal {
        bytes memory signature = sign(a);
        vm.expectRevert(selector); vm.prank(a.recipient); gallery.mintFree(handle, "INTJ", a, signature, p);
        unused(a);
    }
}

contract PulseMintConstructionTest is PulseMintFixture {
    function testTypedDataMatchesIndependentViemVector() public {
        address vectorAddress = address(0xb001);
        vm.etch(vectorAddress, address(gallery).code);
        MintInterface.Authorization memory a = MintInterface.Authorization(
            bytes32(uint256(type(uint256).max / 15)), bytes32(uint256(type(uint256).max / 15 * 2)),
            bytes32(uint256(type(uint256).max / 15 * 3)), A, bytes32(uint256(type(uint256).max / 15 * 4)),
            START, START + 900, 1, type(uint256).max, 1200);
        require(Gallery(vectorAddress).authorizationDigest(a) == 0x16c6ee99a3916d62d07bf24b02096759cf1c0daad23d8a8b599179cfb2f2c262, "typed data drift");
        require(gallery.authorizationDigest(a) != Gallery(vectorAddress).authorizationDigest(a), "contract domain omitted");
    }
    function testFrozenBindingsAndPausedConstruction() public {
        Gallery next = deploy(sale());
        require(next.paused());
        require(next.pulseCore() == core && next.boundChainId() == 31337 && next.coreRuntimeCodeHash() == CORE_HASH);
        require(next.freeMintRoot() == ROOT && next.freeSlotCount() == 3 && next.freeDeadline() == START + 3600);
        require(next.treasury() == TREASURY && next.deployedAt() == START);
        require(keccak256(bytes(next.VERSION())) == keccak256("sg-generative-pulse-mint-1.0.0-rc.1"));
        require(keccak256(bytes(next.INPUT_PROFILE())) == keccak256("sg-generative-pulse-inputs-v1-rc1"));
        require(next.AUTHORIZATION_TYPEHASH() == 0x65be64491ba939c2eb80eaa1c34208acaa5fc27c5d6b40889da86cce405f7150);
        MintInterface.SaleConfig memory c = sale();
        bytes32 expected = keccak256(abi.encode("signatures.gallery/pulse-sale/v1-rc1", uint256(31337), address(next),
            core, CORE_HASH, next.rendererIdentity(), TREASURY, ROOT, uint256(3), c.freeDeadline,
            uint256(600), uint256(1000), uint256(900), uint256(1)));
        require(next.saleConfigHash() == expected, "sale commitment encoding");
    }
    function testUnsupportedOrMismatchedChainRejected() public {
        MintInterface.SaleConfig memory c = sale(); MintInterface.Authorities memory roles = authorities();
        vm.expectRevert(MintInterface.WrongChain.selector);
        new Gallery(address(renderer), MintInterface.CoreBinding(1, core), c, roles);
        vm.chainId(1); vm.expectRevert(MintInterface.WrongChain.selector);
        new Gallery(address(renderer), MintInterface.CoreBinding(1, core), c, roles);
    }
    function testSepoliaRequiresPublishedAddressAndExactCode() public {
        vm.chainId(11155111);
        MintInterface.SaleConfig memory c = sale(); MintInterface.Authorities memory roles = authorities();
        vm.expectRevert(MintInterface.InvalidCore.selector);
        new Gallery(address(renderer), MintInterface.CoreBinding(11155111, core), c, roles);
        address released = gallery.SEPOLIA_CORE();
        vm.etch(released, core.code);
        Gallery next = new Gallery(address(renderer), MintInterface.CoreBinding(11155111, released), c, roles);
        require(next.pulseCore() == released);
    }
    function testWrongCoreAndRendererRejected() public {
        MintInterface.SaleConfig memory c = sale(); MintInterface.Authorities memory roles = authorities();
        vm.expectRevert(MintInterface.InvalidCore.selector);
        new Gallery(address(renderer), MintInterface.CoreBinding(31337, address(0x123)), c, roles);
        vm.expectRevert(Gallery.InvalidRenderer.selector);
        new Gallery(address(0x123), MintInterface.CoreBinding(31337, core), c, roles);
    }
    function testInvalidRootCountDeadlineAndTreasuryRejected() public {
        MintInterface.SaleConfig memory c = sale();
        c.freeMintRoot = 0; vm.expectRevert(MintInterface.InvalidSaleConfiguration.selector); deploy(c);
        c = sale(); c.freeSlotCount = 0; vm.expectRevert(MintInterface.InvalidSaleConfiguration.selector); deploy(c);
        c = sale(); c.freeDeadline = START; vm.expectRevert(MintInterface.InvalidSaleConfiguration.selector); deploy(c);
        c = sale(); c.treasury = payable(address(0)); vm.expectRevert(Gallery.ZeroAddress.selector); deploy(c);
    }
    function testInvalidCoreConfigAndAdvanceOverflowRejected() public {
        MintInterface.SaleConfig memory c = sale(); c.pulse.k = 0;
        vm.expectRevert(IPulseCore.InvalidCurveK.selector); deploy(c);
        c = sale(); c.pulse = IPulseCore.Config(1, type(uint256).max, type(uint256).max - 1, 2);
        vm.expectRevert(IPulseCore.TargetPriceOverflow.selector); deploy(c);
    }
    function testMintPauseAndClockRemainIndependent() public {
        vm.prank(PAUSER); gallery.pauseMinting();
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, A); bytes memory signature = sign(a);
        vm.expectRevert(bytes4(keccak256("EnforcedPause()"))); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", a, signature, proof(0));
        vm.warp(START + 3700);
        MintInterface.SaleStatus memory status = gallery.saleStatus();
        require(status.paused && status.phase == MintInterface.Phase.Paid && status.paidStartTime == START + 3600);
        activate(gallery);
        require(gallery.getPulseState().openTime == START + 3600, "clock restarted");
    }
    function testDelayedAdminTransferStillWorks() public {
        address next = address(0xb002);
        vm.prank(ADMIN); gallery.beginDefaultAdminTransfer(next);
        vm.expectRevert(); vm.prank(next); gallery.acceptDefaultAdminTransfer();
        vm.warp(START + 2 days + 1); vm.prank(next); gallery.acceptDefaultAdminTransfer();
        require(gallery.defaultAdmin() == next);
    }
}

contract PulseMintFreeTest is PulseMintFixture {
    function testWrongSenderAndCodeBearingWalletRejected() public {
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, A); bytes memory signature = sign(a);
        vm.expectRevert(Gallery.WrongRecipient.selector); vm.prank(B);
        gallery.mintFree("Alpha", "INTJ", a, signature, proof(0)); unused(a);
        vm.etch(A, hex"00");
        vm.expectRevert(Gallery.ContractWalletUnsupported.selector); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", a, signature, proof(0)); unused(a);
    }
    function testUsedNonceAndChangedInputsReject() public {
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, A); bytes memory signature = sign(a);
        vm.expectRevert(Gallery.InputDigestMismatch.selector); vm.prank(A);
        gallery.mintFree("Alpha", "INFP", a, signature, proof(0)); unused(a);
        vm.prank(A); gallery.mintFree("Alpha", "INTJ", a, signature, proof(0));
        MintInterface.Authorization memory replay = auth("Beta", 0, 2, 0, A); replay.nonce = a.nonce;
        signature = sign(replay); vm.expectRevert(Gallery.NonceUnavailable.selector); vm.prank(A);
        gallery.mintFree("Beta", "INTJ", replay, signature, proof(2));
        require(!gallery.mintedHandle(replay.handleKey) && !gallery.isFreeSlotClaimed(2));
    }
    function testDuplicateWalletSlotsAndExhaustion() public {
        uint256 first = mintFree("Alpha", 0, A);
        mintFree("Beta", 2, A);
        require(gallery.freeMinted() == 2 && gallery.saleStatus().phase == MintInterface.Phase.Free);
        require(gallery.ownerOf(first) == A && gallery.balanceOf(A) == 2);
        vm.warp(START + 10); vm.recordLogs(); mintFree("Gamma", 1, B);
        PulseMintVm.Log[] memory logs = vm.getRecordedLogs();
        uint256 starts;
        for (uint256 i; i < logs.length; ++i) {
            require(logs[i].topics[0] != keccak256("Sale(address,uint64,uint256,uint64,uint64,uint256)"), "free sale event");
            if (logs[i].topics[0] == keccak256("PaidPhaseStarted(uint64,uint8,uint256)")) ++starts;
        }
        require(starts == 1 && gallery.freeMinted() == 3);
        MintInterface.SaleStatus memory status = gallery.saleStatus();
        require(status.phase == MintInterface.Phase.Paid && status.endReason == MintInterface.EndReason.Exhausted);
        require(status.paidStartTime == START + 10 && status.lastPaidMintBlock == 0);
        require(gallery.getPulseState().epochIndex == 0 && gallery.getCurrentPrice() == 1000);
        mintPaid("Delta", 1100); // Final free and first paid share the same block.
        require(gallery.getPulseState().epochIndex == 1);
    }
    function testSingleSlotEmptyProofAndReadTimeRendering() public {
        MintInterface.SaleConfig memory c = sale(); c.freeMintRoot = gallery.freeSlotLeaf(0, A); c.freeSlotCount = 1;
        gallery = deploy(c); activate(gallery);
        MintInterface.Authorization memory a = auth("Alice_Bob_Key", 0, 0, 0, A); bytes memory signature = sign(a);
        vm.mockCallRevert(address(renderer), bytes(""), hex"deadbeef");
        vm.prank(A); uint256 id = gallery.mintFree("Alice_Bob_Key", "INTJ", a, signature, new bytes32[](0));
        require(gallery.ownerOf(id) == A && gallery.freeMinted() == 1);
        vm.clearMockedCalls();
        (string memory handle, string memory mbti) = gallery.inputs(id);
        require(keccak256(bytes(handle)) == keccak256("Alice_Bob_Key") && keccak256(bytes(mbti)) == keccak256("INTJ"));
        require(keccak256(bytes(gallery.svg(id))) == keccak256(bytes(renderer.render(handle, mbti))));
        require(bytes(gallery.tokenURI(id)).length > 100);
        (bytes32 assessment, bytes32 digest, address recipient) = gallery.provenance(id);
        require(assessment == a.assessmentDigest && digest == gallery.authorizationDigest(a) && recipient == A);
        vm.prank(A); gallery.transferFrom(A, B, id); require(gallery.ownerOf(id) == B);
        require(gallery.mintedHandle(a.handleKey), "transfer reopened handle");
    }
    function testRepeatedSlotAndCaseInsensitiveHandleRejected() public {
        mintFree("Alpha", 0, A);
        MintInterface.Authorization memory repeated = auth("Beta", 0, 0, 0, A);
        rejectFree(repeated, "Beta", proof(0), MintInterface.SlotAlreadyClaimed.selector);
        MintInterface.Authorization memory sameHandle = auth("ALPHA", 0, 2, 0, A); bytes memory signature = sign(sameHandle);
        vm.expectRevert(Gallery.HandleAlreadyMinted.selector); vm.prank(A);
        gallery.mintFree("ALPHA", "INTJ", sameHandle, signature, proof(2));
        require(!gallery.isFreeSlotClaimed(2) && !gallery.usedNonces(sameHandle.nonce) && gallery.freeMinted() == 1);
    }
    function testWrongWalletProofOutOfRangeAndOversizedProofRejected() public {
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, B);
        rejectFree(a, "Alpha", proof(0), MintInterface.InvalidSlotProof.selector);
        a = auth("Alpha", 0, 3, 0, A);
        rejectFree(a, "Alpha", proof(0), MintInterface.InvalidSlot.selector);
        a = auth("Alpha", 0, 0, 0, A);
        rejectFree(a, "Alpha", new bytes32[](257), MintInterface.InvalidSlotProof.selector);
        require(gallery.freeMinted() == 0 && !gallery.isFreeSlotClaimed(0));
    }
    function testFreeFieldRulesAndClippedExpiry() public {
        MintInterface.Authorization memory a = auth("Alpha", 1, 0, 0, A);
        rejectFree(a, "Alpha", proof(0), MintInterface.InvalidMintMode.selector);
        a = auth("Alpha", 0, 0, 1, A);
        rejectFree(a, "Alpha", proof(0), MintInterface.InvalidPriceLimit.selector);
        vm.warp(START + 3500); a = auth("Alpha", 0, 0, 0, A); a.deadline = START + 3601;
        rejectFree(a, "Alpha", proof(0), Gallery.InvalidAuthorizationWindow.selector);
    }
    function testDeadlineMinusOneAllowsFreeAndEqualityCloses() public {
        vm.warp(START + 3599); mintFree("Alpha", 0, A);
        MintInterface.Authorization memory a = auth("Beta", 0, 2, 0, A); bytes memory signature = sign(a);
        vm.warp(START + 3600);
        vm.expectRevert(MintInterface.FreeMintClosed.selector); vm.prank(A);
        gallery.mintFree("Beta", "INTJ", a, signature, proof(2));
        unused(a); require(!gallery.isFreeSlotClaimed(2) && gallery.freeMinted() == 1);
        require(gallery.saleStatus().endReason == MintInterface.EndReason.Deadline);
        require(gallery.getPulseState().openTime == START + 3600);
    }
    function testFreeViewsAndPaidMintAreClosed() public {
        vm.expectRevert(MintInterface.PaidMintNotOpen.selector); gallery.getPulseState();
        vm.expectRevert(MintInterface.PaidMintNotOpen.selector); gallery.getCurrentPrice();
        MintInterface.Authorization memory a = auth("Alpha", 1, type(uint256).max, 1000, A); bytes memory signature = sign(a);
        vm.expectRevert(MintInterface.PaidMintNotOpen.selector); vm.prank(A);
        gallery.mintPaid{value: 1000}("Alpha", "INTJ", a, signature); unused(a);
    }
    function testInvalidAuthorizationSignatureExpiryAndRevocation() public {
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, A);
        a.deadline = a.issuedAt + 901; rejectFree(a, "Alpha", proof(0), Gallery.InvalidAuthorizationWindow.selector);
        a = auth("Alpha", 0, 0, 0, A); a.issuedAt += 1;
        rejectFree(a, "Alpha", proof(0), Gallery.AuthorizationNotActive.selector);
        a = auth("Alpha", 0, 0, 0, A); bytes memory signature = sign(a);
        vm.warp(a.deadline); vm.expectRevert(Gallery.AuthorizationExpired.selector); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", a, signature, proof(0)); unused(a);
        a = auth("Beta", 0, 0, 0, A); signature = sign(a); a.assessmentDigest = keccak256("tampered");
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(A);
        gallery.mintFree("Beta", "INTJ", a, signature, proof(0)); unused(a);
        a = auth("Gamma", 0, 0, 0, A); vm.prank(REVOKER); gallery.revokeNonce(a.nonce);
        rejectFree(a, "Gamma", proof(0), Gallery.NonceUnavailable.selector);
    }
    function testPaidFieldsAndFreeSignatureCannotBeSubstituted() public {
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, A); bytes memory signature = sign(a);
        a.slotId = 2;
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", a, signature, proof(2)); unused(a);
        // Mutating the mode and price does not turn this signature into paid authority.
        vm.warp(START + 3600); a.issuedAt = START + 3600; a.deadline = START + 4500;
        a.mintMode = 1; a.slotId = type(uint256).max; a.maxPrice = 1000;
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(A);
        gallery.mintPaid{value: 1000}("Alpha", "INTJ", a, signature); unused(a);
    }
}

contract PulseMintPaidTest is PulseMintFixture {
    function testCallbacksCannotReenterMintOrAnyAuthorityMutation() public {
        PulseCallbackProbe probe = new PulseCallbackProbe();
        MintInterface.SaleConfig memory c = sale(); c.treasury = payable(address(probe));
        MintInterface.Authorities memory roles = authorities();
        roles.admin = address(probe); roles.manager = address(probe); roles.pauser = address(probe); roles.revoker = address(probe);
        gallery = new Gallery(address(renderer), MintInterface.CoreBinding(31337, core), c, roles);
        vm.prank(address(probe)); gallery.unpauseMinting();
        vm.warp(START + 3600);
        MintInterface.Authorization memory a = auth("Nested", 1, type(uint256).max, 1000, A);
        bytes[] memory calls = new bytes[](14);
        calls[0] = abi.encodeCall(gallery.mintFree, ("Nested", "INTJ", a, bytes(""), new bytes32[](0)));
        calls[1] = abi.encodeCall(gallery.mintPaid, ("Nested", "INTJ", a, bytes("")));
        calls[2] = abi.encodeCall(gallery.pauseMinting, ());
        calls[3] = abi.encodeCall(gallery.unpauseMinting, ());
        calls[4] = abi.encodeCall(gallery.setTrustedAuthorizer, (B));
        calls[5] = abi.encodeCall(gallery.revokeNonce, (a.nonce));
        calls[6] = abi.encodeCall(gallery.grantRole, (gallery.PAUSER_ROLE(), B));
        calls[7] = abi.encodeCall(gallery.revokeRole, (gallery.PAUSER_ROLE(), address(probe)));
        calls[8] = abi.encodeCall(gallery.renounceRole, (gallery.PAUSER_ROLE(), address(probe)));
        calls[9] = abi.encodeCall(gallery.beginDefaultAdminTransfer, (B));
        calls[10] = abi.encodeCall(gallery.cancelDefaultAdminTransfer, ());
        calls[11] = abi.encodeCall(gallery.acceptDefaultAdminTransfer, ());
        calls[12] = abi.encodeCall(gallery.changeDefaultAdminDelay, (uint48(0)));
        calls[13] = abi.encodeCall(gallery.rollbackDefaultAdminDelay, ());
        probe.configure(address(gallery), calls);
        mintPaid("Alpha", 1200);
        require(probe.blocked() == 14 && !gallery.paused() && gallery.trustedAuthorizer() == signer);
        require(gallery.defaultAdmin() == address(probe) && !gallery.hasRole(gallery.PAUSER_ROLE(), B));
        require(!gallery.revokedNonces(a.nonce) && gallery.getPulseState().epochIndex == 1);
    }
    function testRefundFailureUnwindsTreasuryAndMint() public {
        vm.warp(START + 3600);
        MintInterface.Authorization memory a = auth("Alpha", 1, type(uint256).max, 1200, A); bytes memory signature = sign(a);
        uint256 walletBefore = A.balance; uint256 treasuryBefore = TREASURY.balance;
        // Test-only failure injection: a production direct EOA cannot reject
        // ETH. This reaches the refund guard without broadening wallet support.
        vm.mockCallRevert(A, bytes(""), hex"deadbeef");
        vm.etch(A, bytes("")); // mockCall installs placeholder code; restore EOA identity.
        vm.expectRevert(MintInterface.RefundFailed.selector); vm.prank(A);
        gallery.mintPaid{value: 1200}("Alpha", "INTJ", a, signature);
        vm.clearMockedCalls(); unused(a);
        require(TREASURY.balance == treasuryBefore && A.balance == walletBefore && address(gallery).balance == 0);
        require(gallery.getPulseState().epochIndex == 0 && gallery.saleStatus().lastPaidMintBlock == 0);
        vm.prank(A); gallery.mintPaid{value: 1200}("Alpha", "INTJ", a, signature);
        require(TREASURY.balance == treasuryBefore + 1000 && A.balance == walletBefore - 1000);
    }
    function testTimeoutQuoteSettlementRefundAndEvents() public {
        vm.warp(START + 3610);
        IPulseCore.State memory beforeState = gallery.getPulseState();
        require(beforeState.epochIndex == 0 && beforeState.openTime == START + 3600);
        uint256 ask = gallery.getCurrentPrice(); require(ask == 937, "deadline decay lost");
        (uint256 expectedAsk, IPulseCore.State memory expectedNext) = IPulseCore(core).advance(gallery.getPulseConfig(), beforeState, START + 3610);
        require(ask == expectedAsk);
        uint256 walletBefore = A.balance; uint256 treasuryBefore = TREASURY.balance;
        vm.recordLogs(); uint256 id = mintPaid("Alpha", 1200); PulseMintVm.Log[] memory logs = vm.getRecordedLogs();
        require(A.balance == walletBefore - ask && TREASURY.balance == treasuryBefore + ask && address(gallery).balance == 0);
        require(gallery.ownerOf(id) == A && gallery.freeMinted() == 0);
        require(keccak256(abi.encode(gallery.getPulseState())) == keccak256(abi.encode(expectedNext)));
        require(gallery.saleStatus().lastPaidMintBlock == 100);
        uint256 starts; uint256 sales; uint256 economics;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(gallery)) continue;
            if (logs[i].topics[0] == keccak256("PaidPhaseStarted(uint64,uint8,uint256)")) {
                ++starts; require(keccak256(logs[i].data) == keccak256(abi.encode(uint64(START + 3600), MintInterface.EndReason.Deadline, uint256(0))));
            }
            if (logs[i].topics[0] == keccak256("Sale(address,uint64,uint256,uint64,uint64,uint256)")) {
                ++sales; require(uint256(logs[i].topics[2]) == 1);
                require(keccak256(logs[i].data) == keccak256(abi.encode(ask, uint64(START + 3610), expectedNext.anchorTime, expectedNext.floorPrice)));
            }
            if (logs[i].topics[0] == keccak256("MintEconomics(uint256,bytes32,uint256,uint8,uint256,uint256,uint64)")) {
                ++economics; require(uint256(logs[i].topics[3]) == type(uint256).max);
                require(keccak256(logs[i].data) == keccak256(abi.encode(uint8(1), ask, uint256(1200), uint64(1))));
            }
        }
        require(starts == 1 && sales == 1 && economics == 1);
    }
    function testSecondPaidMintInSameBlockRejectedButNextBlockSucceeds() public {
        vm.warp(START + 3600); mintPaid("Alpha", 1000);
        MintInterface.Authorization memory a = auth("Beta", 1, type(uint256).max, 2000, A); bytes memory signature = sign(a);
        vm.expectRevert(MintInterface.PaidMintAlreadyInBlock.selector); vm.prank(A);
        gallery.mintPaid{value: 2000}("Beta", "INTJ", a, signature); unused(a);
        vm.roll(101); vm.prank(A); gallery.mintPaid{value: 2000}("Beta", "INTJ", a, signature);
        require(gallery.getPulseState().epochIndex == 2 && gallery.saleStatus().lastPaidMintBlock == 101);
    }
    function testWrongValueAndPriceAboveCeilingPreserveEligibility() public {
        vm.warp(START + 3600);
        MintInterface.Authorization memory a = auth("Alpha", 1, type(uint256).max, 1000, A); bytes memory signature = sign(a);
        vm.expectRevert(abi.encodeWithSelector(MintInterface.ValueMismatch.selector, uint256(1000), uint256(999)));
        vm.prank(A); gallery.mintPaid{value: 999}("Alpha", "INTJ", a, signature); unused(a);
        a = auth("Alpha", 1, type(uint256).max, 999, A); signature = sign(a);
        vm.expectRevert(abi.encodeWithSelector(MintInterface.PriceAboveLimit.selector, uint256(1000), uint256(999)));
        vm.prank(A); gallery.mintPaid{value: 999}("Alpha", "INTJ", a, signature); unused(a);
        require(gallery.getPulseState().epochIndex == 0 && gallery.saleStatus().lastPaidMintBlock == 0);
        mintPaid("Alpha", 1000); // Failed attempts did not consume this block.
    }
    function testRejectingTreasuryRollsBackThenSameAuthorityCanSucceed() public {
        TogglePulseTreasury receiver = new TogglePulseTreasury();
        MintInterface.SaleConfig memory c = sale(); c.treasury = payable(address(receiver)); gallery = deploy(c); activate(gallery);
        vm.warp(START + 3600);
        MintInterface.Authorization memory a = auth("Alpha", 1, type(uint256).max, 1200, A); bytes memory signature = sign(a);
        uint256 walletBefore = A.balance;
        vm.expectRevert(MintInterface.TreasuryPaymentFailed.selector); vm.prank(A);
        gallery.mintPaid{value: 1200}("Alpha", "INTJ", a, signature);
        unused(a); require(A.balance == walletBefore && address(receiver).balance == 0 && address(gallery).balance == 0);
        require(gallery.getPulseState().epochIndex == 0 && gallery.saleStatus().lastPaidMintBlock == 0 && gallery.freeMinted() == 0);
        require(gallery.saleStatus().paidStartTime == START + 3600, "effective deadline not preserved");
        receiver.allow(); vm.recordLogs(); vm.prank(A); gallery.mintPaid{value: 1200}("Alpha", "INTJ", a, signature);
        PulseMintVm.Log[] memory logs = vm.getRecordedLogs(); uint256 starts;
        for (uint256 i; i < logs.length; ++i) if (logs[i].topics[0] == keccak256("PaidPhaseStarted(uint64,uint8,uint256)")) ++starts;
        require(starts == 1, "failed attempt persisted phase event");
        require(address(receiver).balance == 1000 && A.balance == walletBefore - 1000);
    }
    function testZeroAskIsStillPaidAndSkipsRejectingTreasury() public {
        TogglePulseTreasury receiver = new TogglePulseTreasury();
        MintInterface.SaleConfig memory c = sale(); c.pulse = IPulseCore.Config(1, 1, 0, 1); c.treasury = payable(address(receiver));
        gallery = deploy(c); activate(gallery); vm.warp(START + 3602);
        require(gallery.getCurrentPrice() == 0); mintPaid("Alpha", 0);
        require(gallery.getPulseState().epochIndex == 1 && gallery.saleStatus().lastPaidMintBlock == 100);
        require(address(receiver).balance == 0 && gallery.ownerOf(uint256(gallery.handleKey("Alpha"))) == A);
    }
    function testTimeAndBlockNarrowingCannotWrap() public {
        vm.warp(uint256(type(uint64).max) + 1);
        vm.expectRevert(MintInterface.TimeOutOfRange.selector); gallery.saleStatus();
        vm.expectRevert(MintInterface.TimeOutOfRange.selector); gallery.getCurrentPrice();
        vm.warp(START + 3600); vm.roll(uint256(type(uint64).max) + 1);
        MintInterface.Authorization memory a = auth("Alpha", 1, type(uint256).max, 1000, A); bytes memory signature = sign(a);
        vm.expectRevert(MintInterface.BlockOutOfRange.selector); vm.prank(A);
        gallery.mintPaid{value: 1000}("Alpha", "INTJ", a, signature); unused(a);
    }
    function testRuntimeFitsChainLimitsAndNoReceiveFallback() public {
        require(address(gallery).code.length <= 24576, "EIP-170 runtime limit");
        require(type(Gallery).creationCode.length + 32 * 20 <= 49152, "EIP-3860 initcode limit");
        (bool accepted,) = address(gallery).call(""); require(!accepted, "receive/fallback added");
    }
}
