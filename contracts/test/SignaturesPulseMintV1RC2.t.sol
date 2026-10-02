// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SignaturesPulseMintV1RC2 as Gallery} from "../src/release/SignaturesPulseMintV1RC2.sol";
import {ISignaturesPulseMintV1RC2 as MintInterface} from "../src/release/ISignaturesPulseMintV1RC2.sol";
import {SignatureRendererV1RC1} from "../src/release/SignatureRendererV1RC1.sol";
import {IPulseCore} from "../vendor/pulse-core-v1.0.0/IPulseCore.sol";
import {PulseCoreReleaseData} from "./fixtures/PulseCoreReleaseData.sol";

interface RC2MintVm {
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

contract RC2ToggleTreasury {
    bool public reject = true;
    function allow() external { reject = false; }
    receive() external payable { require(!reject, "reject ETH"); }
}

contract RC2CallbackProbe {
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

abstract contract RC2MintFixture {
    RC2MintVm internal constant vm = RC2MintVm(address(uint160(uint256(keccak256("hevm cheat code")))));
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
        return MintInterface.SaleConfig(ROOT, 3, 3, START + 3600, payable(TREASURY), IPulseCore.Config(600, 1000, 900, 1));
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
            uint64(block.timestamp), deadline, mode, slot, cap, mode == 0 ? gallery.freeConfigRevision() : 0);
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

    address internal constant C = 0x3333333333333333333333333333333333333333;
    bytes32 internal constant ROTATED_ROOT = 0x5e362c7952aeec8f28d75a82f8a2cfbaf700f624aa1dcadb0fb4e16814547990;
    bytes32 internal constant EXPANDED_ROOT = 0xbcd2e25dcb9e4f849c639e22d158b7b9c143ad6f4008ddf91bd28525bb2c08d5;

    function pause() internal { vm.prank(PAUSER); gallery.pauseMinting(); }
    function configure(bytes32 root, uint256 slots, uint256 quota) internal {
        vm.prank(ADMIN); gallery.configureFreeMint(root, slots, quota);
    }
    function rotatedProof(uint256 slot) internal pure returns (bytes32[] memory p) {
        if (slot == 0) { p = new bytes32[](2); p[0] = 0xc2ceb1212bc8227979fe9f384b22d0c77a49547981a7a40b4dbb2886abdfe7b6; p[1] = 0xd24381ffdbca19327cb0117d15c0a6fbb005d98ac3206a50e7b6485de726f89c; }
        else if (slot == 1) { p = new bytes32[](2); p[0] = 0xcf5dfb9235446a86541f6e1fe3bb2d63122b62eb1be8377c0e830bce16f141b3; p[1] = 0xd24381ffdbca19327cb0117d15c0a6fbb005d98ac3206a50e7b6485de726f89c; }
        else if (slot == 2) { p = new bytes32[](1); p[0] = 0xd2e45fc1881058f9d28b70a79b63402df49b1dac9351fcddc1cf5e005bb02ea2; }
        else revert("unknown rotated slot");
    }
    function expandedProof(uint256 slot) internal pure returns (bytes32[] memory p) {
        if (slot == 0) { p = new bytes32[](2); p[0] = 0x7b4e4429a12d7c7f52f97ac3310a7f766c8a424a830a3b5423010430bc468c18; p[1] = 0x032fceeb126e3a08f9e368ebb3b83532d22e347a89b6beb48dd663ed77bd7576; }
        else if (slot == 1) { p = new bytes32[](2); p[0] = 0x53d1ea11c02bccf00efa13950923d7ec0991024794dcc0a5de4788c13baf062c; p[1] = 0x032fceeb126e3a08f9e368ebb3b83532d22e347a89b6beb48dd663ed77bd7576; }
        else if (slot == 2) { p = new bytes32[](2); p[0] = 0xfde32787fa05c6ddfad51646c57f70f1a69ec91522ba0ef3e6ff9aef8b97ec1a; p[1] = 0x3240c86f751f8d996187613ec9d2dfe7a6d0155da0b13a82d05b94ea59838d94; }
        else if (slot == 3) { p = new bytes32[](2); p[0] = 0xd24381ffdbca19327cb0117d15c0a6fbb005d98ac3206a50e7b6485de726f89c; p[1] = 0x3240c86f751f8d996187613ec9d2dfe7a6d0155da0b13a82d05b94ea59838d94; }
        else revert("unknown expanded slot");
    }
    function mintWithProof(string memory handle, uint256 slot, address wallet, bytes32[] memory p) internal returns (uint256) {
        MintInterface.Authorization memory a = auth(handle, 0, slot, 0, wallet);
        bytes memory signature = sign(a);
        vm.prank(wallet); return gallery.mintFree(handle, "INTJ", a, signature, p);
    }
}

contract PulseMintRC2ConfigurationTest is RC2MintFixture {
    function testInitialConfigurationAndTypedAuthorizationIdentity() public view {
        require(gallery.freeMintQuota() == 3 && gallery.freeConfigRevision() == 1);
        require(keccak256(bytes(gallery.VERSION())) == keccak256("sg-generative-pulse-mint-1.0.0-rc.2"));
        require(keccak256(bytes(gallery.INPUT_PROFILE())) == keccak256("sg-generative-pulse-inputs-v1-rc1"));
        require(address(gallery.renderer()) == address(renderer));
        MintInterface.SaleStatus memory status = gallery.saleStatus();
        require(status.freeSlotCount == 3 && status.freeMintQuota == 3 && status.freeConfigRevision == 1);
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, A);
        bytes32 separator = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("SignaturesPulseMintRC2"), keccak256("1"), uint256(31337), address(gallery)
        ));
        bytes32 typeHash = keccak256(
            "PulseMintAuthorization(bytes32 handleKey,bytes32 assessmentDigest,bytes32 inputDigest,address recipient,bytes32 nonce,uint64 issuedAt,uint64 deadline,uint8 mintMode,uint256 slotId,uint256 maxPrice,uint64 freeConfigRevision)"
        );
        require(gallery.AUTHORIZATION_TYPEHASH() == typeHash);
        require(gallery.authorizationDigest(a) == keccak256(abi.encodePacked(hex"1901", separator, keccak256(abi.encode(typeHash, a)))));
        MintInterface.SaleConfig memory c = sale();
        require(gallery.saleConfigHash() == keccak256(abi.encode("signatures.gallery/pulse-sale/v1-rc2",
            uint256(31337), address(gallery), core, CORE_HASH, gallery.rendererIdentity(), TREASURY,
            ROOT, uint256(3), uint256(3), c.freeDeadline, c.pulse)));
    }

    function testConstructorRejectsZeroAndOversizedQuota() public {
        MintInterface.SaleConfig memory c = sale();
        c.freeMintQuota = 0; vm.expectRevert(MintInterface.InvalidSaleConfiguration.selector); deploy(c);
        c.freeMintQuota = 4; vm.expectRevert(MintInterface.InvalidSaleConfiguration.selector); deploy(c);
        c.freeMintQuota = 1; Gallery next = deploy(c);
        require(next.paused() && next.freeSlotCount() == 3 && next.freeMintQuota() == 1);
    }

    function testOnlyDefaultAdminCanConfigureAndOnlyWhilePaused() public {
        vm.expectRevert(bytes4(keccak256("ExpectedPause()"))); configure(ROOT, 3, 2);
        pause();
        address[4] memory others = [MANAGER, PAUSER, REVOKER, A];
        for (uint256 i; i < others.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("AccessControlUnauthorizedAccount(address,bytes32)")), others[i], bytes32(0)));
            vm.prank(others[i]); gallery.configureFreeMint(ROOT, 3, 2);
        }
        require(gallery.freeConfigRevision() == 1 && gallery.freeMintQuota() == 3);
        configure(ROOT, 3, 2);
        require(gallery.freeConfigRevision() == 2 && gallery.freeMintQuota() == 2 && gallery.paused());
    }

    function testConfigurationEventBindsExactPolicyAndInitialSaleCommitmentStaysUnchanged() public {
        pause(); bytes32 initial = gallery.saleConfigHash();
        vm.recordLogs(); configure(EXPANDED_ROOT, 4, 2);
        RC2MintVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(gallery));
        require(logs[0].topics[0] == keccak256("FreeMintConfigured(bytes32,bytes32,uint256,uint256,uint64)"));
        require(logs[0].topics[1] == keccak256(abi.encode(EXPANDED_ROOT, uint256(4), uint256(2), uint64(2))));
        require(keccak256(logs[0].data) == keccak256(abi.encode(EXPANDED_ROOT, uint256(4), uint256(2), uint64(2))));
        require(gallery.saleConfigHash() == initial && gallery.freeDeadline() == START + 3600);
        require(gallery.freeMintRoot() == EXPANDED_ROOT && gallery.freeSlotCount() == 4 && gallery.freeMintQuota() == 2);
    }

    function testInvalidConfigurationCannotChangeRevisionOrConsumeSlots() public {
        mintFree("Alpha", 0, A); pause();
        vm.expectRevert(MintInterface.InvalidSaleConfiguration.selector); configure(bytes32(0), 3, 2);
        vm.expectRevert(MintInterface.InvalidSaleConfiguration.selector); configure(ROOT, 0, 2);
        vm.expectRevert(MintInterface.InvalidSaleConfiguration.selector); configure(ROOT, 2, 2);
        vm.expectRevert(MintInterface.InvalidSaleConfiguration.selector); configure(ROOT, 3, 4);
        vm.expectRevert(MintInterface.InvalidSaleConfiguration.selector); configure(ROOT, 3, 0);
        require(gallery.freeMintRoot() == ROOT && gallery.freeSlotCount() == 3 && gallery.freeMintQuota() == 3);
        require(gallery.freeConfigRevision() == 1 && gallery.freeMinted() == 1 && gallery.isFreeSlotClaimed(0));
        require(!gallery.isFreeSlotClaimed(1) && !gallery.isFreeSlotClaimed(2));
        configure(ROOT, 3, 2);
        require(gallery.saleStatus().phase == MintInterface.Phase.Free);
    }

    function testQuotaEqualsAlreadyMintedClosesAtConfigurationTimeAndNeverReopens() public {
        mintFree("Alpha", 0, A); pause(); vm.warp(START + 20);
        vm.recordLogs(); configure(ROOT, 3, 1);
        RC2MintVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2 && logs[1].topics[0] == keccak256("PaidPhaseStarted(uint64,uint8,uint256)"));
        require(keccak256(logs[1].data) == keccak256(abi.encode(uint64(START + 20), MintInterface.EndReason.Exhausted, uint256(1))));
        MintInterface.SaleStatus memory status = gallery.saleStatus();
        require(status.paused && status.phase == MintInterface.Phase.Paid && status.endReason == MintInterface.EndReason.Exhausted);
        require(status.freeMintQuota == 1 && status.freeMinted == 1 && status.paidStartTime == START + 20);
        require(gallery.getPulseState().openTime == START + 20 && gallery.getCurrentPrice() == 1000);
        vm.expectRevert(MintInterface.FreeMintClosed.selector); configure(EXPANDED_ROOT, 4, 4);
        require(gallery.freeConfigRevision() == 2 && gallery.freeMintQuota() == 1);
        activate(gallery); mintPaid("Beta", 1200);
        require(gallery.getPulseState().epochIndex == 1 && gallery.freeMinted() == 1);
    }

    function testZeroQuotaBeforeAnyMintEndsFreeWithoutAnAdminMint() public {
        pause(); configure(ROOT, 3, 0);
        MintInterface.SaleStatus memory status = gallery.saleStatus();
        require(status.phase == MintInterface.Phase.Paid && status.freeMinted == 0 && status.freeMintQuota == 0);
        require(status.paidStartTime == START && status.endReason == MintInterface.EndReason.Exhausted);
        require(!gallery.isFreeSlotClaimed(0) && gallery.balanceOf(ADMIN) == 0);
    }

    function testQuotaDoesNotHaveToConsumeEveryAllowlistSlot() public {
        pause(); configure(ROOT, 3, 2); activate(gallery);
        mintFree("Alpha", 0, A); mintFree("Beta", 2, A);
        require(gallery.freeMinted() == 2 && !gallery.isFreeSlotClaimed(1));
        require(gallery.saleStatus().phase == MintInterface.Phase.Paid);
        MintInterface.Authorization memory a = auth("Gamma", 0, 1, 0, B);
        rejectFree(a, "Gamma", proof(1), MintInterface.FreeMintClosed.selector);
    }

    function testAddingSlotsAndIncreasingQuotaPreservesExistingClaims() public {
        mintFree("Alpha", 0, A); pause(); configure(EXPANDED_ROOT, 4, 4); activate(gallery);
        require(gallery.isFreeSlotClaimed(0) && gallery.freeMinted() == 1);
        mintWithProof("Beta", 2, A, expandedProof(2));
        vm.deal(C, 10 ether); uint256 id = mintWithProof("Gamma", 3, C, expandedProof(3));
        require(gallery.ownerOf(id) == C && gallery.freeMinted() == 3 && gallery.saleStatus().phase == MintInterface.Phase.Free);
        mintWithProof("Delta", 1, B, expandedProof(1));
        require(gallery.freeMinted() == 4 && gallery.saleStatus().phase == MintInterface.Phase.Paid);
    }

    function testReplacingAClaimedSlotWalletNeverRevivesTheSlot() public {
        mintFree("Alpha", 0, A); pause(); configure(ROTATED_ROOT, 3, 3); activate(gallery);
        require(gallery.isFreeSlotClaimed(0));
        MintInterface.Authorization memory a = auth("Beta", 0, 0, 0, B);
        rejectFree(a, "Beta", rotatedProof(0), MintInterface.SlotAlreadyClaimed.selector);
        require(gallery.freeMinted() == 1 && gallery.balanceOf(B) == 0);
        mintWithProof("Gamma", 1, A, rotatedProof(1));
        mintWithProof("Delta", 2, A, rotatedProof(2));
        require(gallery.balanceOf(A) == 3 && gallery.freeMinted() == 3);
    }

    function testChangedRootRejectsOldProofEvenWithFreshAuthorization() public {
        pause(); configure(ROTATED_ROOT, 3, 3); activate(gallery);
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, A);
        rejectFree(a, "Alpha", proof(0), MintInterface.InvalidSlotProof.selector);
        uint256 id = mintWithProof("Beta", 0, B, rotatedProof(0));
        require(gallery.ownerOf(id) == B && gallery.freeMinted() == 1);
    }

    function testStaleSignedRevisionCannotUseAReplacementProof() public {
        MintInterface.Authorization memory a = auth("Alpha", 0, 2, 0, A);
        bytes memory oldSignature = sign(a); pause(); configure(ROTATED_ROOT, 3, 3); activate(gallery);
        vm.expectRevert(MintInterface.InvalidFreeConfigRevision.selector); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", a, oldSignature, rotatedProof(2)); unused(a);
        a.freeConfigRevision = gallery.freeConfigRevision();
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", a, oldSignature, rotatedProof(2)); unused(a);
        bytes memory fresh = sign(a); vm.prank(A); gallery.mintFree("Alpha", "INTJ", a, fresh, rotatedProof(2));
        require(gallery.freeMinted() == 1 && gallery.isFreeSlotClaimed(2));
    }

    function testQuotaOnlyAndSamePolicyUpdatesAlsoInvalidateEarlierFreeAuthorization() public {
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, A);
        bytes memory signature = sign(a); pause(); configure(ROOT, 3, 3); activate(gallery);
        vm.expectRevert(MintInterface.InvalidFreeConfigRevision.selector); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", a, signature, proof(0)); unused(a);
        pause(); configure(ROOT, 3, 2); activate(gallery);
        require(gallery.freeConfigRevision() == 3);
        vm.expectRevert(MintInterface.InvalidFreeConfigRevision.selector); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", a, signature, proof(0)); unused(a);
    }

    function testEffectiveDeadlineClosesConfigurationEvenBeforeFirstPaidTransaction() public {
        pause(); vm.warp(START + 3600);
        vm.expectRevert(MintInterface.FreeMintClosed.selector); configure(EXPANDED_ROOT, 4, 4);
        MintInterface.SaleStatus memory status = gallery.saleStatus();
        require(status.phase == MintInterface.Phase.Paid && status.endReason == MintInterface.EndReason.Deadline);
        require(status.paidStartTime == START + 3600 && gallery.freeConfigRevision() == 1);
        require(gallery.getPulseState().openTime == START + 3600);
    }

    function testPaidMintsRequireZeroFreeRevisionAndPreserveRefundAndBlockLimit() public {
        pause(); configure(ROOT, 3, 0); activate(gallery);
        MintInterface.Authorization memory a = auth("Alpha", 1, type(uint256).max, 1200, A);
        a.freeConfigRevision = 2; bytes memory signature = sign(a);
        vm.expectRevert(MintInterface.InvalidFreeConfigRevision.selector); vm.prank(A);
        gallery.mintPaid{value: 1200}("Alpha", "INTJ", a, signature); unused(a);
        a.freeConfigRevision = 0; signature = sign(a);
        uint256 beforeWallet = A.balance; uint256 beforeTreasury = TREASURY.balance;
        vm.prank(A); gallery.mintPaid{value: 1200}("Alpha", "INTJ", a, signature);
        require(A.balance == beforeWallet - 1000 && TREASURY.balance == beforeTreasury + 1000 && address(gallery).balance == 0);
        a = auth("Beta", 1, type(uint256).max, 2000, A); signature = sign(a);
        vm.expectRevert(MintInterface.PaidMintAlreadyInBlock.selector); vm.prank(A);
        gallery.mintPaid{value: 2000}("Beta", "INTJ", a, signature); unused(a);
        vm.roll(101); vm.prank(A); gallery.mintPaid{value: 2000}("Beta", "INTJ", a, signature);
        require(gallery.getPulseState().epochIndex == 2 && gallery.freeMinted() == 0);
        pause(); vm.expectRevert(MintInterface.FreeMintClosed.selector); configure(ROOT, 3, 3);
    }

    function testRejectedMintDoesNotConsumeQuotaSlotNonceOrRevision() public {
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, A);
        bytes memory signature = sign(a); a.inputDigest = bytes32(uint256(1));
        vm.expectRevert(Gallery.InputDigestMismatch.selector); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", a, signature, proof(0)); unused(a);
        require(gallery.freeMinted() == 0 && gallery.freeConfigRevision() == 1 && !gallery.isFreeSlotClaimed(0));
        pause(); configure(ROOT, 3, 2); activate(gallery);
        mintFree("Alpha", 0, A);
        require(gallery.freeMinted() == 1 && gallery.freeConfigRevision() == 2);
    }

    function testNewDefaultAdminInheritsPolicyAuthorityAfterDelay() public {
        vm.prank(ADMIN); gallery.beginDefaultAdminTransfer(B);
        vm.warp(START + 2 days + 1); vm.prank(B); gallery.acceptDefaultAdminTransfer();
        // The delay outlasts this fixture's free window, so even the new admin
        // cannot reopen it. Roles do not confer a phase reset.
        pause(); vm.expectRevert(MintInterface.FreeMintClosed.selector); vm.prank(B);
        gallery.configureFreeMint(ROOT, 3, 3);
        require(gallery.defaultAdmin() == B);
    }

    function testAdminTransferDuringFreeWindowMovesConfigurationAuthorityWithoutResettingClaims() public {
        MintInterface.SaleConfig memory c = sale(); c.freeDeadline = START + 7 days;
        gallery = deploy(c); activate(gallery); mintFree("Alpha", 0, A);
        vm.prank(ADMIN); gallery.beginDefaultAdminTransfer(B);
        vm.warp(START + 2 days + 1); vm.prank(B); gallery.acceptDefaultAdminTransfer(); pause();
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("AccessControlUnauthorizedAccount(address,bytes32)")), ADMIN, bytes32(0)));
        vm.prank(ADMIN); gallery.configureFreeMint(ROOT, 3, 2);
        vm.prank(B); gallery.configureFreeMint(EXPANDED_ROOT, 4, 3);
        require(gallery.defaultAdmin() == B && gallery.isFreeSlotClaimed(0) && gallery.freeMinted() == 1);
        require(gallery.freeConfigRevision() == 2 && gallery.saleStatus().phase == MintInterface.Phase.Free);
        require(gallery.freeDeadline() == START + 7 days);
    }

    function testRC1DomainSignatureCannotAuthorizeAnRC2FreeMint() public {
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, A);
        bytes32 oldSeparator = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("SignaturesPulseMintRC1"), keccak256("1"), uint256(31337), address(gallery)
        ));
        bytes32 oldDomainDigest = keccak256(abi.encodePacked(hex"1901", oldSeparator, keccak256(abi.encode(gallery.AUTHORIZATION_TYPEHASH(), a))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, oldDomainDigest);
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", a, abi.encodePacked(r, s, v), proof(0)); unused(a);
        require(!gallery.isFreeSlotClaimed(0) && gallery.freeMinted() == 0);
    }

    function testTreasuryCallbackCannotReenterNewConfigurationMutation() public {
        RC2CallbackProbe probe = new RC2CallbackProbe();
        MintInterface.SaleConfig memory c = sale(); c.treasury = payable(address(probe));
        MintInterface.Authorities memory roles = authorities(); roles.admin = address(probe); roles.pauser = address(probe);
        gallery = new Gallery(address(renderer), MintInterface.CoreBinding(31337, core), c, roles);
        vm.prank(address(probe)); gallery.unpauseMinting(); vm.warp(START + 3600);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(gallery.configureFreeMint, (ROOT, uint256(3), uint256(3)));
        calls[1] = abi.encodeCall(gallery.pauseMinting, ());
        probe.configure(address(gallery), calls);
        mintPaid("Alpha", 1200);
        require(probe.blocked() == 2 && gallery.freeConfigRevision() == 1 && !gallery.paused());
        require(gallery.getPulseState().epochIndex == 1 && gallery.ownerOf(uint256(gallery.handleKey("Alpha"))) == A);
    }

    function testFuzzQuotaWithinCapacityAlwaysClosesAtConfiguredSuccessfulCount(uint8 quotaSeed) public {
        uint256 quota = uint256(quotaSeed) % 3 + 1;
        pause(); configure(ROOT, 3, quota); activate(gallery);
        mintFree("Alpha", 0, A);
        if (quota > 1) mintFree("Beta", 2, A);
        if (quota > 2) mintFree("Gamma", 1, B);
        require(gallery.freeMinted() == quota && gallery.freeMintQuota() == quota);
        require(gallery.saleStatus().phase == MintInterface.Phase.Paid);
    }
}
