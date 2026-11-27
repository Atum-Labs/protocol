// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
import {MockToken} from "../mock/MockToken.sol";
import {Escrow} from "../../src/Escrow.sol";
import {IEscrow} from "../../src/interfaces/IEscrow.sol";
import {LocalPermit2} from "../helpers/LocalPermit2.sol";
import {TestHelpers} from "../helpers/TestHelpers.sol";

/// @notice Handler for the direct-deposit invariant suite: both deposit paths, reserve, release,
///         refund by the releaser (reserved) or by the depositor (unreserved), fee withdrawal and stray
///         transfers, with every input bounded
///         so no action reverts (foundry.toml sets `fail_on_revert = true`).
contract EscrowDirectDepositHandler is TestHelpers {
    Escrow public s_escrow;
    IERC20 public s_token;
    IPermit2 public s_permit2;

    address public owner;
    uint256 public ownerPrivateKey;
    address public reserver;
    uint256 public reserverPrivateKey;
    address public releaser;
    uint256 public releaserPrivateKey;
    address public settler = makeAddr("settler");
    address public treasurer = makeAddr("treasurer");
    address public stranger = makeAddr("stranger");

    struct Active {
        bytes32 depositId;
        uint256 amount;
        uint256 feeAmount;
        bool reserved;
    }

    Active[] public s_active;
    uint256 public s_directNonce;
    uint256 public s_permitNonce;
    // Stray balance: transferred to the escrow with no deposit behind it
    uint256 public s_stray;

    // Action counters, so a run that silently never reaches an action is visible in -vv output
    uint256 public s_calls;
    uint256 public s_directDeposits;
    uint256 public s_permit2Deposits;
    uint256 public s_reserves;
    uint256 public s_releases;
    uint256 public s_refunds;
    uint256 public s_unreservedRefunds;
    uint256 public s_withdrawals;
    uint256 public s_strays;

    // Floor: `determineFee` reverts with FeeExceedsDepositAmount when the ceiling-rounded fee is
    // not below the amount, which a dust deposit under the configured percentage triggers.
    uint256 internal constant MIN_AMOUNT = 1e6;
    uint256 internal constant MAX_AMOUNT = 1_000_000e18;

    constructor(Escrow escrow, IERC20 token, IPermit2 permit2) {
        s_escrow = escrow;
        s_token = token;
        s_permit2 = permit2;
        (owner, ownerPrivateKey) = makeAddrAndKey("owner");
        (reserver, reserverPrivateKey) = makeAddrAndKey("reserver");
        (releaser, releaserPrivateKey) = makeAddrAndKey("releaser");
        vm.prank(owner);
        s_token.approve(address(s_permit2), type(uint256).max);
    }

    function activeTotal() external view returns (uint256 total) {
        for (uint256 i; i < s_active.length; i++) {
            total += s_active[i].amount;
        }
    }

    function activeCount() external view returns (uint256) {
        return s_active.length;
    }

    function _witness() internal view returns (IEscrow.DepositWitness memory) {
        return IEscrow.DepositWitness({
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destination: DEFAULT_DESTINATION,
            reserver: reserver,
            releaser: releaser
        });
    }

    function _fund(address account, uint256 amount) internal {
        deal(address(s_token), account, s_token.balanceOf(account) + amount);
    }

    function _fee(uint256 amount) internal view returns (uint256) {
        return s_escrow.determineFee(amount, s_escrow.getTokenConfig(s_token));
    }

    /// @dev The owner's batch: the approval of the amount, then the call.
    function directDeposit(uint256 amount) external {
        s_calls++;
        amount = bound(amount, MIN_AMOUNT, MAX_AMOUNT);
        _fund(owner, amount);
        uint256 nonce = s_directNonce++;
        bytes32 depositId = _directDepositId(address(s_escrow), owner, address(s_token), nonce, _witness(), amount);
        IEscrow.DirectDepositInput memory input = IEscrow.DirectDepositInput({
            token: address(s_token), amount: amount, nonce: nonce, depositWitness: _witness()
        });
        // Single pranks: the fuzzer wraps every handler call in a single `vm.prank`, which a
        // `vm.startPrank` here cannot override
        vm.prank(owner);
        s_token.approve(address(s_escrow), amount);
        vm.prank(owner);
        s_escrow.directDeposit(input);
        s_active.push(Active({depositId: depositId, amount: amount, feeAmount: 0, reserved: false}));
        s_directDeposits++;
    }

    function depositPermit2(uint256 amount) external {
        s_calls++;
        amount = bound(amount, MIN_AMOUNT, MAX_AMOUNT);
        _fund(owner, amount);
        uint256 feeAmount = _fee(amount);
        uint256 nonce = s_permitNonce++;
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness) = _constructDepositPermitWitness(
            address(s_token), amount, reserver, releaser, nonce, DEFAULT_DEPOSIT_REQUEST_HASH, DEFAULT_DESTINATION
        );
        bytes memory depositSignature =
            _constructDepositSignature(permit, witness, s_permit2, address(s_escrow), ownerPrivateKey);
        bytes32 depositId = keccak256(abi.encode(owner, depositSignature, nonce));
        IEscrow.ReserveWitness memory reserveWitness =
            _constructReserveWitness(depositId, DEFAULT_QUOTE_HASH, settler, amount);
        IEscrow.DepositInput memory input = IEscrow.DepositInput({
            permit: permit,
            depositor: owner,
            depositWitness: witness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey)
        });
        s_escrow.deposit(input);
        s_active.push(Active({depositId: depositId, amount: amount, feeAmount: feeAmount, reserved: true}));
        s_permit2Deposits++;
    }

    /// @dev Reserves an unreserved direct deposit, if any, for a quote charging up to its amount;
    ///      the escrow refunds the rest to the owner.
    function reserve(uint256 seed, uint256 sourceAmount) external {
        s_calls++;
        (bool found, uint256 index) = _pick(seed, false);
        if (!found) return;
        Active storage active = s_active[index];
        sourceAmount = bound(sourceAmount, MIN_AMOUNT, active.amount);
        IEscrow.ReserveWitness memory reserveWitness =
            _constructReserveWitness(active.depositId, DEFAULT_QUOTE_HASH, settler, sourceAmount);
        s_escrow.reserve(
            IEscrow.ReserveInput({
                depositor: owner,
                token: address(s_token),
                amount: active.amount,
                depositWitness: _witness(),
                reserveWitness: reserveWitness,
                reserveSignature: _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey)
            })
        );
        active.reserved = true;
        active.amount = sourceAmount;
        active.feeAmount = _fee(sourceAmount);
        s_reserves++;
    }

    /// @dev Releases a reserved deposit, if any.
    function release(uint256 seed) external {
        s_calls++;
        (bool found, uint256 index) = _pick(seed, true);
        if (!found) return;
        Active memory active = s_active[index];
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: active.depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: owner,
            token: address(s_token),
            amount: active.amount,
            feeAmount: active.feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });
        s_escrow.release(
            IEscrow.ReleaseInput({
                releaseWitness: witness,
                releaseSignature: _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey)
            })
        );
        _remove(index);
        s_releases++;
    }

    /// @dev Refunds any active deposit: the releaser refunds a reserved one, the owner an unreserved
    ///      one with `refundUnreserved` and no signature. One handler for both, so adding the
    ///      depositor path does not dilute the other actions' share of the sequence.
    function refund(uint256 seed) external {
        s_calls++;
        if (s_active.length == 0) return;
        uint256 index = seed % s_active.length;
        Active memory active = s_active[index];
        if (active.reserved) {
            IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
                depositId: active.depositId,
                quoteHash: DEFAULT_QUOTE_HASH,
                depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                destinationHash: DEFAULT_DESTINATION_HASH,
                depositor: owner,
                token: address(s_token),
                amount: active.amount,
                feeAmount: active.feeAmount,
                reserver: reserver,
                releaser: releaser,
                settler: settler
            });
            s_escrow.refund(
                IEscrow.RefundInput({
                    refundWitness: witness,
                    refundSignature: _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey)
                })
            );
            s_refunds++;
        } else {
            vm.prank(owner);
            s_escrow.refundUnreserved(
                IEscrow.RefundUnreservedInput({
                    depositId: active.depositId,
                    depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                    destinationHash: DEFAULT_DESTINATION_HASH,
                    token: address(s_token),
                    amount: active.amount,
                    reserver: reserver,
                    releaser: releaser
                })
            );
            s_unreservedRefunds++;
        }
        _remove(index);
    }

    function withdrawFees() external {
        s_calls++;
        if (s_escrow.getFeeRevenue(s_token) == 0) return;
        vm.prank(treasurer);
        s_escrow.withdrawFeeRevenue(s_token, treasurer);
        s_withdrawals++;
    }

    /// @dev A transfer with no deposit behind it: no deposit path credits it, so it stays in the
    ///      balance and the balance invariant counts it.
    function strayTransfer(uint256 amount) external {
        s_calls++;
        amount = bound(amount, 1, MAX_AMOUNT);
        _fund(stranger, amount);
        vm.prank(stranger);
        s_token.transfer(address(s_escrow), amount);
        s_stray += amount;
        s_strays++;
    }

    /// @dev Picks an active deposit with the given reserved state, starting at `seed`.
    function _pick(uint256 seed, bool reserved) internal view returns (bool found, uint256 index) {
        uint256 count = s_active.length;
        if (count == 0) return (false, 0);
        uint256 start = seed % count;
        for (uint256 i; i < count; i++) {
            index = (start + i) % count;
            if (s_active[index].reserved == reserved) return (true, index);
        }
        return (false, 0);
    }

    function _remove(uint256 index) internal {
        s_active[index] = s_active[s_active.length - 1];
        s_active.pop();
    }
}

