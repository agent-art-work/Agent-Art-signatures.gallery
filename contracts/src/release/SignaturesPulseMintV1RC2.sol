// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {SignatureRendererV1RC1} from "./SignatureRendererV1RC1.sol";
import {ISignaturesPulseMintV1RC2} from "./ISignaturesPulseMintV1RC2.sol";
import {IPulseCore} from "../../vendor/pulse-core-v1.0.0/IPulseCore.sol";

/// @notice Free wallet slots followed by native-ETH Pulse sales. Anvil/Sepolia candidate.
/// @dev Starts paused. The exact stateless core and renderer are fixed at construction.
///      Grok authority is attested by the backend signer; only immutable artwork inputs are stored; the free policy is admin-controlled until paid activation.
contract SignaturesPulseMintV1RC2 is
    ERC721, EIP712, Pausable, AccessControlDefaultAdminRules, ReentrancyGuard, ISignaturesPulseMintV1RC2
{
    struct Inputs { bytes15 renderHandle; uint8 handleLength; bytes4 mbti; }
    struct Provenance { bytes32 assessmentDigest; bytes32 authorizationDigest; address mintRecipient; }

    mapping(uint256 => Inputs) private _inputs;
    mapping(uint256 => Provenance) public provenance;
    mapping(bytes32 => bool) public mintedHandle;
    mapping(bytes32 => bool) public usedNonces;
    mapping(bytes32 => bool) public revokedNonces;
    mapping(uint256 => uint256) private _claimedSlots;
    SignatureRendererV1RC1 public immutable renderer;
    bytes32 public immutable rendererIdentity;
    address public trustedAuthorizer;
    address public immutable override pulseCore;
    uint256 public immutable override boundChainId;
    address public immutable override treasury;
    bytes32 public override freeMintRoot;
    uint256 public override freeSlotCount;
    uint256 public override freeMintQuota;
    uint64 public override freeConfigRevision;
    uint64 public immutable override freeDeadline;
    uint64 public immutable override deployedAt;
    bytes32 public immutable override saleConfigHash;
    uint256 public override freeMinted;

    uint256 private immutable _k;
    uint256 private immutable _genesisPrice;
    uint256 private immutable _genesisFloor;
    uint256 private immutable _pts;
    IPulseCore.State private _pulseState;
    uint64 private _paidStartTime;
    uint64 private _lastPaidMintBlock;
    EndReason private _endReason;

    bytes32 public constant override coreRuntimeCodeHash =
        0xfb48657163202d3cdb28060f1eb511fd1f5b93a6e0eb8657242b5632e2200a90;
    address public constant SEPOLIA_CORE = 0xfb1Cc26356b1b0361c414Ec1B5fB52c5FEDc3EAC;
    uint256 public constant override PAID_SLOT = type(uint256).max;
    bytes32 public constant AUTHORIZER_MANAGER_ROLE = keccak256("AUTHORIZER_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant NONCE_REVOKER_ROLE = keccak256("NONCE_REVOKER_ROLE");
    string public constant VERSION = "sg-generative-pulse-mint-1.0.0-rc.2";
    string public constant INPUT_PROFILE = "sg-generative-pulse-inputs-v1-rc1";
    bytes32 public constant AUTHORIZATION_TYPEHASH = keccak256(
        "PulseMintAuthorization(bytes32 handleKey,bytes32 assessmentDigest,bytes32 inputDigest,address recipient,bytes32 nonce,uint64 issuedAt,uint64 deadline,uint8 mintMode,uint256 slotId,uint256 maxPrice,uint64 freeConfigRevision)"
    );
    uint64 public constant MAX_AUTHORIZATION_WINDOW = 900;

    error InvalidRenderer();
    error InvalidInput();
    error ZeroAddress();
    error ZeroCommitment();
    error HandleKeyMismatch();
    error InputDigestMismatch();
    error WrongRecipient();
    error ContractWalletUnsupported();
    error InvalidAuthorizationWindow();
    error AuthorizationNotActive();
    error AuthorizationExpired();
    error NonceUnavailable();
    error HandleAlreadyMinted();
    error InvalidAttestation();
    event TrustedAuthorizerChanged(address indexed previousAuthorizer, address indexed newAuthorizer);
    event NonceRevoked(bytes32 indexed nonce);
    event GenerativeSignatureMinted(bytes32 indexed handleKey, bytes32 indexed nonce, address indexed recipient,
        uint256 tokenId, string renderHandle, string mbti, bytes32 assessmentDigest, bytes32 inputDigest, bytes32 authorizationDigest);

    constructor(address renderer_, CoreBinding memory core_, SaleConfig memory sale_, Authorities memory authorities_)
        ERC721("Signatures Gallery", "SG") EIP712("SignaturesPulseMintRC2", "1")
        AccessControlDefaultAdminRules(authorities_.adminDelay, authorities_.admin)
    {
        if (core_.chainId != block.chainid || (block.chainid != 31337 && block.chainid != 11155111)) revert WrongChain();
        if (core_.core.codehash != coreRuntimeCodeHash ||
            (block.chainid == 11155111 && core_.core != SEPOLIA_CORE)) revert InvalidCore();
        if (renderer_.codehash != keccak256(type(SignatureRendererV1RC1).runtimeCode)) revert InvalidRenderer();
        if (authorities_.manager == address(0) || authorities_.pauser == address(0) ||
            authorities_.revoker == address(0) || authorities_.authorizer == address(0) || sale_.treasury == address(0)) revert ZeroAddress();
        uint64 now_ = _timestamp();
        if (sale_.treasury == address(this) || sale_.freeMintRoot == bytes32(0) ||
            sale_.freeSlotCount == 0 || sale_.freeMintQuota == 0 || sale_.freeMintQuota > sale_.freeSlotCount || sale_.freeDeadline <= now_) revert InvalidSaleConfiguration();

        // Exact released bytecode is an external dependency; never recompile it
        // under the consumer settings and then trust the resulting hash.
        IPulseCore.State memory check = IPulseCore(core_.core).initialize(sale_.pulse, now_);
        IPulseCore(core_.core).advance(sale_.pulse, check, now_);
        check = IPulseCore(core_.core).initialize(sale_.pulse, sale_.freeDeadline);
        IPulseCore(core_.core).advance(sale_.pulse, check, sale_.freeDeadline);

        renderer = SignatureRendererV1RC1(renderer_);
        rendererIdentity = keccak256(abi.encode(INPUT_PROFILE, renderer_, renderer_.codehash));
        pulseCore = core_.core;
        boundChainId = core_.chainId;
        treasury = sale_.treasury;
        freeMintRoot = sale_.freeMintRoot;
        freeSlotCount = sale_.freeSlotCount;
        freeMintQuota = sale_.freeMintQuota;
        freeConfigRevision = 1;
        freeDeadline = sale_.freeDeadline;
        deployedAt = now_;
        _k = sale_.pulse.k;
        _genesisPrice = sale_.pulse.genesisPrice;
        _genesisFloor = sale_.pulse.genesisFloor;
        _pts = sale_.pulse.pts;
        saleConfigHash = _saleHash(sale_);
        trustedAuthorizer = authorities_.authorizer;
        _grantRole(AUTHORIZER_MANAGER_ROLE, authorities_.manager);
        _grantRole(PAUSER_ROLE, authorities_.pauser);
        _grantRole(NONCE_REVOKER_ROLE, authorities_.revoker);
        emit CoreBound(pulseCore, boundChainId, coreRuntimeCodeHash);
        emit SaleConfigured(saleConfigHash, freeMintRoot, freeSlotCount, freeDeadline, treasury, now_);
        emit TrustedAuthorizerChanged(address(0), trustedAuthorizer);
        _emitFreeConfiguration();
        _pause();
    }

    function _saleHash(SaleConfig memory sale_) private view returns (bytes32) {
        // The final Config tuple is entirely static: its ABI bytes equal the
        // four individual uint256 fields specified in C1.
        return keccak256(abi.encode("signatures.gallery/pulse-sale/v1-rc2", boundChainId, address(this),
            pulseCore, coreRuntimeCodeHash, rendererIdentity, sale_.treasury, sale_.freeMintRoot,
            sale_.freeSlotCount, sale_.freeMintQuota, sale_.freeDeadline, sale_.pulse));
    }

    function getPulseConfig() public view override returns (IPulseCore.Config memory) {
        return IPulseCore.Config(_k, _genesisPrice, _genesisFloor, _pts);
    }

    function _timestamp() private view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert TimeOutOfRange();
        return uint64(block.timestamp);
    }

    function _effectiveState(uint64 now_) private view returns (IPulseCore.State memory) {
        if (_paidStartTime != 0) return _pulseState;
        if (now_ < freeDeadline) revert PaidMintNotOpen();
        return IPulseCore(pulseCore).initialize(getPulseConfig(), freeDeadline);
    }

    function getPulseState() public view override returns (IPulseCore.State memory) {
        return _effectiveState(_timestamp());
    }

    function getCurrentPrice() external view override returns (uint256) {
        uint64 now_ = _timestamp();
        return IPulseCore(pulseCore).quote(getPulseConfig(), _effectiveState(now_), now_);
    }

    function saleStatus() external view override returns (SaleStatus memory) {
        uint64 now_ = _timestamp();
        bool paid = _paidStartTime != 0 || now_ >= freeDeadline;
        return SaleStatus(paid ? Phase.Paid : Phase.Free, paused(), freeMinted, freeSlotCount, freeDeadline,
            _paidStartTime != 0 ? _paidStartTime : (paid ? freeDeadline : 0),
            _paidStartTime != 0 ? _endReason : (paid ? EndReason.Deadline : EndReason.None), _lastPaidMintBlock,
            freeMintQuota, freeConfigRevision);
    }

    function freeSlotLeaf(uint256 slotId, address wallet) public pure override returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(slotId, wallet))));
    }

    function isFreeSlotClaimed(uint256 slotId) public view override returns (bool) {
        if (slotId >= freeSlotCount) revert InvalidSlot();
        return _claimedSlots[slotId >> 8] & (uint256(1) << (slotId & 255)) != 0;
    }

    function mintFree(string calldata handle, string calldata mbti, Authorization calldata a,
        bytes calldata signature, bytes32[] calldata proof)
        external override nonReentrant whenNotPaused returns (uint256 tokenId)
    {
        if (a.mintMode != 0) revert InvalidMintMode();
        uint64 now_ = _timestamp();
        if (_paidStartTime != 0 || now_ >= freeDeadline) revert FreeMintClosed();
        if (a.maxPrice != 0) revert InvalidPriceLimit();
        if (a.deadline > freeDeadline) revert InvalidAuthorizationWindow();
        bytes32 digest = _validateAuthorization(handle, mbti, a, signature, now_);
        if (isFreeSlotClaimed(a.slotId)) revert SlotAlreadyClaimed();
        if (proof.length > 256 || !MerkleProof.verifyCalldata(proof, freeMintRoot, freeSlotLeaf(a.slotId, a.recipient))) revert InvalidSlotProof();

        _recordInputs(handle, mbti, a, digest);
        _claimedSlots[a.slotId >> 8] |= uint256(1) << (a.slotId & 255);
        ++freeMinted;
        if (freeMinted == freeMintQuota) _closeFreeMint(now_);
        tokenId = uint256(a.handleKey);
        _mint(a.recipient, tokenId);
        _emitMint(handle, mbti, a, digest);
        emit MintEconomics(tokenId, a.nonce, a.slotId, 0, 0, 0, 0);
    }

    function mintPaid(string calldata handle, string calldata mbti, Authorization calldata a, bytes calldata signature)
        external payable override nonReentrant whenNotPaused returns (uint256 tokenId)
    {
        if (a.mintMode != 1) revert InvalidMintMode();
        uint64 now_ = _timestamp();
        IPulseCore.State memory state = _effectiveState(now_);
        if (a.slotId != PAID_SLOT) revert InvalidSlot();
        bytes32 digest = _validateAuthorization(handle, mbti, a, signature, now_);
        if (block.number > type(uint64).max) revert BlockOutOfRange();
        uint64 block_ = uint64(block.number);
        if (state.epochIndex > 0 && _lastPaidMintBlock == block_) revert PaidMintAlreadyInBlock();
        (uint256 ask, IPulseCore.State memory next) = IPulseCore(pulseCore).advance(getPulseConfig(), state, now_);
        if (ask > a.maxPrice) revert PriceAboveLimit(ask, a.maxPrice);
        if (msg.value != a.maxPrice) revert ValueMismatch(a.maxPrice, msg.value);

        // All reservations precede payment callbacks. Any failed call unwinds
        // these writes, the NFT and every event in this transaction.
        if (_paidStartTime == 0) {
            _paidStartTime = freeDeadline;
            _endReason = EndReason.Deadline;
            emit PaidPhaseStarted(freeDeadline, EndReason.Deadline, freeMinted);
        }
        _pulseState = next;
        _lastPaidMintBlock = block_;
        _recordInputs(handle, mbti, a, digest);
        if (ask != 0) {
            (bool sent,) = payable(treasury).call{value: ask}("");
            if (!sent) revert TreasuryPaymentFailed();
        }
        uint256 refund = msg.value - ask;
        if (refund != 0) {
            (bool sent,) = payable(msg.sender).call{value: refund}("");
            if (!sent) revert RefundFailed();
        }
        tokenId = uint256(a.handleKey);
        _mint(a.recipient, tokenId);
        _emitMint(handle, mbti, a, digest);
        _emitPaidEconomics(a, ask, now_, next);
    }

    function _closeFreeMint(uint64 now_) private {
        _pulseState = IPulseCore(pulseCore).initialize(getPulseConfig(), now_);
        _paidStartTime = now_;
        _endReason = EndReason.Exhausted;
        emit PaidPhaseStarted(now_, EndReason.Exhausted, freeMinted);
    }

    function _emitFreeConfiguration() private {
        emit FreeMintConfigured(keccak256(abi.encode(freeMintRoot, freeSlotCount, freeMintQuota, freeConfigRevision)),
            freeMintRoot, freeSlotCount, freeMintQuota, freeConfigRevision);
    }

    /// @notice Replace the current allowlist and quota without reviving any claimed slot.
    /// @dev Root membership is administered off-chain; slot IDs remain stable across revisions.
    ///      Configuration is immutable once the effective paid phase begins.
    function configureFreeMint(bytes32 root, uint256 slotCount, uint256 quota)
        external override nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) whenPaused
    {
        uint64 now_ = _timestamp();
        if (_paidStartTime != 0 || now_ >= freeDeadline) revert FreeMintClosed();
        if (root == bytes32(0) || slotCount == 0 || slotCount < freeSlotCount ||
            quota < freeMinted || quota > slotCount) revert InvalidSaleConfiguration();
        freeMintRoot = root;
        freeSlotCount = slotCount;
        freeMintQuota = quota;
        ++freeConfigRevision;
        _emitFreeConfiguration();
        if (quota == freeMinted) _closeFreeMint(now_);
    }

    function _emitPaidEconomics(Authorization calldata a, uint256 ask, uint64 now_, IPulseCore.State memory next) private {
        emit MintEconomics(uint256(a.handleKey), a.nonce, PAID_SLOT, 1, ask, a.maxPrice, next.epochIndex);
        emit Sale(a.recipient, next.epochIndex, ask, now_, next.anchorTime, next.floorPrice);
    }

    function _canonical(string memory handle) private pure returns (string memory) {
        bytes memory source = bytes(handle);
        if (source.length == 0 || source.length > 15) revert InvalidInput();
        bytes memory out = new bytes(source.length);
        for (uint256 i; i < source.length; ++i) {
            uint8 c = uint8(source[i]);
            if (c >= 65 && c <= 90) out[i] = bytes1(c + 32);
            else {
                if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 95)) revert InvalidInput();
                out[i] = source[i];
            }
        }
        return string(out);
    }
    function _mbti(string memory value) private pure returns (bytes4) {
        bytes memory m = bytes(value);
        if (m.length != 4 || (m[0] != "I" && m[0] != "E") || (m[1] != "S" && m[1] != "N")
            || (m[2] != "T" && m[2] != "F") || (m[3] != "J" && m[3] != "P")) revert InvalidInput();
        return bytes4(m);
    }
    function handleKey(string memory handle) public pure returns (bytes32) {
        return keccak256(abi.encode("signatures.gallery/open-handle/v1", _canonical(handle)));
    }
    function inputDigest(string memory handle, string memory mbti) public view returns (bytes32) {
        _canonical(handle); _mbti(mbti);
        return keccak256(abi.encode(INPUT_PROFILE, rendererIdentity, handle, mbti));
    }
    function authorizationDigest(Authorization calldata a) public view override returns (bytes32) {
        // Authorization is all-static: abi.encode(TYPEHASH, a) equals the
        // individual ordered fields and avoids a second field-order definition.
        return _hashTypedDataV4(keccak256(abi.encode(AUTHORIZATION_TYPEHASH, a)));
    }
    function _validateAuthorization(string calldata handle, string calldata mbti, Authorization calldata a,
        bytes calldata signature, uint64 now_) private view returns (bytes32 digest)
    {
        if (block.chainid != boundChainId) revert WrongChain();
        if (a.handleKey == bytes32(0) || a.assessmentDigest == bytes32(0) || a.inputDigest == bytes32(0) || a.nonce == bytes32(0)) revert ZeroCommitment();
        if (handleKey(handle) != a.handleKey) revert HandleKeyMismatch();
        if (inputDigest(handle, mbti) != a.inputDigest) revert InputDigestMismatch();
        if (a.recipient == address(0) || a.recipient != msg.sender) revert WrongRecipient();
        if (msg.sender.code.length != 0) revert ContractWalletUnsupported();
        if (a.freeConfigRevision != (a.mintMode == 0 ? freeConfigRevision : 0)) revert InvalidFreeConfigRevision();
        if (a.issuedAt == 0 || a.issuedAt >= a.deadline || a.deadline - a.issuedAt > MAX_AUTHORIZATION_WINDOW) revert InvalidAuthorizationWindow();
        if (now_ < a.issuedAt) revert AuthorizationNotActive();
        if (now_ >= a.deadline) revert AuthorizationExpired();
        if (usedNonces[a.nonce] || revokedNonces[a.nonce]) revert NonceUnavailable();
        if (mintedHandle[a.handleKey]) revert HandleAlreadyMinted();
        digest = authorizationDigest(a);
        (address recovered, ECDSA.RecoverError error_,) = ECDSA.tryRecoverCalldata(digest, signature);
        if (error_ != ECDSA.RecoverError.NoError || recovered != trustedAuthorizer) revert InvalidAttestation();
    }
    function _recordInputs(string calldata handle, string calldata mbti, Authorization calldata a, bytes32 digest) private {
        usedNonces[a.nonce] = true;
        mintedHandle[a.handleKey] = true;
        uint256 tokenId = uint256(a.handleKey);
        _inputs[tokenId] = Inputs(bytes15(bytes(handle)), uint8(bytes(handle).length), bytes4(bytes(mbti)));
        provenance[tokenId] = Provenance(a.assessmentDigest, digest, a.recipient);
    }
    function _emitMint(string calldata handle, string calldata mbti, Authorization calldata a, bytes32 digest) private {
        emit GenerativeSignatureMinted(a.handleKey, a.nonce, a.recipient, uint256(a.handleKey), handle, mbti,
            a.assessmentDigest, a.inputDigest, digest);
    }

    function inputs(uint256 tokenId) public view returns (string memory handle, string memory mbti) {
        _requireOwned(tokenId);
        Inputs memory a = _inputs[tokenId];
        bytes memory h = new bytes(a.handleLength);
        for (uint256 i; i < h.length; ++i) h[i] = a.renderHandle[i];
        return (string(h), string(abi.encodePacked(a.mbti)));
    }
    function svg(uint256 tokenId) public view returns (string memory) {
        (string memory handle, string memory mbti) = inputs(tokenId);
        return renderer.render(handle, mbti);
    }
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        (string memory handle, string memory mbti) = inputs(tokenId);
        string memory image = renderer.render(handle, mbti);
        bytes memory data = abi.encodePacked('{"name":"@', handle, unicode' × ', mbti,
            '","description":"Release-candidate generative signature for an X handle. MBTI is an artistic input, not a psychological diagnosis.","image":"data:image/svg+xml;base64,', Base64.encode(bytes(image)),
            '","attributes":[{"trait_type":"Handle","value":"', handle, '"},{"trait_type":"MBTI","value":"', mbti, '"}]');
        data = abi.encodePacked(data, ',"properties":{"renderer":"', renderer.VERSION(), '","input_profile":"', INPUT_PROFILE, '"');
        data = abi.encodePacked(data, ',"renderer_identity":"', Strings.toHexString(uint256(rendererIdentity), 32),
            '","assessment_digest":"', Strings.toHexString(uint256(provenance[tokenId].assessmentDigest), 32), '"}}');
        return string.concat("data:application/json;base64,", Base64.encode(data));
    }
    function contractURI() external pure returns (string memory) {
        return string.concat("data:application/json;base64,", Base64.encode(bytes(
            '{"name":"Signatures Gallery","description":"On-chain generative signature artwork. One token per canonical X handle. Release candidate."}'
        )));
    }

    // The same guard covers every authority mutation, including inherited
    // delayed-admin operations. A treasury with roles cannot mutate mid-mint.
    function setTrustedAuthorizer(address next) external nonReentrant onlyRole(AUTHORIZER_MANAGER_ROLE) {
        if (next == address(0)) revert ZeroAddress();
        emit TrustedAuthorizerChanged(trustedAuthorizer, next); trustedAuthorizer = next;
    }
    function revokeNonce(bytes32 nonce) external nonReentrant onlyRole(NONCE_REVOKER_ROLE) {
        if (nonce == bytes32(0)) revert ZeroCommitment();
        if (usedNonces[nonce] || revokedNonces[nonce]) revert NonceUnavailable();
        revokedNonces[nonce] = true; emit NonceRevoked(nonce);
    }
    function pauseMinting() external nonReentrant onlyRole(PAUSER_ROLE) { _pause(); }
    function unpauseMinting() external nonReentrant onlyRole(PAUSER_ROLE) { _unpause(); }
    function grantRole(bytes32 role, address account) public override nonReentrant { super.grantRole(role, account); }
    function revokeRole(bytes32 role, address account) public override nonReentrant { super.revokeRole(role, account); }
    function renounceRole(bytes32 role, address account) public override nonReentrant { super.renounceRole(role, account); }
    function beginDefaultAdminTransfer(address next) public override nonReentrant { super.beginDefaultAdminTransfer(next); }
    function cancelDefaultAdminTransfer() public override nonReentrant { super.cancelDefaultAdminTransfer(); }
    function acceptDefaultAdminTransfer() public override nonReentrant { super.acceptDefaultAdminTransfer(); }
    function changeDefaultAdminDelay(uint48 next) public override nonReentrant { super.changeDefaultAdminDelay(next); }
    function rollbackDefaultAdminDelay() public override nonReentrant { super.rollbackDefaultAdminDelay(); }
    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControlDefaultAdminRules) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}

