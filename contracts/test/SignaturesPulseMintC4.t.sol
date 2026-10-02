// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PulseMintFixture, PulseMintVm, TogglePulseTreasury, Gallery, MintInterface, IPulseCore} from "./SignaturesPulseMintV1RC1.t.sol";

/// @notice Adversarial checks for the C3 candidate. These use the pinned release
///         core but derive economic expectations without calling its quote/advance.
contract PulseMintC4AdversarialTest is PulseMintFixture {
    function _failedFree(string memory handle, MintInterface.Authorization memory a, bytes memory signature, bytes32[] memory p)
        private
    {
        uint256 beforeCount = gallery.freeMinted();
        uint256 beforeBalance = address(gallery).balance;
        vm.expectRevert(); vm.prank(a.recipient);
        gallery.mintFree(handle, "INTJ", a, signature, p);
        require(gallery.freeMinted() == beforeCount && address(gallery).balance == beforeBalance, "failed free changed economics");
        unused(a);
    }

    function testStolenSlotWrongWalletAndForgedSlot() public {
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, B);
        _failedFree("Alpha", a, sign(a), proof(0));
        a = auth("Alpha", 0, 1, 0, A);
        _failedFree("Alpha", a, sign(a), proof(0));
        require(!gallery.isFreeSlotClaimed(0) && !gallery.isFreeSlotClaimed(1));
        mintFree("Alpha", 0, A);
    }

    function testSignerDomainAndAllSignedFieldsCannotBeSubstituted() public {
        MintInterface.Authorization memory original = auth("Alpha", 0, 0, 0, A);
        bytes memory signature = sign(original);
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, A);
        a.assessmentDigest = keccak256("other assessment"); _failedFree("Alpha", a, signature, proof(0));
        a = auth("Alpha", 0, 0, 0, A); a.nonce = keccak256("other nonce"); _failedFree("Alpha", a, signature, proof(0));
        a = auth("Alpha", 0, 0, 0, A); a.slotId = 2; _failedFree("Alpha", a, signature, proof(2));
        a = auth("Alpha", 0, 0, 0, A); a.deadline -= 1; _failedFree("Alpha", a, signature, proof(0));
        a = auth("Alpha", 0, 0, 0, A); a.recipient = B; _failedFree("Alpha", a, signature, proof(0));
        a = auth("Alpha", 0, 0, 0, A); a.handleKey = gallery.handleKey("Beta"); _failedFree("Beta", a, signature, proof(0));
        a = auth("Alpha", 0, 0, 0, A); a.inputDigest = gallery.inputDigest("Alpha", "ENTJ"); _failedFree("Alpha", a, signature, proof(0));
        a = auth("Alpha", 0, 0, 0, A); a.issuedAt += 1; _failedFree("Alpha", a, signature, proof(0));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(2, gallery.authorizationDigest(original));
        _failedFree("Alpha", original, abi.encodePacked(r, s, v), proof(0));
        Gallery another = deploy(sale()); activate(another);
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(A);
        another.mintFree("Alpha", "INTJ", original, signature, proof(0));
        require(!another.usedNonces(original.nonce) && another.freeMinted() == 0);
        vm.chainId(11155111);
        vm.expectRevert(MintInterface.WrongChain.selector); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", original, signature, proof(0));
        vm.chainId(31337);
        vm.prank(A); gallery.mintFree("Alpha", "INTJ", original, signature, proof(0));
    }

    function testValidSignatureCannotBeUsedByDifferentSenderOrAfterReplay() public {
        MintInterface.Authorization memory a = auth("Alpha", 0, 0, 0, A);
        bytes memory signature = sign(a);
        vm.expectRevert(Gallery.WrongRecipient.selector); vm.prank(B);
        gallery.mintFree("Alpha", "INTJ", a, signature, proof(0));
        vm.prank(A); gallery.mintFree("Alpha", "INTJ", a, signature, proof(0));
        vm.expectRevert(); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", a, signature, proof(0));
        require(gallery.freeMinted() == 1 && gallery.isFreeSlotClaimed(0));
        require(gallery.balanceOf(A) == 1 && gallery.usedNonces(a.nonce));
    }

    function testFinalSlotCompetitionAndDeadlineEqualityNeverReopenFree() public {
        mintFree("Alpha", 0, A); mintFree("Beta", 2, A);
        MintInterface.Authorization memory loser = auth("Gamma", 0, 1, 0, B);
        bytes memory loserSignature = sign(loser);
        mintFree("Gamma", 1, B);
        require(gallery.freeMinted() == gallery.freeSlotCount());
        vm.expectRevert(MintInterface.FreeMintClosed.selector); vm.prank(B);
        gallery.mintFree("Delta", "INTJ", loser, loserSignature, proof(1));
        vm.warp(START + 3600);
        require(gallery.saleStatus().phase == MintInterface.Phase.Paid);
        MintInterface.Authorization memory afterClose = auth("Delta", 0, 0, 0, A);
        vm.expectRevert(MintInterface.FreeMintClosed.selector); vm.prank(A);
        gallery.mintFree("Delta", "INTJ", afterClose, bytes(""), proof(0));
        require(gallery.freeMinted() == 3 && gallery.getPulseState().openTime == START);
    }

    function testPauseAcrossDeadlineAndExpiredAuthorizationHaveNoSideEffects() public {
        MintInterface.Authorization memory freeA = auth("Alpha", 0, 0, 0, A);
        bytes memory freeSignature = sign(freeA);
        vm.prank(PAUSER); gallery.pauseMinting();
        vm.warp(START + 3600);
        vm.expectRevert(); vm.prank(A);
        gallery.mintFree("Alpha", "INTJ", freeA, freeSignature, proof(0));
        require(gallery.saleStatus().phase == MintInterface.Phase.Paid && gallery.freeMinted() == 0);
        activate(gallery);
        MintInterface.Authorization memory paidA = auth("Alpha", 1, type(uint256).max, 1000, A);
        bytes memory paidSignature = sign(paidA);
        vm.warp(paidA.deadline);
        uint256 treasuryBefore = TREASURY.balance;
        vm.expectRevert(Gallery.AuthorizationExpired.selector); vm.prank(A);
        gallery.mintPaid{value: 1000}("Alpha", "INTJ", paidA, paidSignature);
        require(TREASURY.balance == treasuryBefore && gallery.getPulseState().epochIndex == 0);
        require(gallery.saleStatus().lastPaidMintBlock == 0 && !gallery.usedNonces(paidA.nonce));
    }

    function testSameBlockAndUnderpaymentCannotConsumeEpochOrBlock() public {
        vm.warp(START + 3600);
        MintInterface.Authorization memory a = auth("Alpha", 1, type(uint256).max, 1000, A);
        bytes memory sig = sign(a);
        vm.expectRevert(); vm.prank(A); gallery.mintPaid{value: 999}("Alpha", "INTJ", a, sig);
        require(gallery.getPulseState().epochIndex == 0 && gallery.saleStatus().lastPaidMintBlock == 0);
        vm.prank(A); gallery.mintPaid{value: 1000}("Alpha", "INTJ", a, sig);
        uint256 treasuryBefore = TREASURY.balance;
        MintInterface.Authorization memory b = auth("Beta", 1, type(uint256).max, 2000, B);
        bytes memory bsig = sign(b);
        vm.expectRevert(MintInterface.PaidMintAlreadyInBlock.selector); vm.prank(B);
        gallery.mintPaid{value: 2000}("Beta", "INTJ", b, bsig);
        require(gallery.getPulseState().epochIndex == 1 && TREASURY.balance == treasuryBefore);
        require(!gallery.usedNonces(b.nonce) && !gallery.mintedHandle(b.handleKey));
        vm.roll(101); vm.prank(B); gallery.mintPaid{value: 2000}("Beta", "INTJ", b, bsig);
        require(gallery.getPulseState().epochIndex == 2 && gallery.saleStatus().lastPaidMintBlock == 101);
    }

    function testPaidSignedCeilingAndSlotCannotBeAltered() public {
        vm.warp(START + 3600);
        MintInterface.Authorization memory original = auth("Alpha", 1, type(uint256).max, 1100, A);
        bytes memory sig = sign(original);
        MintInterface.Authorization memory changed = auth("Alpha", 1, type(uint256).max, 1100, A);
        changed.maxPrice = 1200;
        vm.expectRevert(Gallery.InvalidAttestation.selector); vm.prank(A);
        gallery.mintPaid{value: 1200}("Alpha", "INTJ", changed, sig);
        changed = auth("Alpha", 1, type(uint256).max, 1100, A);
        changed.slotId = 0;
        vm.expectRevert(MintInterface.InvalidSlot.selector); vm.prank(A);
        gallery.mintPaid{value: 1100}("Alpha", "INTJ", changed, sig);
        require(!gallery.usedNonces(original.nonce) && gallery.getPulseState().epochIndex == 0);
        require(gallery.saleStatus().lastPaidMintBlock == 0 && TREASURY.balance == 0);
        vm.prank(A); gallery.mintPaid{value: 1100}("Alpha", "INTJ", original, sig);
        require(TREASURY.balance == 1000 && A.balance == 10 ether - 1000);
    }

    function testRejectingTreasuryRollsBackEventsAndBalances() public {
        TogglePulseTreasury receiver = new TogglePulseTreasury();
        MintInterface.SaleConfig memory c = sale(); c.treasury = payable(address(receiver));
        gallery = deploy(c); activate(gallery); vm.warp(START + 3600);
        MintInterface.Authorization memory a = auth("Alpha", 1, type(uint256).max, 1200, A);
        bytes memory sig = sign(a);
        uint256 beforeWallet = A.balance;
        vm.recordLogs(); vm.expectRevert(MintInterface.TreasuryPaymentFailed.selector); vm.prank(A);
        gallery.mintPaid{value: 1200}("Alpha", "INTJ", a, sig);
        // Foundry's recordLogs observes attempted logs inside reverted traces;
        // canonical receipts do not. Assert atomic state here and a single
        // successful start event on the retry instead.
        vm.getRecordedLogs();
        require(A.balance == beforeWallet && address(receiver).balance == 0 && address(gallery).balance == 0);
        require(gallery.getPulseState().epochIndex == 0 && gallery.saleStatus().lastPaidMintBlock == 0);
        unused(a);
        receiver.allow(); vm.recordLogs(); vm.prank(A); gallery.mintPaid{value: 1200}("Alpha", "INTJ", a, sig);
        PulseMintVm.Log[] memory logs = vm.getRecordedLogs(); uint256 starts;
        for (uint256 i; i < logs.length; ++i) if (logs[i].emitter == address(gallery)
            && logs[i].topics[0] == keccak256("PaidPhaseStarted(uint64,uint8,uint256)")) ++starts;
        require(starts == 1, "retry did not start paid once");
        require(A.balance == beforeWallet - 1000 && address(receiver).balance == 1000);
    }

    function testIndependentPulseModelAcrossEpochsAndLongIdle() public {
        vm.warp(START + 3600);
        uint64[5] memory times = [uint64(START + 3600), uint64(START + 3601), uint64(START + 3700),
            uint64(START + 100000), uint64(START + 100001)];
        uint256 floor = 900;
        uint64 anchor = START + 3594;
        uint64 curveStart = START + 3600;
        uint256 paid;
        for (uint256 i; i < times.length; ++i) {
            vm.warp(times[i]); vm.roll(100 + i);
            uint256 expected = floor + 600 / (uint256(times[i]) - anchor);
            require(gallery.getCurrentPrice() == expected, "independent quote mismatch");
            uint256 beforeWallet = A.balance; uint256 beforeTreasury = TREASURY.balance;
            mintPaid(i == 0 ? "One" : i == 1 ? "Two" : i == 2 ? "Three" : i == 3 ? "Four" : "Five", expected + 10);
            require(A.balance == beforeWallet - expected && TREASURY.balance == beforeTreasury + expected, "settlement mismatch");
            paid += expected;
            uint256 elapsed = times[i] - curveStart;
            uint256 premium = elapsed == 0 ? 1 : elapsed;
            anchor = times[i] - uint64(600 / premium);
            curveStart = times[i]; floor = expected;
            IPulseCore.State memory state = gallery.getPulseState();
            require(state.epochIndex == i + 1 && state.floorPrice == floor && state.anchorTime == anchor
                && state.curveStartTime == curveStart && state.openTime == START + 3600, "independent transition mismatch");
        }
        require(TREASURY.balance == paid);
    }

    function testFuzzIndependentInitialQuote(uint64 raw) public {
        vm.warp(START + 3600 + uint64(raw % 100000));
        uint256 elapsed = block.timestamp - (START + 3594);
        uint256 expected = 900 + 600 / elapsed;
        require(gallery.getCurrentPrice() == expected, "initial quote drift");
    }

    function testLongIdleNearUint64LimitAndArithmeticRejection() public {
        MintInterface.SaleConfig memory c = sale();
        c.pulse = IPulseCore.Config(1, 1, 0, 1);
        gallery = deploy(c); activate(gallery);
        MintInterface.Authorization memory a = auth("Alpha", 1, type(uint256).max, 0, A);
        MintInterface.Authorization memory expired = auth("Beta", 1, type(uint256).max, 0, B);
        vm.warp(type(uint64).max - 1);
        require(gallery.getCurrentPrice() == 0, "late decay should round to zero");
        // A valid pre-issued authorization can settle at the representable
        // boundary; exactly its deadline it must fail without another epoch.
        a.issuedAt = type(uint64).max - 2; a.deadline = type(uint64).max;
        bytes memory sig = sign(a);
        vm.prank(A); gallery.mintPaid("Alpha", "INTJ", a, sig);
        require(gallery.getPulseState().epochIndex == 1 && gallery.getPulseState().anchorTime == type(uint64).max - 1);
        expired.issuedAt = type(uint64).max - 2; expired.deadline = type(uint64).max;
        bytes memory expiredSig = sign(expired);
        vm.warp(type(uint64).max); vm.roll(101);
        vm.expectRevert(Gallery.AuthorizationExpired.selector); vm.prank(B);
        gallery.mintPaid("Beta", "INTJ", expired, expiredSig);
        require(gallery.getPulseState().epochIndex == 1);
        c = sale(); c.pulse = IPulseCore.Config(1, type(uint256).max, type(uint256).max - 1, 2);
        vm.warp(START); vm.expectRevert(IPulseCore.TargetPriceOverflow.selector); deploy(c);
    }

    function testFuzzFreeSlotConservationAndHandleUniqueness(uint256 seed) public {
        uint256 success;
        bool[3] memory claimed;
        for (uint256 i; i < 12; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 slot = seed % 3;
            string memory handle = i % 3 == 0 ? "Alpha" : i % 3 == 1 ? "Beta" : "Gamma";
            address wallet = slot == 1 ? B : A;
            MintInterface.Authorization memory a = auth(handle, 0, slot, 0, wallet);
            bytes memory sig = sign(a);
            bool nonceBefore = gallery.usedNonces(a.nonce);
            (bool ok,) = address(gallery).call(abi.encodeCall(gallery.mintFree, (handle, "INTJ", a, sig, proof(slot))));
            // Low-level caller is this contract, so recipient check must always fail.
            require(!ok && gallery.freeMinted() == success && gallery.usedNonces(a.nonce) == nonceBefore, "unauthorized caller changed state");
            if (!claimed[slot] && !gallery.mintedHandle(a.handleKey)) {
                vm.prank(wallet); gallery.mintFree(handle, "INTJ", a, sig, proof(slot));
                claimed[slot] = true; ++success;
            } else {
                vm.expectRevert(); vm.prank(wallet); gallery.mintFree(handle, "INTJ", a, sig, proof(slot));
            }
            require(gallery.freeMinted() == success && success <= 3, "counter escaped slots");
            for (uint256 s; s < 3; ++s) require(gallery.isFreeSlotClaimed(s) == claimed[s], "bitmap drift");
            if (success == 3) break;
        }
        require(gallery.balanceOf(A) + gallery.balanceOf(B) == success, "handle duplicated");
    }
}