/// @notice The escrow's balance is exactly the sum of active deposit amounts across both deposit
///         paths, plus the fee revenue not yet withdrawn, plus stray transfers (which no deposit
///         can claim, so they stay in the balance).
contract EscrowDirectDepositInvariantTest is Test {
    /// @dev `[invariant] depth` in foundry.toml: the vacuity asserts in `afterInvariant` run only
    /// after a sequence of at least this many calls. Raise it together with the config.
    uint256 internal constant INVARIANT_DEPTH = 100;

    Escrow public s_escrow;
    IERC20 public s_token;
    EscrowDirectDepositHandler public s_handler;

    function setUp() public {
        IPermit2 permit2 = LocalPermit2.etch();
        MockToken mockToken = new MockToken("Test Token", "TEST");
        s_token = IERC20(address(mockToken));

        s_escrow = new Escrow(permit2, address(this));
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), address(this));
        s_escrow.allowToken(s_token, 18);
        s_escrow.setTokenFeeConfig(s_token, 20000, 0, 25000000);

        s_handler = new EscrowDirectDepositHandler(s_escrow, s_token, permit2);
        s_escrow.grantRole(s_escrow.TREASURER_ROLE(), s_handler.treasurer());

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = EscrowDirectDepositHandler.directDeposit.selector;
        selectors[1] = EscrowDirectDepositHandler.depositPermit2.selector;
        selectors[2] = EscrowDirectDepositHandler.reserve.selector;
        selectors[3] = EscrowDirectDepositHandler.release.selector;
        selectors[4] = EscrowDirectDepositHandler.refund.selector;
        selectors[5] = EscrowDirectDepositHandler.withdrawFees.selector;
        selectors[6] = EscrowDirectDepositHandler.strayTransfer.selector;
        targetSelector(FuzzSelector({addr: address(s_handler), selectors: selectors}));
        targetContract(address(s_handler));
    }

    /// @dev Visible with -vv: a run in which an action never fired would pass vacuously.
    function afterInvariant() public view {
        console.log("direct deposits:", s_handler.s_directDeposits());
        console.log("permit2 deposits:", s_handler.s_permit2Deposits());
        console.log("reserves:", s_handler.s_reserves());
        console.log("releases:", s_handler.s_releases());
        console.log("refunds:", s_handler.s_refunds());
        console.log("unreserved refunds:", s_handler.s_unreservedRefunds());
        console.log("fee withdrawals:", s_handler.s_withdrawals());
        console.log("stray transfers:", s_handler.s_strays());
        // A run that never reached an action would pass vacuously; make that a failure instead.
        // Only for a full-depth run: foundry replays a persisted or shrunk failing sequence of a
        // few calls through this hook too, and these asserts would then mask its real reason.
        console.log("handler calls:", s_handler.s_calls());
        if (s_handler.s_calls() < INVARIANT_DEPTH) return;
        // Deposits and reserves are reached by any full-depth run; releases, both refunds and fee
        // withdrawals each need an earlier action first, so a run can legitimately miss them, and
        // asserting on them was observed to fail on a rare seed. Their counts are logged above.
        assertGt(s_handler.s_directDeposits(), 0, "no direct deposit in this run");
        assertGt(s_handler.s_permit2Deposits(), 0, "no permit2 deposit in this run");
        assertGt(s_handler.s_reserves(), 0, "no reserve in this run");
    }

    /// forge-config: default.invariant.runs = 64
    function invariant_balanceEqualsActivePlusFeeRevenuePlusStray() public view {
        assertEq(
            s_token.balanceOf(address(s_escrow)),
            s_handler.activeTotal() + s_escrow.getFeeRevenue(s_token) + s_handler.s_stray(),
            "escrow balance != active deposits + fee revenue + stray transfers"
        );
    }

    /// forge-config: default.invariant.runs = 64
    function invariant_everyTrackedDepositIsStored() public view {
        uint256 count = s_handler.activeCount();
        for (uint256 i; i < count; i++) {
            (bytes32 depositId,,,) = s_handler.s_active(i);
            assertNotEq(s_escrow.getDepositHash(depositId), bytes32(0), "tracked deposit has no stored hash");
        }
    }
}
