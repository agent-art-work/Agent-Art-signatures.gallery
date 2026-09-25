// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeployOnchainSignatures} from "../script/DeployOnchainSignatures.s.sol";
import {OnchainSignatures} from "../src/OnchainSignatures.sol";

interface OnchainDeploymentTestVm {
    function chainId(uint256 id) external;
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert() external;
    function etch(address target, bytes calldata code) external;
}

contract DeployOnchainSignaturesTest {
    OnchainDeploymentTestVm private constant VM = OnchainDeploymentTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    DeployOnchainSignatures private script;

    function setUp() public { VM.chainId(31337); script = new DeployOnchainSignatures(); }

    function _configuration() private pure returns (DeployOnchainSignatures.Configuration memory c) {
        c.expectedChainId = 31337;
        c.domainName = "SignaturesOnchainMint"; c.domainVersion = "1";
        c.collectionName = "Signatures Gallery"; c.collectionSymbol = "OPEN";
        c.adminDelay = 2 days;
        c.deployer = address(0xD001); c.delayedAdmin = address(0xA001);
        c.authorizerManager = address(0xA002); c.pauser = address(0xA003);
        c.nonceRevoker = address(0xA004); c.authorizer = address(0xA005);
        c.acknowledgement = "LOCAL_ONLY_NO_PUBLIC_BROADCAST";
    }

    function testLocalDeploymentChecksOnlyActualOnchainSignaturesGetters() public {
        DeployOnchainSignatures.Configuration memory c = _configuration();
        OnchainSignatures deployed = script.deployLocal(c);
        script.validateDeployed(deployed, c);
        require(deployed.trustedAuthorizer() == c.authorizer);
        require(!deployed.hasRole(deployed.DEFAULT_ADMIN_ROLE(), c.deployer));
        require(!deployed.hasRole(deployed.NONCE_REVOKER_ROLE(), c.authorizer));
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying,,) = deployed.eip712Domain();
        require(fields == hex"0f" && keccak256(bytes(name)) == keccak256("SignaturesOnchainMint"));
        require(keccak256(bytes(version)) == keccak256("1") && chainId == 31337 && verifying == address(deployed));
    }

    function testPublicBroadcastAlwaysRefusedIncludingSuggestedTestnet() public {
        DeployOnchainSignatures.Configuration memory c = _configuration();
        VM.expectRevert(DeployOnchainSignatures.PublicBroadcastNotApproved.selector); script.validateConfiguration(c, 1);
        VM.expectRevert(DeployOnchainSignatures.PublicBroadcastNotApproved.selector); script.validateConfiguration(c, 11155111);
        c.expectedChainId = 11155111;
        VM.expectRevert(DeployOnchainSignatures.PublicBroadcastNotApproved.selector); script.validateConfiguration(c, 31337);
        VM.chainId(11155111);
        VM.expectRevert(DeployOnchainSignatures.PublicBroadcastNotApproved.selector); script.deployLocal(c);
    }

    function testWrongDomainAndLegacyVersionRefused() public {
        DeployOnchainSignatures.Configuration memory c = _configuration(); c.domainName = "signatures.gallery";
        VM.expectRevert(DeployOnchainSignatures.WrongDomain.selector); script.validateConfiguration(c, 31337);
        c = _configuration(); c.domainVersion = "2";
        VM.expectRevert(DeployOnchainSignatures.WrongDomain.selector); script.validateConfiguration(c, 31337);
    }

    function testInvalidCollectionIdentityOrZeroDelayRefused() public {
        DeployOnchainSignatures.Configuration memory c = _configuration(); c.collectionName = "";
        VM.expectRevert(DeployOnchainSignatures.InvalidCollection.selector); script.validateConfiguration(c, 31337);
        c = _configuration(); c.collectionName = "External hosted collection";
        VM.expectRevert(DeployOnchainSignatures.InvalidCollection.selector); script.validateConfiguration(c, 31337);
        c = _configuration(); c.adminDelay = 0;
        VM.expectRevert(DeployOnchainSignatures.InvalidDelay.selector); script.validateConfiguration(c, 31337);
    }

    function testRequiresExplicitLocalAcknowledgement() public {
        DeployOnchainSignatures.Configuration memory c = _configuration(); c.acknowledgement = "approved";
        VM.expectRevert(DeployOnchainSignatures.MissingAcknowledgement.selector); script.deployLocal(c);
    }

    function testFuzzEveryRoleCollisionOrZeroIsRefused(uint8 first, uint8 second) public {
        first %= 6; second %= 6;
        DeployOnchainSignatures.Configuration memory c = _configuration();
        address[6] memory identities = [c.deployer, c.delayedAdmin, c.authorizerManager, c.pauser, c.nonceRevoker, c.authorizer];
        _setIdentity(c, second, first == second ? address(0) : identities[first]);
        VM.expectRevert(DeployOnchainSignatures.InvalidRoleIdentity.selector); script.validateConfiguration(c, 31337);
    }

    function testInitcodeHashBindsExactConstructor() public view {
        DeployOnchainSignatures.Configuration memory c = _configuration();
        bytes32 expected = keccak256(abi.encodePacked(type(OnchainSignatures).creationCode, abi.encode(c.collectionName, c.collectionSymbol,
            c.adminDelay, c.delayedAdmin, c.authorizerManager, c.pauser, c.nonceRevoker, c.authorizer)));
        require(script.deploymentInitcodeHash(c) == expected);
        c.authorizer = address(0xB001); require(script.deploymentInitcodeHash(c) != expected);
    }

    function testChangedSignerPauseOrExtraRoleFailsInitialObservation() public {
        DeployOnchainSignatures.Configuration memory c = _configuration(); OnchainSignatures deployed = script.deployLocal(c);
        VM.prank(c.authorizerManager); deployed.setTrustedAuthorizer(address(0xB001));
        VM.expectRevert(DeployOnchainSignatures.DeploymentMismatch.selector); script.validateDeployed(deployed, c);
        VM.prank(c.authorizerManager); deployed.setTrustedAuthorizer(c.authorizer);
        VM.prank(c.pauser); deployed.pauseMinting();
        VM.expectRevert(DeployOnchainSignatures.DeploymentMismatch.selector); script.validateDeployed(deployed, c);
        VM.prank(c.delayedAdmin); deployed.unpauseMinting();
        script.validateDeployed(deployed, c);
        bytes32 pauserRole = deployed.PAUSER_ROLE();
        VM.prank(c.delayedAdmin); deployed.grantRole(pauserRole, c.deployer);
        VM.expectRevert(DeployOnchainSignatures.DeploymentMismatch.selector); script.validateDeployed(deployed, c);
    }

    function testSeparateNonceRevokerWorksWithoutURIOrSignerMutation() public {
        DeployOnchainSignatures.Configuration memory c = _configuration(); OnchainSignatures deployed = script.deployLocal(c);
        VM.prank(c.nonceRevoker); deployed.revokeNonce(bytes32(uint256(7)));
        require(deployed.revokedNonces(bytes32(uint256(7)))); script.validateDeployed(deployed, c);
    }

    function testMissingRuntimeCannotPass() public {
        DeployOnchainSignatures.Configuration memory c = _configuration(); OnchainSignatures deployed = script.deployLocal(c);
        VM.etch(address(deployed), hex"");
        VM.expectRevert(DeployOnchainSignatures.DeploymentMismatch.selector); script.validateDeployed(deployed, c);
    }

    function _setIdentity(DeployOnchainSignatures.Configuration memory c, uint8 index, address value) private pure {
        if (index == 0) c.deployer = value; else if (index == 1) c.delayedAdmin = value;
        else if (index == 2) c.authorizerManager = value; else if (index == 3) c.pauser = value;
        else if (index == 4) c.nonceRevoker = value; else c.authorizer = value;
    }
}
