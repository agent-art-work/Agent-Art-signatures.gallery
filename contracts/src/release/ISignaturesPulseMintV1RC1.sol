// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IPulseCore} from "../../vendor/pulse-core-v1.0.0/IPulseCore.sol";

interface ISignaturesPulseMintV1RC1 {
    enum Phase { Free, Paid }
    enum EndReason { None, Exhausted, Deadline }
    struct CoreBinding { uint256 chainId; address core; }
    struct SaleConfig {
        bytes32 freeMintRoot;
        uint256 freeSlotCount;
        uint64 freeDeadline;
        address payable treasury;
        IPulseCore.Config pulse;
    }
    struct Authorities {
        uint48 adminDelay;
        address admin;
        address manager;
        address pauser;
        address revoker;
        address authorizer;
    }
    struct Authorization {
        bytes32 handleKey;
        bytes32 assessmentDigest;
        bytes32 inputDigest;
        address recipient;
        bytes32 nonce;
        uint64 issuedAt;
        uint64 deadline;
        uint8 mintMode;
        uint256 slotId;
        uint256 maxPrice;
    }
    struct SaleStatus {
        Phase phase;
        bool paused;
        uint256 freeMinted;
        uint256 freeSlotCount;
        uint64 freeDeadline;
        uint64 paidStartTime;
        EndReason endReason;
        uint64 lastPaidMintBlock;
    }

    function mintFree(string calldata handle, string calldata mbti,
        Authorization calldata a, bytes calldata signature, bytes32[] calldata proof)
        external returns (uint256 tokenId);
    function mintPaid(string calldata handle, string calldata mbti,
        Authorization calldata a, bytes calldata signature)
        external payable returns (uint256 tokenId);
    function authorizationDigest(Authorization calldata a) external view returns (bytes32);
    function saleStatus() external view returns (SaleStatus memory);
    function getPulseConfig() external view returns (IPulseCore.Config memory);
    function getPulseState() external view returns (IPulseCore.State memory);
    function getCurrentPrice() external view returns (uint256);
    function freeSlotLeaf(uint256 slotId, address wallet) external pure returns (bytes32);
    function isFreeSlotClaimed(uint256 slotId) external view returns (bool);
    function pulseCore() external view returns (address);
    function coreRuntimeCodeHash() external view returns (bytes32);
    function boundChainId() external view returns (uint256);
    function treasury() external view returns (address);
    function freeMintRoot() external view returns (bytes32);
    function freeSlotCount() external view returns (uint256);
    function freeDeadline() external view returns (uint64);
    function freeMinted() external view returns (uint256);
    function deployedAt() external view returns (uint64);
    function saleConfigHash() external view returns (bytes32);
    function PAID_SLOT() external view returns (uint256);

    event CoreBound(address indexed core, uint256 chainId, bytes32 runtimeCodeHash);
    event SaleConfigured(bytes32 indexed saleConfigHash, bytes32 freeMintRoot,
        uint256 freeSlotCount, uint64 freeDeadline, address treasury, uint64 deployedAt);
    event PaidPhaseStarted(uint64 startTime, EndReason reason, uint256 freeMinted);
    event MintEconomics(uint256 indexed tokenId, bytes32 indexed nonce,
        uint256 indexed slotId, uint8 mintMode, uint256 price,
        uint256 maxPrice, uint64 epochIndex);
    event Sale(address indexed buyer, uint64 indexed epochIndex, uint256 price,
        uint64 timestamp, uint64 nextAnchorA, uint256 nextFloorB);

    error InvalidCore();
    error WrongChain();
    error InvalidSaleConfiguration();
    error TimeOutOfRange();
    error BlockOutOfRange();
    error FreeMintClosed();
    error PaidMintNotOpen();
    error InvalidMintMode();
    error InvalidSlot();
    error SlotAlreadyClaimed();
    error InvalidSlotProof();
    error InvalidPriceLimit();
    error ValueMismatch(uint256 expected, uint256 actual);
    error PriceAboveLimit(uint256 ask, uint256 maxPrice);
    error PaidMintAlreadyInBlock();
    error TreasuryPaymentFailed();
    error RefundFailed();
}
