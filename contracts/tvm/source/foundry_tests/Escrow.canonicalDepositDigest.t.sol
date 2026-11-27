// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IPermit2} from "@alexroan/permit2-tron/contracts/interfaces/IPermit2.sol";
import {ISignatureTransfer} from "@alexroan/permit2-tron/contracts/interfaces/ISignatureTransfer.sol";
import {Escrow} from "../contracts/Escrow.sol";
import {IEscrow} from "../contracts/interfaces/IEscrow.sol";
import {TestHelpers} from "./helpers/TestHelpers.sol";
import {LocalPermit2} from "./helpers/LocalPermit2.sol";
import {DeployCoreContracts} from "../foundry_scripts/DeployCoreContracts.s.sol";
import {MockToken6DecimalsTransferReturnsFalse} from "./mock/MockToken.sol";

/// @notice Pins the DEPOSIT witness encode order to a literal no code in this repo produced.
///
/// WHY THIS FILE EXISTS. Escrow.canonicalDigest.t.sol guards the release and refund struct hashes the
/// same way, but `_deposit` has a third `abi.encode` block with the identical hazard and nothing
/// covering it:
///
///     keccak256(abi.encode(
///         DEPOSIT_WITNESS_TYPE_HASH,
///         depositInput.depositWitness.depositRequestHash,             // bytes32
///         keccak256(bytes(depositInput.depositWitness.destination)),  // bytes32, ADJACENT
///         ...
///
/// Two adjacent `bytes32`, and every other guard in the tree is blind to a transposition:
///   - Escrow.declarationOrder.t.sol checks the struct DECLARATION against the type string. It never
///     looks at the abi.encode order inside `_deposit`.
///   - Permit2 takes the witness as an opaque bytes32, so no fork test can see a mismatch.
///   - `make check-abi` is a "did you regenerate" check, not a correctness check.
///   - helpers/Signatures.sol computes the SAME encode order, so the oracle agrees with the mistake.
///
/// That last one is the whole problem: the deposit suite would stay green while every depositor
/// signature failed Permit2 recovery on the real contract. Shipped transposed, NO DEPOSIT CAN SUCCEED
/// ON TRON.
///
/// HOW THE GUARD WORKS. PINNED_DEPOSIT_WITNESS_HASH below was derived OUT OF BAND from the canonical
/// type string with an independent keccak-256 — not by this package, not by Signatures.sol. The test
/// builds a real deposit, signs the Permit2 digest computed from THAT pinned hash, and requires the
/// contract to accept it. If `_deposit`'s encode order drifts, the contract derives a different
/// witness hash, Permit2 recovers a different signer, and the deposit reverts — so no test-side
/// encoding participates in the assertion.
///
/// DO NOT repoint the literal to make a failing test pass. Re-derive it out of band from the
/// canonical type string; repointing turns an independent oracle into a self-fulfilling one and
/// reintroduces exactly the hazard above.
contract EscrowCanonicalDepositDigestTest is Test, TestHelpers {
    /// @dev The destination the pinned hash was derived over.
    string private constant DESTINATION =
        "tron:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t@TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs";
    bytes32 private constant DEPOSIT_REQUEST_HASH =
        bytes32(uint256(0x3333333333333333333333333333333333333333333333333333333333333333));

    /// keccak256(abi.encode(DEPOSIT_WITNESS_TYPE_HASH, depositRequestHash, keccak256(bytes(destination)),
    /// reserver, releaser)) for the values below, derived out of band.
    bytes32 private constant PINNED_DEPOSIT_WITNESS_HASH =
        0x4add377caa02d80536b1a3850f1cb68dec328b52ef13cf1711ff3af3af983d9d;
    /// The SAME members with depositRequestHash and the destination hash transposed — what a
    /// transposed contract would produce. Pinned so the two are provably different values.
    bytes32 private constant PINNED_DEPOSIT_WITNESS_HASH_TRANSPOSED =
        0x059701c337c6979190c95633b49232e381974c15a6ae139cfc0ada5b011f226d;

    uint256 private constant DEPOSIT_AMOUNT = 1_000_000;

    Escrow private s_escrow;
    IPermit2 private s_permit2;
    MockToken6DecimalsTransferReturnsFalse private s_token;

    address private settler = makeAddr("settler");
    /// The pinned hash bakes in these two role addresses, so they are fixed keys rather than
    /// makeAddrAndKey-derived ones: the reserve signature has to come from the SAME reserver the
    /// hash was derived over, which means holding its private key.
    uint256 private constant RESERVER_PK = 0x000000000000000000000000000000000000000000000000000000000000b0b2;
    address private constant RESERVER = 0x606fBd0C4786B1ca87adb09dfd5CE8631b0118c3;
    address private constant RELEASER = 0xeBaa10Eb0985A3f6F5e70E2DdB56E45ef3c16d4c;

    address private depositor;
    uint256 private depositorPrivateKey;

    function setUp() public {
        s_permit2 = LocalPermit2.etch();
        s_token = new MockToken6DecimalsTransferReturnsFalse("Test Token", "TEST");

        DeployCoreContracts deployCoreContracts = new DeployCoreContracts();
        (s_escrow,) = deployCoreContracts.run(IERC20(address(s_token)));

        address tokenConfig = makeAddr("tokenConfig");
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), tokenConfig);
        vm.prank(tokenConfig);
        s_escrow.allowToken(IERC20(address(s_token)), 6);

        (depositor, depositorPrivateKey) = makeAddrAndKey("depositor");

        // Fail loudly here rather than as a confusing InvalidSignature later if forge's key-to-address
        // mapping ever changes out from under the pinned literals.
        assertEq(vm.addr(RESERVER_PK), RESERVER, "RESERVER does not match vm.addr(RESERVER_PK)");

        s_token.mint(depositor, type(uint128).max);
        vm.prank(depositor);
        s_token.approve(address(s_permit2), type(uint256).max);
    }

    /// @dev The Permit2 digest, built from a CALLER-SUPPLIED witness hash rather than from the
    /// witness struct. That substitution is the entire point: it lets the test sign the out-of-band
    /// hash instead of one this repo computed.
    function _signPermit2(ISignatureTransfer.PermitTransferFrom memory permit, bytes32 witnessHash)
        private
        view
        returns (bytes memory)
    {
        string memory witnessTypeString =
            "DepositWitness witness)DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)TokenPermissions(address token,uint256 amount)";
        string memory permitStub =
            "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";
        bytes32 typeHash = keccak256(abi.encodePacked(permitStub, witnessTypeString));
        bytes32 tokenPermissionsHash =
            keccak256(abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), permit.permitted));
        bytes32 structHash = keccak256(
            abi.encode(typeHash, tokenPermissionsHash, address(s_escrow), permit.nonce, permit.deadline, witnessHash)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", s_permit2.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(depositorPrivateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _depositInput(bytes32 witnessHash) private view returns (IEscrow.DepositInput memory) {
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(s_token), amount: DEPOSIT_AMOUNT}),
            nonce: 0,
            deadline: block.timestamp + 1 days
        });
        IEscrow.DepositWitness memory witness = IEscrow.DepositWitness({
            depositRequestHash: DEPOSIT_REQUEST_HASH, destination: DESTINATION, reserver: RESERVER, releaser: RELEASER
        });
        bytes memory depositSignature = _signPermit2(permit, witnessHash);
        bytes32 depositId = expectedDepositId(permit, depositor, witness, depositSignature);
        IEscrow.ReserveWitness memory reserveWitness =
            _constructReserveWitness(depositId, DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT);
        return IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: witness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: _constructReserveSignature(s_escrow, reserveWitness, RESERVER_PK)
        });
    }

    function test_depositAcceptsSignatureOverPinnedCanonicalWitnessHash() public {
        IEscrow.DepositInput memory input = _depositInput(PINNED_DEPOSIT_WITNESS_HASH);
        // Reverting here means Escrow.sol's `_deposit` witness encode order has DRIFTED from
        // "DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address
        // releaser)". Do NOT repoint PINNED_DEPOSIT_WITNESS_HASH.
        vm.prank(settler);
        s_escrow.deposit(input);
    }

    function test_depositRejectsTheTransposedWitnessHash() public {
        // The counterfactual: what a contract with depositRequestHash and destinationHash swapped
        // would compute. It must NOT verify, or the guard above proves nothing.
        IEscrow.DepositInput memory input = _depositInput(PINNED_DEPOSIT_WITNESS_HASH_TRANSPOSED);
        vm.prank(settler);
        vm.expectRevert();
        s_escrow.deposit(input);
    }

    function test_theTwoPinnedHashesActuallyDiffer() public pure {
        assertTrue(
            PINNED_DEPOSIT_WITNESS_HASH != PINNED_DEPOSIT_WITNESS_HASH_TRANSPOSED,
            "the canonical and transposed literals must differ, or neither test means anything"
        );
    }
}
