// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
import {SignatureVerification} from "permit2/src/libraries/SignatureVerification.sol";
import {Escrow} from "../src/Escrow.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {ITokenConfig} from "../src/interfaces/ITokenConfig.sol";
import {DeployCoreContracts} from "../script/deploy/DeployCoreContracts.s.sol";
import {MockToken} from "./mock/MockToken.sol";
import {LocalPermit2} from "./helpers/LocalPermit2.sol";
import {TestHelpers} from "./helpers/TestHelpers.sol";

/// @notice A contract depositor of the shape an integrating smart-contract wallet takes: it holds
/// the tokens, it is the Permit2 owner, and an off-chain keeper signs on its behalf through
/// ERC-1271. Mirrors the semantics of Credit Coop's AtumModule -- validate the keeper's authorship
/// of the hash, answer only Permit2 -- and NOTHING about the hash's contents, which ERC-1271 gives
/// it no preimage to inspect.
contract KeeperSignedWallet is IERC1271 {
    bytes4 private constant MAGIC = 0x1626ba7e;
    bytes4 private constant FAILURE = 0xffffffff;

    address public immutable permit2;
    address public immutable keeper;

    constructor(address _permit2, address _keeper) {
        permit2 = _permit2;
        keeper = _keeper;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        if (msg.sender != permit2) return FAILURE;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != keeper) return FAILURE;
        return MAGIC;
    }
}