/// @notice A deterministic, padded Merkle tree for gas measurement only. The
///         production allowlist generator uses its separately verified root.
abstract contract PulseLargeTree is PulseMintFixture {
    function _largeTree(uint256 count, address wallet, uint256 wanted)
        internal pure returns (bytes32 root, bytes32[] memory p)
    {
        uint256 capacity = 1;
        while (capacity < count) capacity <<= 1;
        bytes32[] memory nodes = new bytes32[](capacity * 2);
        for (uint256 i; i < capacity; ++i) nodes[capacity + i] = i < count
            ? keccak256(bytes.concat(keccak256(abi.encode(i, wallet))))
            : keccak256(abi.encode("unused padding", i));
        for (uint256 i = capacity - 1; i > 0; --i) {
            bytes32 left = nodes[i * 2]; bytes32 right = nodes[i * 2 + 1];
            nodes[i] = left < right ? keccak256(abi.encodePacked(left, right)) : keccak256(abi.encodePacked(right, left));
        }
        root = nodes[1];
        uint256 levels;
        for (uint256 n = capacity; n > 1; n >>= 1) ++levels;
        p = new bytes32[](levels);
        uint256 index = capacity + wanted;
        for (uint256 j; j < levels; ++j) { p[j] = nodes[index ^ 1]; index >>= 1; }
    }
}

