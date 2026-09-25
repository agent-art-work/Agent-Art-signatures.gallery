// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {SignatureRendererV1RC1} from "./SignatureRendererV1RC1.sol";

/// @notice Unactivated release candidate for Anvil and Ethereum Sepolia only.
/// @dev Starts paused. Deployment, review and activation are separate decisions.
///      No supplied SVG, output hash or URI; the immutable renderer runs on reads.
contract GenerativeSignaturesV1RC1 is ERC721, EIP712, Pausable, AccessControlDefaultAdminRules {
    struct Authorization {
        bytes32 handleKey;
        bytes32 assessmentDigest;
        bytes32 inputDigest;
        address recipient;
        bytes32 nonce;
        uint64 issuedAt;
        uint64 deadline;
    }
    // One storage slot for all artwork inputs. MBTI is literal letters, not a
    // user-editable arbitrary seed. Renderer/code identity is collection-wide.
    struct Inputs { bytes15 renderHandle; uint8 handleLength; bytes4 mbti; }
    struct Provenance { bytes32 assessmentDigest; bytes32 authorizationDigest; address mintRecipient; }
    mapping(uint256 => Inputs) private _inputs;
    mapping(uint256 => Provenance) public provenance;
    mapping(bytes32 => bool) public mintedHandle;
    mapping(bytes32 => bool) public usedNonces;
    mapping(bytes32 => bool) public revokedNonces;
    SignatureRendererV1RC1 public immutable renderer;
    bytes32 public immutable rendererIdentity;
    address public trustedAuthorizer;
    bytes32 public constant AUTHORIZER_MANAGER_ROLE = keccak256("AUTHORIZER_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant NONCE_REVOKER_ROLE = keccak256("NONCE_REVOKER_ROLE");
    string public constant VERSION = "sg-generative-mint-1.0.0-rc.1";
    string public constant INPUT_PROFILE = "sg-generative-inputs-v1-rc1";
    bytes32 public constant AUTHORIZATION_TYPEHASH = keccak256(
        "GenerativeMintAuthorization(bytes32 handleKey,bytes32 assessmentDigest,bytes32 inputDigest,address recipient,bytes32 nonce,uint64 issuedAt,uint64 deadline)"
    );
    uint64 public constant MAX_AUTHORIZATION_WINDOW = 900;

    error UnsupportedReleaseChain();
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

    constructor(address renderer_, uint48 adminDelay, address admin, address manager, address pauser,
        address revoker, address authorizer)
        ERC721("Signatures Gallery", "SG") EIP712("SignaturesGenerativeMintRC1", "1")
        AccessControlDefaultAdminRules(adminDelay, admin)
    {
        if (block.chainid != 31337 && block.chainid != 11155111) revert UnsupportedReleaseChain();
        // Exact compiled candidate, no arbitrary renderer, proxy or hidden
        // mutable implementation. This code has no external dependencies.
        if (renderer_.codehash != keccak256(type(SignatureRendererV1RC1).runtimeCode)) revert InvalidRenderer();
        if (manager == address(0) || pauser == address(0) || revoker == address(0) || authorizer == address(0)) revert ZeroAddress();
        renderer = SignatureRendererV1RC1(renderer_);
        rendererIdentity = keccak256(abi.encode(INPUT_PROFILE, renderer_, renderer_.codehash));
        trustedAuthorizer = authorizer;
        _grantRole(AUTHORIZER_MANAGER_ROLE, manager);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(NONCE_REVOKER_ROLE, revoker);
        emit TrustedAuthorizerChanged(address(0), authorizer);
        _pause(); // No minting before a separate explicit activation.
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
    function authorizationDigest(Authorization calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(AUTHORIZATION_TYPEHASH, a.handleKey, a.assessmentDigest,
            a.inputDigest, a.recipient, a.nonce, a.issuedAt, a.deadline)));
    }
    function mint(string calldata handle, string calldata mbti, Authorization calldata a, bytes calldata signature)
        external whenNotPaused returns (uint256 tokenId)
    {
        if (a.handleKey == bytes32(0) || a.assessmentDigest == bytes32(0) || a.inputDigest == bytes32(0) || a.nonce == bytes32(0)) revert ZeroCommitment();
        if (handleKey(handle) != a.handleKey) revert HandleKeyMismatch();
        if (inputDigest(handle, mbti) != a.inputDigest) revert InputDigestMismatch();
        if (a.recipient == address(0) || a.recipient != msg.sender) revert WrongRecipient();
        if (msg.sender.code.length != 0) revert ContractWalletUnsupported();
        if (a.issuedAt == 0 || a.issuedAt >= a.deadline || a.deadline - a.issuedAt > MAX_AUTHORIZATION_WINDOW) revert InvalidAuthorizationWindow();
        if (block.timestamp < a.issuedAt) revert AuthorizationNotActive();
        if (block.timestamp > a.deadline) revert AuthorizationExpired();
        if (usedNonces[a.nonce] || revokedNonces[a.nonce]) revert NonceUnavailable();
        if (mintedHandle[a.handleKey]) revert HandleAlreadyMinted();
        bytes32 digest = authorizationDigest(a);
        (address recovered, ECDSA.RecoverError error_,) = ECDSA.tryRecoverCalldata(digest, signature);
        if (error_ != ECDSA.RecoverError.NoError || recovered != trustedAuthorizer) revert InvalidAttestation();
        usedNonces[a.nonce] = true;
        mintedHandle[a.handleKey] = true;
        tokenId = uint256(a.handleKey);
        _inputs[tokenId] = Inputs(bytes15(bytes(handle)), uint8(bytes(handle).length), bytes4(bytes(mbti)));
        provenance[tokenId] = Provenance(a.assessmentDigest, digest, a.recipient);
        _mint(a.recipient, tokenId);
        // No renderer call, SVG bytes, tokenURI construction or output-hash
        // verification in this transaction. Authority commits immutable inputs.
        _emitMint(handle, mbti, a, digest);
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
            '","attributes":[{"trait_type":"Handle","value":"', handle, '"},{"trait_type":"MBTI","value":"', mbti,
            '"}]');
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
    function setTrustedAuthorizer(address next) external onlyRole(AUTHORIZER_MANAGER_ROLE) {
        if (next == address(0)) revert ZeroAddress();
        emit TrustedAuthorizerChanged(trustedAuthorizer, next); trustedAuthorizer = next;
    }
    function revokeNonce(bytes32 nonce) external onlyRole(NONCE_REVOKER_ROLE) {
        if (nonce == bytes32(0)) revert ZeroCommitment();
        if (usedNonces[nonce] || revokedNonces[nonce]) revert NonceUnavailable();
        revokedNonces[nonce] = true; emit NonceRevoked(nonce);
    }
    function pauseMinting() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpauseMinting() external onlyRole(PAUSER_ROLE) { _unpause(); }
    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControlDefaultAdminRules) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
