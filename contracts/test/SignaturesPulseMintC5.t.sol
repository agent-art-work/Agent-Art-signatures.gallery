// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PulseMintFixture, Gallery, MintInterface, IPulseCore} from "./SignaturesPulseMintV1RC1.t.sol";

interface PulseReviewVm {
    function getNonce(address) external view returns (uint64);
    function computeCreateAddress(address, uint256) external pure returns (address);
}

contract PulseMintC5ReviewTest is PulseMintFixture {
    function _rejectSignature(MintInterface.Authorization memory a, bytes memory sig) private {
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", a, sig, proof(0));
        unused(a); require(gallery.freeMinted() == 0 && !gallery.isFreeSlotClaimed(0));
    }

    function testMalformedMalleableAndOldDomainSignaturesReject() public {
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, A);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, gallery.authorizationDigest(a));
        _rejectSignature(a, bytes(""));
        _rejectSignature(a, abi.encodePacked(r, s));
        _rejectSignature(a, abi.encodePacked(r, s, uint8(0)));
        uint256 order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        _rejectSignature(a, abi.encodePacked(r, bytes32(order - uint256(s)), v == 27 ? uint8(28) : uint8(27)));
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("SignaturesGenerativeMintRC1"), keccak256("1"), block.chainid, address(gallery)));
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domain, keccak256(abi.encode(gallery.AUTHORIZATION_TYPEHASH(), a))));
        (v, r, s) = vm.sign(1, digest);
        _rejectSignature(a, abi.encodePacked(r, s, v));
        mintFree("Alpha", 0, A);
    }

    function testRotationRestorationAndRevocationSemanticsRemainExplicit() public {
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, A); bytes memory sig = sign(a);
        vm.prank(MANAGER); gallery.setTrustedAuthorizer(B);
        _rejectSignature(a, sig);
        vm.prank(MANAGER); gallery.setTrustedAuthorizer(signer);
        vm.prank(REVOKER); gallery.revokeNonce(a.nonce);
        vm.expectRevert(Gallery.NonceUnavailable.selector); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", a, sig, proof(0));
        require(gallery.freeMinted() == 0 && gallery.revokedNonces(a.nonce));
        MintInterface.Authorization memory b = auth("Beta", 0, 2, 0, A); bytes memory other = sign(b);
        vm.prank(MANAGER); gallery.setTrustedAuthorizer(B);
        vm.prank(MANAGER); gallery.setTrustedAuthorizer(signer);
        vm.prank(A); gallery.mintFree("Beta", "INTJ", b, other, proof(2));
        uint256 id = uint256(b.handleKey);
        vm.prank(PAUSER); gallery.pauseMinting();
        vm.prank(A); gallery.transferFrom(A, B, id);
        (string memory handle, string memory mbti) = gallery.inputs(id);
        require(gallery.ownerOf(id) == B && gallery.mintedHandle(b.handleKey));
        require(keccak256(bytes(handle)) == keccak256("Beta") && keccak256(bytes(mbti)) == keccak256("INTJ"));
        (,, address original) = gallery.provenance(id); require(original == A);
    }

    function testSelfTreasuryAndEveryZeroAuthorityRejectAtConstruction() public {
        PulseReviewVm review = PulseReviewVm(address(vm));
        MintInterface.SaleConfig memory c = sale();
        c.treasury = payable(review.computeCreateAddress(address(this), review.getNonce(address(this))));
        vm.expectRevert(MintInterface.InvalidSaleConfiguration.selector); deploy(c);
        for (uint256 i; i < 5; ++i) {
            MintInterface.Authorities memory roles = authorities();
            if (i == 0) roles.admin = address(0);
            else if (i == 1) roles.manager = address(0);
            else if (i == 2) roles.pauser = address(0);
            else if (i == 3) roles.revoker = address(0);
            else roles.authorizer = address(0);
            c = sale();
            vm.expectRevert();
            new Gallery(address(renderer), MintInterface.CoreBinding(31337, core), c, roles);
        }
    }

    function testValidLaunchCanExhaustArithmeticHeadroomWithoutChangingState() public {
        MintInterface.SaleConfig memory c = sale();
        c.pulse = IPulseCore.Config(1, type(uint256).max - 1, type(uint256).max - 2, 1);
        gallery = deploy(c); activate(gallery); vm.warp(START + 3603);
        require(gallery.getCurrentPrice() == type(uint256).max - 2);
        MintInterface.Authorization memory a = auth("Alpha", 1, type(uint256).max, 0, A); bytes memory sig = sign(a);
        vm.expectRevert(IPulseCore.TargetPriceOverflow.selector); vm.prank(A);
        gallery.mintPaid("Alpha", "INTJ", a, sig);
        unused(a);
        require(gallery.getPulseState().epochIndex == 0 && gallery.saleStatus().lastPaidMintBlock == 0);
        require(A.balance == 10 ether && TREASURY.balance == 0 && address(gallery).balance == 0);
    }

    function testPaidBlockZeroSentinelCannotPermitSecondPaidMint() public {
        vm.warp(START + 3600); vm.roll(0); mintPaid("Alpha", 1000);
        MintInterface.Authorization memory a = auth("Beta", 1, type(uint256).max, 1200, A); bytes memory sig = sign(a);
        vm.expectRevert(MintInterface.PaidMintAlreadyInBlock.selector); vm.prank(A);
        gallery.mintPaid{value: 1200}("Beta", "INTJ", a, sig); unused(a);
        vm.roll(1); vm.prank(A); gallery.mintPaid{value: 1200}("Beta", "INTJ", a, sig);
        require(gallery.getPulseState().epochIndex == 2);
    }
}