contract PulseMintC4GasTest is PulseLargeTree {
    event log_named_uint(string key, uint256 val);

    function _deployLarge(uint256 count) private {
        (bytes32 root,) = _largeTree(count, A, 0);
        MintInterface.SaleConfig memory c = sale(); c.freeMintRoot = root; c.freeSlotCount = count;
        uint256 beforeGas = gasleft(); gallery = deploy(c);
        emit log_named_uint(count == 1024 ? "deploy_1024" : "deploy_1025", beforeGas - gasleft());
        activate(gallery);
    }
    function _meterFree(uint256 slot, string memory handle) private {
        (, bytes32[] memory p) = _largeTree(gallery.freeSlotCount(), A, slot);
        MintInterface.Authorization memory a = auth(handle, 0, slot, 0, A);
        bytes memory sig = sign(a);
        vm.prank(A); uint256 beforeGas = gasleft(); gallery.mintFree(handle, "INTJ", a, sig, p);
        emit log_named_uint(slot == 0 ? "free_first_word" : slot == 1 ?
            (bytes(handle).length == 15 ? "free_reused_word_long" : "free_reused_word_short") :
            slot == 256 ? "free_new_word_short" : "free_reused_second_word", beforeGas - gasleft());
    }
    function testGasLargeAllowlistBitmapAndRepeatedWallet() public {
        _deployLarge(1025);
        _meterFree(0, "a");
        _meterFree(1, "abcdefghijklmno");
        _meterFree(256, "c");
        _meterFree(257, "d");
        require(gallery.freeMinted() == 4 && gallery.balanceOf(A) == 4);
        require(gallery.isFreeSlotClaimed(0) && gallery.isFreeSlotClaimed(257));
    }
    function testGasSetup1024AndBothPhaseTransitions() public {
        _deployLarge(1024);
        require(gallery.freeSlotCount() == 1024);
        _meterFree(0, "z");
        MintInterface.SaleConfig memory c = sale(); c.freeMintRoot = gallery.freeSlotLeaf(0, A); c.freeSlotCount = 1;
        gallery = deploy(c); activate(gallery);
        MintInterface.Authorization memory a = auth("a", 0, 0, 0, A); bytes memory sig = sign(a);
        vm.prank(A); uint256 beforeGas = gasleft(); gallery.mintFree("a", "INTJ", a, sig, new bytes32[](0));
        emit log_named_uint("free_final_slot_exhaustion", beforeGas - gasleft());
        a = auth("b", 1, type(uint256).max, 1200, A); sig = sign(a);
        vm.prank(A); beforeGas = gasleft(); gallery.mintPaid{value: 1200}("b", "INTJ", a, sig);
        emit log_named_uint("paid_first_after_exhaustion", beforeGas - gasleft());
        vm.roll(101); a = auth("abcdefghijklmno", 1, type(uint256).max, 1200, A); sig = sign(a);
        vm.prank(A); beforeGas = gasleft(); gallery.mintPaid{value: 1200}("abcdefghijklmno", "INTJ", a, sig);
        emit log_named_uint("paid_next_long_handle", beforeGas - gasleft());
        c = sale(); gallery = deploy(c); activate(gallery); vm.warp(START + 3600);
        a = auth("x", 1, type(uint256).max, 1000, A); sig = sign(a);
        vm.prank(A); beforeGas = gasleft(); gallery.mintPaid{value: 1000}("x", "INTJ", a, sig);
        emit log_named_uint("paid_first_after_deadline", beforeGas - gasleft());
    }
    function testGasFreeReusedWordShortHandle() public {
        _deployLarge(1024);
        _meterFree(0, "seed"); _meterFree(1, "a");
    }
    function testGasFreeReusedWordLongHandle() public {
        _deployLarge(1024);
        _meterFree(0, "seed"); _meterFree(1, "abcdefghijklmno");
    }
    function testGasPaidFirstShortHandle() public {
        vm.warp(START + 3600);
        MintInterface.Authorization memory a = auth("a", 1, type(uint256).max, 1000, A);
        bytes memory sig = sign(a);
        vm.prank(A); uint256 beforeGas = gasleft(); gallery.mintPaid{value: 1000}("a", "INTJ", a, sig);
        emit log_named_uint("paid_first_short", beforeGas - gasleft());
    }
    function testGasPaidFirstLongHandle() public {
        vm.warp(START + 3600);
        MintInterface.Authorization memory a = auth("abcdefghijklmno", 1, type(uint256).max, 1000, A);
        bytes memory sig = sign(a);
        vm.prank(A); uint256 beforeGas = gasleft(); gallery.mintPaid{value: 1000}("abcdefghijklmno", "INTJ", a, sig);
        emit log_named_uint("paid_first_long", beforeGas - gasleft());
    }
}
