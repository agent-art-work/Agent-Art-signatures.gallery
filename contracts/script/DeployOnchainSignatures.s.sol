// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OnchainSignatures} from "../src/OnchainSignatures.sol";

interface OpenDeploymentVm {
    function envAddress(string calldata name) external returns (address);
    function envString(string calldata name) external returns (string memory);
    function envUint(string calldata name) external returns (uint256);
    function startBroadcast(address signer) external;
    function stopBroadcast() external;
}

/// @notice Local preparation only. No public chain is approved by this script.
/// @dev No private-key environment variable is read. Foundry supplies the signer
///      explicitly; --broadcast is a separate user action, even on isolated Anvil.
contract DeployOnchainSignatures {
    struct Configuration {
        uint256 expectedChainId;
        string domainName;
        string domainVersion;
        string collectionName;
        string collectionSymbol;
        uint48 adminDelay;
        address deployer;
        address delayedAdmin;
        address authorizerManager;
        address pauser;
        address nonceRevoker;
        address authorizer;
        string acknowledgement;
    }

    string public constant DOMAIN_NAME = "SignaturesOnchainMint";
    string public constant DOMAIN_VERSION = "1";
    string public constant ACKNOWLEDGEMENT = "LOCAL_ONLY_NO_PUBLIC_BROADCAST";
    uint256 public constant LOCAL_CHAIN_ID = 31337;
    OpenDeploymentVm private constant vm = OpenDeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error PublicBroadcastNotApproved();
    error WrongDomain();
    error InvalidCollection();
    error InvalidDelay();
    error InvalidRoleIdentity();
    error MissingAcknowledgement();
    error DeploymentMismatch();

    function run() external returns (address deployed, bytes32 initcodeHash, bytes32 runtimeCodeHash) {
        Configuration memory c = loadConfiguration();
        validateConfiguration(c, block.chainid);
        initcodeHash = deploymentInitcodeHash(c);
        vm.startBroadcast(c.deployer);
        OnchainSignatures instance = deployLocal(c);
        vm.stopBroadcast();
        deployed = address(instance);
        runtimeCodeHash = keccak256(deployed.code);
    }

    function loadConfiguration() public returns (Configuration memory c) {
        c.expectedChainId = vm.envUint("OPEN_DEPLOY_CHAIN_ID");
        c.domainName = vm.envString("OPEN_DEPLOY_DOMAIN_NAME");
        c.domainVersion = vm.envString("OPEN_DEPLOY_DOMAIN_VERSION");
        c.collectionName = vm.envString("OPEN_DEPLOY_COLLECTION_NAME");
        c.collectionSymbol = vm.envString("OPEN_DEPLOY_COLLECTION_SYMBOL");
        uint256 delay = vm.envUint("OPEN_DEPLOY_ADMIN_DELAY_SECONDS");
        if (delay == 0 || delay > type(uint48).max) revert InvalidDelay();
        c.adminDelay = uint48(delay);
        c.deployer = vm.envAddress("OPEN_DEPLOY_DEPLOYER");
        c.delayedAdmin = vm.envAddress("OPEN_DEPLOY_DELAYED_ADMIN");
        c.authorizerManager = vm.envAddress("OPEN_DEPLOY_AUTHORIZER_MANAGER");
        c.pauser = vm.envAddress("OPEN_DEPLOY_PAUSER");
        c.nonceRevoker = vm.envAddress("OPEN_DEPLOY_NONCE_REVOKER");
        c.authorizer = vm.envAddress("OPEN_DEPLOY_AUTHORIZER");
        c.acknowledgement = vm.envString("OPEN_DEPLOY_ACKNOWLEDGEMENT");
    }

    function validateConfiguration(Configuration memory c, uint256 actualChainId) public pure {
        if (actualChainId != LOCAL_CHAIN_ID || c.expectedChainId != LOCAL_CHAIN_ID) revert PublicBroadcastNotApproved();
        if (!_equal(c.domainName, DOMAIN_NAME) || !_equal(c.domainVersion, DOMAIN_VERSION)) revert WrongDomain();
        if (!_equal(c.collectionName, "Signatures Gallery")
            || bytes(c.collectionSymbol).length == 0 || bytes(c.collectionSymbol).length > 16) revert InvalidCollection();
        if (c.adminDelay == 0) revert InvalidDelay();
        address[6] memory identities = _identities(c);
        for (uint256 i; i < identities.length; ++i) {
            if (identities[i] == address(0)) revert InvalidRoleIdentity();
            for (uint256 j; j < i; ++j) if (identities[i] == identities[j]) revert InvalidRoleIdentity();
        }
        if (!_equal(c.acknowledgement, ACKNOWLEDGEMENT)) revert MissingAcknowledgement();
    }

    function deploymentInitcodeHash(Configuration memory c) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(OnchainSignatures).creationCode, abi.encode(
            c.collectionName, c.collectionSymbol, c.adminDelay,
            c.delayedAdmin, c.authorizerManager, c.pauser, c.nonceRevoker, c.authorizer
        )));
    }

    function deployLocal(Configuration memory c) public returns (OnchainSignatures deployed) {
        validateConfiguration(c, block.chainid);
        deployed = new OnchainSignatures(c.collectionName, c.collectionSymbol, c.adminDelay,
            c.delayedAdmin, c.authorizerManager, c.pauser, c.nonceRevoker, c.authorizer);
        validateDeployed(deployed, c);
    }

    function validateDeployed(OnchainSignatures deployed, Configuration memory c) public view {
        validateConfiguration(c, block.chainid);
        if (address(deployed).code.length == 0 || !_equal(deployed.name(), c.collectionName)
            || !_equal(deployed.symbol(), c.collectionSymbol)
            || deployed.defaultAdmin() != c.delayedAdmin || deployed.defaultAdminDelay() != c.adminDelay
            || deployed.trustedAuthorizer() != c.authorizer || deployed.paused()) revert DeploymentMismatch();
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying, bytes32 salt, uint256[] memory extensions) = deployed.eip712Domain();
        if (fields != hex"0f" || !_equal(name, DOMAIN_NAME) || !_equal(version, DOMAIN_VERSION)
            || chainId != c.expectedChainId || verifying != address(deployed) || salt != bytes32(0)
            || extensions.length != 0) revert DeploymentMismatch();
        bytes32[4] memory roles = [deployed.DEFAULT_ADMIN_ROLE(), deployed.AUTHORIZER_MANAGER_ROLE(), deployed.PAUSER_ROLE(), deployed.NONCE_REVOKER_ROLE()];
        address[6] memory identities = _identities(c);
        for (uint256 i; i < roles.length; ++i) {
            for (uint256 j; j < identities.length; ++j) {
                if (deployed.hasRole(roles[i], identities[j]) != (j == i + 1)) revert DeploymentMismatch();
            }
        }
    }

    function _identities(Configuration memory c) private pure returns (address[6] memory) {
        return [c.deployer, c.delayedAdmin, c.authorizerManager, c.pauser, c.nonceRevoker, c.authorizer];
    }
    function _equal(string memory a, string memory b) private pure returns (bool) { return keccak256(bytes(a)) == keccak256(bytes(b)); }
}