/// @notice Certora M-01, from the Escrow side: whether a deposit authorization signed for ONE
/// contract depositor can be replayed against ANOTHER one sharing the same keeper.
///
/// @dev WHY THIS FILE EXISTS. The finding is that Permit2's digest does not name the owner and
/// Permit2 tracks nonces per owner, so two ERC-1271 wallets sharing a keeper accept the identical
/// (hash, signature) pair and one authorization could be spent once at each. The report is
/// explicit that the impact "depends on the integrating protocol and whether its digest
/// independently binds the module address".
///
/// This escrow does bind it, outside the digest: `depositId` is
/// keccak256(depositor, depositSignature, permit.nonce) and must equal the `depositId` inside a
/// ReserveWitness the RESERVER signed. Changing the depositor changes the depositId, so the replay
/// needs a fresh reserver signature naming the victim.
///
/// What these tests do and do not claim. They pin that the escrow refuses the replay, and that it
/// refuses it before Permit2 is called (each revert test asserts zero Permit2 transfer calls). The
/// ordering is the escrow's design -- the external call goes last -- and is pinned as such. It is
/// not a security property: a revert after Permit2 would roll the transfer and the nonce back, and
/// Permit2 reaches the wallet only through the `view` ERC-1271 interface, so moving the
/// reserve-signature check after the Permit2 call would not reopen M-01. What does carry M-01 is
/// that the reserver's signature over `depositId` is required at all; a positive test below shows
/// that with one, wallet B's deposit goes through.
///
/// That argument was previously established by reading the code. Every other deposit test in this
/// suite uses an EOA depositor, where Permit2's own ecrecover binds the owner and the finding
/// cannot arise, so the contract-depositor path -- the only one where it CAN arise -- had no
/// coverage at all. These tests execute it.
contract EscrowContractDepositorReplayTest is Test, TestHelpers {
    using SafeERC20 for IERC20;

    uint256 private constant DEPOSIT_AMOUNT = 1000e18;

    /// @dev Selector of the single-permit witness transfer the escrow calls. Written out because
    ///      Permit2 overloads the name (single and batch), so `.selector` is ambiguous. If this
    ///      string were wrong, every `expectCall(..., 0)` below would pass vacuously, so
    ///      `test_depositForTheIntendedWallet_succeeds` expects exactly one call to this selector.
    bytes4 private constant PERMIT2_WITNESS_TRANSFER_FROM = bytes4(
        keccak256(
            "permitWitnessTransferFrom(((address,uint256),uint256,uint256),(address,uint256),address,bytes32,string,bytes)"
        )
    );

    Escrow private s_escrow;
    IERC20 private s_token;
    IPermit2 private s_permit2;

    /// @dev The shared key. Both wallets below validate its signatures, which is the precondition
    /// the finding requires.
    address private keeper;
    uint256 private keeperPrivateKey;

    address private reserver;
    uint256 private reserverPrivateKey;
    address private releaser;
    uint256 private releaserPrivateKey;
    address private settler = makeAddr("settler");

    KeeperSignedWallet private walletA;
    KeeperSignedWallet private walletB;

    function setUp() public {
        s_permit2 = LocalPermit2.etch();

        MockToken mockToken = new MockToken("Test Token", "TEST");
        s_token = IERC20(address(mockToken));

        DeployCoreContracts deployCoreContracts = new DeployCoreContracts();
        (s_escrow,) = deployCoreContracts.run();

        address tokenConfig = makeAddr("tokenConfig");
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), tokenConfig);
        vm.startPrank(tokenConfig);
        s_escrow.allowToken(s_token, 18);
        s_escrow.setTokenFeeConfig(s_token, 20000, 0, 25000000);
        vm.stopPrank();

        (keeper, keeperPrivateKey) = makeAddrAndKey("keeper");
        (reserver, reserverPrivateKey) = makeAddrAndKey("reserver");
        (releaser, releaserPrivateKey) = makeAddrAndKey("releaser");

        walletA = new KeeperSignedWallet(address(s_permit2), keeper);
        walletB = new KeeperSignedWallet(address(s_permit2), keeper);

        // Both funded and both armed: the replay target has to actually have something to take.
        for (uint256 i; i < 2; ++i) {
            address wallet = i == 0 ? address(walletA) : address(walletB);
            MockToken(address(s_token)).mint(wallet, DEPOSIT_AMOUNT * 10);
            vm.prank(wallet);
            s_token.forceApprove(address(s_permit2), type(uint256).max);
        }
    }

    /// The precondition, made explicit: the wallets are genuinely interchangeable as far as the
    /// signature is concerned. One keeper signature satisfies BOTH ERC-1271 surfaces, because
    /// neither can see who the digest was meant for. Anything that stops the replay therefore has
    /// to stop it somewhere other than here.
    function test_bothWalletsValidateTheSameKeeperSignature() public {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness) = _buildDeposit(1);
        bytes memory depositSignature = _signAsKeeper(permit, witness);
        bytes32 digest = _permit2Digest(permit, witness);

        vm.prank(address(s_permit2));
        assertEq(walletA.isValidSignature(digest, depositSignature), bytes4(0x1626ba7e), "wallet A accepts");
        vm.prank(address(s_permit2));
        assertEq(walletB.isValidSignature(digest, depositSignature), bytes4(0x1626ba7e), "wallet B accepts too");
    }

    /// The replay, offered verbatim: the authorization signed for wallet A, resubmitted with
    /// wallet B named as the depositor. `depositId` is derived from the depositor, so the
    /// attacker's reserve witness -- the one the reserver actually signed, for A -- no longer
    /// matches, and the escrow refuses before Permit2 is reached (no `permitWitnessTransferFrom`
    /// call is made at all).
    function test_replayAgainstAnotherWallet_revertsDepositNotFound() public {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness) = _buildDeposit(1);
        bytes memory depositSignature = _signAsKeeper(permit, witness);

        bytes32 depositIdForA = expectedDepositId(permit, address(walletA), witness, depositSignature);
        IEscrow.ReserveWitness memory reserveWitness =
            _constructReserveWitness(depositIdForA, DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        _expectNoPermit2Transfer();
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, depositIdForA));
        vm.prank(settler);
        s_escrow.deposit(
            IEscrow.DepositInput({
                permit: permit,
                depositor: address(walletB),
                depositWitness: witness,
                depositSignature: depositSignature,
                reserveWitness: reserveWitness,
                reserveSignature: reserveSignature
            })
        );
    }

    /// The attacker's obvious next move: recompute `depositId` for wallet B so the equality check
    /// passes. The reserver never signed that value: the signature on offer is the genuine
    /// reserver's, over A's id. Refused for want of a reserver signature that names B.
    function test_replayWithRecomputedDepositId_revertsInvalidSignature() public {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness) = _buildDeposit(1);
        bytes memory depositSignature = _signAsKeeper(permit, witness);

        bytes32 depositIdForA = expectedDepositId(permit, address(walletA), witness, depositSignature);
        bytes32 depositIdForB = expectedDepositId(permit, address(walletB), witness, depositSignature);
        assertTrue(depositIdForA != depositIdForB, "depositId must be depositor-specific");

        // Reserver signed for A; the attacker presents B's id behind A's signature.
        IEscrow.ReserveWitness memory witnessForA =
            _constructReserveWitness(depositIdForA, DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT);
        bytes memory signatureForA = _constructReserveSignature(s_escrow, witnessForA, reserverPrivateKey);
        IEscrow.ReserveWitness memory witnessForB =
            _constructReserveWitness(depositIdForB, DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT);

        _expectNoPermit2Transfer();
        vm.expectRevert(IEscrow.InvalidSignature.selector);
        vm.prank(settler);
        s_escrow.deposit(
            IEscrow.DepositInput({
                permit: permit,
                depositor: address(walletB),
                depositWitness: witness,
                depositSignature: depositSignature,
                reserveWitness: witnessForB,
                reserveSignature: signatureForA
            })
        );
    }

    /// The attacker substituting their own key for the reserver. `reserver` is a member of the
    /// DEPOSIT witness the keeper signed, so naming the attacker there changes the Permit2 digest;
    /// the reserve-signature check passes (the attacker signs as the reserver the witness now
    /// names), but wallet B's ERC-1271 rejects the keeper's signature over the original digest and
    /// Permit2 reverts. The reserver cannot be swapped without invalidating the replayed signature.
    function test_replaySwappingReserverForAttacker_revertsInvalidContractSignature() public {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness) = _buildDeposit(1);
        bytes memory depositSignature = _signAsKeeper(permit, witness);

        (address attacker, uint256 attackerKey) = makeAddrAndKey("attackerPretendingToBeReserver");
        IEscrow.DepositWitness memory swapped = witness;
        swapped.reserver = attacker;

        bytes32 depositIdForB = expectedDepositId(permit, address(walletB), swapped, depositSignature);
        IEscrow.ReserveWitness memory witnessForB =
            _constructReserveWitness(depositIdForB, DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT);

        // The call reaches Permit2 (the escrow's own checks all pass) and is refused there.
        vm.expectCall(address(s_permit2), abi.encodePacked(PERMIT2_WITNESS_TRANSFER_FROM), 1);
        vm.expectRevert(SignatureVerification.InvalidContractSignature.selector);
        vm.prank(settler);
        s_escrow.deposit(
            IEscrow.DepositInput({
                permit: permit,
                depositor: address(walletB),
                depositWitness: swapped,
                depositSignature: depositSignature,
                reserveWitness: witnessForB,
                reserveSignature: _constructReserveSignature(s_escrow, witnessForB, attackerKey)
            })
        );
    }

    /// And the control: the same authorization against the wallet it was issued for succeeds, so
    /// the two reverts above are the binding working rather than the fixture being broken.
    function test_depositForTheIntendedWallet_succeeds() public {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness) = _buildDeposit(1);
        bytes memory depositSignature = _signAsKeeper(permit, witness);

        bytes32 depositIdForA = expectedDepositId(permit, address(walletA), witness, depositSignature);
        IEscrow.ReserveWitness memory reserveWitness =
            _constructReserveWitness(depositIdForA, DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        uint256 walletBalanceBefore = s_token.balanceOf(address(walletA));
        uint256 escrowBalanceBefore = s_token.balanceOf(address(s_escrow));

        // Positive control for the zero-call expectations in the revert tests: the selector they
        // watch for is the one a real deposit makes.
        vm.expectCall(address(s_permit2), abi.encodePacked(PERMIT2_WITNESS_TRANSFER_FROM), 1);
        vm.prank(settler);
        bytes32 depositId = s_escrow.deposit(
            IEscrow.DepositInput({
                permit: permit,
                depositor: address(walletA),
                depositWitness: witness,
                depositSignature: depositSignature,
                reserveWitness: reserveWitness,
                reserveSignature: reserveSignature
            })
        );

        assertEq(depositId, depositIdForA, "the escrow derives the depositId the tests compute");
        assertEq(
            walletBalanceBefore - s_token.balanceOf(address(walletA)), DEPOSIT_AMOUNT, "wallet A debited exactly once"
        );
        assertEq(
            s_token.balanceOf(address(s_escrow)) - escrowBalanceBefore, DEPOSIT_AMOUNT, "escrow credited the deposit"
        );
    }

    /// Permit2's nonces are per owner, so wallet B's copy of the nonce is still free after A's
    /// deposit consumed its own -- the replay has not been foreclosed by A's deposit, and nothing
    /// but the reserver stands in the way. Without a reserver signature naming B it is refused.
    function test_afterASucceeds_bNonceIsFree_butReplayStillNeedsAReserverSignature() public {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness) = _buildDeposit(1);
        bytes memory depositSignature = _signAsKeeper(permit, witness);

        assertFalse(_nonceUsed(address(walletA), 1), "nonce 1 starts free for A");
        assertFalse(_nonceUsed(address(walletB), 1), "nonce 1 starts free for B");

        (IEscrow.ReserveWitness memory witnessForA, bytes memory signatureForA) =
            _reserveFor(permit, address(walletA), witness, depositSignature);
        vm.prank(settler);
        s_escrow.deposit(
            IEscrow.DepositInput({
                permit: permit,
                depositor: address(walletA),
                depositWitness: witness,
                depositSignature: depositSignature,
                reserveWitness: witnessForA,
                reserveSignature: signatureForA
            })
        );

        assertTrue(_nonceUsed(address(walletA), 1), "A's deposit consumed A's nonce");
        assertFalse(_nonceUsed(address(walletB), 1), "B's nonce is a separate, still-free slot");

        // B's id behind the reserver's signature for A: refused before Permit2.
        bytes32 depositIdForB = expectedDepositId(permit, address(walletB), witness, depositSignature);
        IEscrow.ReserveWitness memory witnessForB =
            _constructReserveWitness(depositIdForB, DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT);
        _expectNoPermit2Transfer();
        vm.expectRevert(IEscrow.InvalidSignature.selector);
        vm.prank(settler);
        s_escrow.deposit(
            IEscrow.DepositInput({
                permit: permit,
                depositor: address(walletB),
                depositWitness: witness,
                depositSignature: depositSignature,
                reserveWitness: witnessForB,
                reserveSignature: signatureForA
            })
        );
    }

    /// The converse, and the whole dependence on the reserver made visible: given a genuine
    /// reserver signature over B's `depositId`, A's keeper authorization DOES deposit from wallet B
    /// at real Permit2. Nothing else in the escrow stops it, because ERC-1271 cannot say whom a
    /// digest was meant for. The protection therefore holds only while the reserver signs only ids
    /// it can attribute to an authorization it issued (the PR body's stated assumption).
    function test_withAReserverSignatureForB_theSameKeeperAuthorizationDepositsFromB() public {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness) = _buildDeposit(1);
        bytes memory depositSignature = _signAsKeeper(permit, witness);

        (IEscrow.ReserveWitness memory witnessForB, bytes memory signatureForB) =
            _reserveFor(permit, address(walletB), witness, depositSignature);

        uint256 balanceBefore = s_token.balanceOf(address(walletB));
        assertFalse(_nonceUsed(address(walletB), 1), "nonce 1 starts free for B");

        vm.prank(settler);
        s_escrow.deposit(
            IEscrow.DepositInput({
                permit: permit,
                depositor: address(walletB),
                depositWitness: witness,
                depositSignature: depositSignature,
                reserveWitness: witnessForB,
                reserveSignature: signatureForB
            })
        );

        assertEq(balanceBefore - s_token.balanceOf(address(walletB)), DEPOSIT_AMOUNT, "wallet B debited");
        assertTrue(_nonceUsed(address(walletB), 1), "B's nonce consumed");
    }

    /*//////////////////////////////////////////////////////////////////////////
                                    HELPERS
    //////////////////////////////////////////////////////////////////////////*/

    /// @dev No `permitWitnessTransferFrom` reaches Permit2 for the rest of the test. This is the
    ///      assertion that can fail where a post-revert balance check cannot: a call that reverted
    ///      leaves no debit by construction, but it can still have run Permit2 first.
    function _expectNoPermit2Transfer() private {
        vm.expectCall(address(s_permit2), abi.encodePacked(PERMIT2_WITNESS_TRANSFER_FROM), 0);
    }

    function _nonceUsed(address owner, uint256 nonce) private view returns (bool) {
        return s_permit2.nonceBitmap(owner, nonce >> 8) & (1 << (nonce & 0xff)) != 0;
    }

    /// @dev The reserver's signature over the ReserveWitness naming `depositor`'s depositId.
    function _reserveFor(
        ISignatureTransfer.PermitTransferFrom memory permit,
        address depositor,
        IEscrow.DepositWitness memory witness,
        bytes memory depositSignature
    ) private view returns (IEscrow.ReserveWitness memory reserveWitness, bytes memory reserveSignature) {
        reserveWitness = _constructReserveWitness(
            expectedDepositId(permit, depositor, witness, depositSignature), DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT
        );
        reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);
    }

    function _buildDeposit(uint256 nonce)
        private
        view
        returns (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness)
    {
        return _constructDepositPermitWitness(
            address(s_token),
            DEPOSIT_AMOUNT,
            reserver,
            releaser,
            nonce,
            DEFAULT_DEPOSIT_REQUEST_HASH,
            DEFAULT_DESTINATION
        );
    }

    /// @dev What the off-chain keeper produces: an ordinary Permit2 typed-data signature. The
    ///      wallet is the Permit2 owner; the keeper is merely the key that speaks for it.
    function _signAsKeeper(ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness)
        private
        view
        returns (bytes memory)
    {
        return _constructDepositSignature(permit, witness, s_permit2, address(s_escrow), keeperPrivateKey);
    }

    function _permit2Digest(ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness)
        private
        view
        returns (bytes32)
    {
        bytes32 witnessHash = keccak256(
            abi.encode(
                keccak256(
                    "DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)"
                ),
                witness.depositRequestHash,
                keccak256(bytes(witness.destination)),
                witness.reserver,
                witness.releaser
            )
        );
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                "DepositWitness witness)DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)TokenPermissions(address token,uint256 amount)"
            )
        );
        bytes32 tokenPermissionsHash =
            keccak256(abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), permit.permitted));
        bytes32 structHash = keccak256(
            abi.encode(typeHash, tokenPermissionsHash, address(s_escrow), permit.nonce, permit.deadline, witnessHash)
        );
        return keccak256(abi.encodePacked("\x19\x01", s_permit2.DOMAIN_SEPARATOR(), structHash));
    }
}
