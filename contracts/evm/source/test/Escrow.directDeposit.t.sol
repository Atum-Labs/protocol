// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MockToken} from "./mock/MockToken.sol";
import {Escrow} from "../src/Escrow.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {ITokenConfig} from "../src/interfaces/ITokenConfig.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
import {LocalPermit2} from "./helpers/LocalPermit2.sol";
import {TestHelpers} from "./helpers/TestHelpers.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice CORE-3048: the direct deposit entry point. The owner account approves the amount and
///         calls `directDeposit` in the same batch, and the escrow pulls it; the deposit is stored
///         unreserved and `reserve()` sets settler and quote and charges the quote later.
contract EscrowDirectDepositTest is Test, TestHelpers {
    Escrow public s_escrow;
    IERC20 public s_token;
    IPermit2 public s_permit2;

    // The account that owns the tokens and calls directDeposit (a Tempo access key's root account)
    address public owner;
    uint256 public ownerPrivateKey;
    address public reserver;
    uint256 public reserverPrivateKey;
    address public releaser;
    uint256 public releaserPrivateKey;
    address public settler = makeAddr("settler");

    uint256 public constant DEPOSIT_AMOUNT = 1000e18;
    uint256 public constant DEFAULT_NONCE = 1;
    uint256 public s_feeAmount;

    function setUp() public {
        s_permit2 = LocalPermit2.etch();
        MockToken mockToken = new MockToken("Test Token", "TEST");
        s_token = IERC20(address(mockToken));

        s_escrow = new Escrow(s_permit2, address(this));
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), address(this));
        s_escrow.allowToken(s_token, 18);
        s_escrow.setTokenFeeConfig(s_token, 20000, 0, 25000000);
        s_feeAmount = s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig(s_token));

        (owner, ownerPrivateKey) = makeAddrAndKey("owner");
        (reserver, reserverPrivateKey) = makeAddrAndKey("reserver");
        (releaser, releaserPrivateKey) = makeAddrAndKey("releaser");

        deal(address(s_token), owner, DEPOSIT_AMOUNT * 1000);
    }

    function _defaultWitness() internal view returns (IEscrow.DepositWitness memory) {
        return IEscrow.DepositWitness({
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destination: DEFAULT_DESTINATION,
            reserver: reserver,
            releaser: releaser
        });
    }

    /// @dev Builds a complete, valid input for `owner` and returns it with the id it derives to.
    function _directInput(uint256 nonce)
        internal
        view
        returns (IEscrow.DirectDepositInput memory input, bytes32 depositId)
    {
        return _directInputFor(_defaultWitness(), DEPOSIT_AMOUNT, nonce);
    }

    /// @dev Same, for an arbitrary witness and amount.
    function _directInputFor(IEscrow.DepositWitness memory witness, uint256 amount, uint256 nonce)
        internal
        view
        returns (IEscrow.DirectDepositInput memory input, bytes32 depositId)
    {
        return _directInputFor(s_escrow, owner, address(s_token), witness, amount, nonce);
    }

    /// @dev Same, for any escrow instance, depositor and token.
    function _directInputFor(
        Escrow escrow,
        address depositor,
        address token,
        IEscrow.DepositWitness memory witness,
        uint256 amount,
        uint256 nonce
    ) internal view returns (IEscrow.DirectDepositInput memory input, bytes32 depositId) {
        depositId = _directDepositId(address(escrow), depositor, token, nonce, witness, amount);
        input = IEscrow.DirectDepositInput({token: token, amount: amount, nonce: nonce, depositWitness: witness});
    }

    /// @dev The owner's half of the batch: the approval the deposit pulls against.
    function _fund(address from, uint256 amount) internal {
        vm.prank(from);
        s_token.approve(address(s_escrow), amount);
    }

    /// @dev The stored tuple of the default direct deposit: before `reserve()` quoteHash, settler and
    /// feeAmount are zero, after it they are the reserved values and the fee on the source amount.
    function _expectedHash(bytes32 quoteHash, address settlerOrZero) internal view returns (bytes32) {
        return _hashOf(quoteHash, settlerOrZero, DEPOSIT_AMOUNT, settlerOrZero == address(0) ? 0 : s_feeAmount);
    }

    /// @dev The stored tuple of the default direct deposit with the given reserve members and amounts.
    function _hashOf(bytes32 quoteHash, address settlerOrZero, uint256 amount, uint256 feeAmount)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: owner,
                    quoteHash: quoteHash,
                    depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                    destinationHash: DEFAULT_DESTINATION_HASH,
                    token: address(s_token),
                    amount: amount,
                    feeAmount: feeAmount,
                    reserver: reserver,
                    releaser: releaser,
                    settler: settlerOrZero
                })
            )
        );
    }

    function _expectedUnreservedHash() internal view returns (bytes32) {
        return _expectedHash(bytes32(0), address(0));
    }

    function _expectedReservedHash() internal view returns (bytes32) {
        return _expectedHash(DEFAULT_QUOTE_HASH, settler);
    }

    /// @dev A valid reserve input for a deposit `owner` made with `input`: the unreserved tuple
    /// members, the id preimage members, and the reserver's signature over the default quote.
    function _reserveInput(bytes32 depositId, IEscrow.DirectDepositInput memory input)
        internal
        view
        returns (IEscrow.ReserveInput memory)
    {
        return _reserveInputFor(depositId, input, input.amount);
    }

    /// @dev Same, for a quote that charges `sourceAmount`.
    function _reserveInputFor(bytes32 depositId, IEscrow.DirectDepositInput memory input, uint256 sourceAmount)
        internal
        view
        returns (IEscrow.ReserveInput memory)
    {
        IEscrow.ReserveWitness memory reserveWitness =
            _constructReserveWitness(depositId, DEFAULT_QUOTE_HASH, settler, sourceAmount);
        return IEscrow.ReserveInput({
            depositor: owner,
            token: input.token,
            amount: input.amount,
            depositWitness: input.depositWitness,
            reserveWitness: reserveWitness,
            reserveSignature: _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey)
        });
    }

    /// @dev A funded, unreserved direct deposit by `owner` with the default fixture values.
    function _unreservedDeposit() internal returns (IEscrow.DirectDepositInput memory input, bytes32 depositId) {
        (input, depositId) = _directInput(DEFAULT_NONCE);
        _fund(owner, DEPOSIT_AMOUNT);
        vm.prank(owner);
        s_escrow.directDeposit(input);
    }

    // reserve() with a valid reserver signature rewrites the stored hash with settler and
    // quote and emits DepositReserved. Anyone may submit it: the signature is the gate.
    function test_reserve_happyPath() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        IEscrow.ReserveInput memory reserveInput = _reserveInput(depositId, input);

        vm.expectEmit(true, true, true, true, address(s_escrow));
        emit IEscrow.DepositReserved(depositId, DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT, s_feeAmount);

        vm.prank(settler);
        s_escrow.reserve(reserveInput);
        vm.snapshotGasLastCall("reserve_success");

        assertEq(s_escrow.getDepositHash(depositId), _expectedReservedHash(), "stored hash is the reserved tuple");
    }

    // A second reserve fails the tuple check: the stored hash is now the reserved one.
    function test_reserve_twiceReverts() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        IEscrow.ReserveInput memory reserveInput = _reserveInput(depositId, input);
        s_escrow.reserve(reserveInput);

        bytes32 unreservedHash = _expectedUnreservedHash();
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrow.InvalidWitnessValues.selector, depositId, _expectedReservedHash(), unreservedHash
            )
        );
        s_escrow.reserve(reserveInput);
    }

    function test_reserve_signatureOverOtherIdReverts() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        IEscrow.ReserveInput memory reserveInput = _reserveInput(depositId, input);
        IEscrow.ReserveWitness memory other =
            _constructReserveWitness(keccak256("some other id"), DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT);
        reserveInput.reserveSignature = _constructReserveSignature(s_escrow, other, reserverPrivateKey);

        vm.expectRevert(IEscrow.InvalidSignature.selector);
        s_escrow.reserve(reserveInput);
    }

    function test_reserve_otherWitnessRevertsOnTupleMismatch() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        IEscrow.ReserveInput memory reserveInput = _reserveInput(depositId, input);
        reserveInput.depositWitness.destination = "eip155:1/erc20:0xcccc@0xdddd";

        vm.expectPartialRevert(IEscrow.InvalidWitnessValues.selector);
        s_escrow.reserve(reserveInput);
    }

    // An id the escrow never stored, or no longer stores, is refused before any tuple work.
    function test_reserve_unknownIdReverts() public {
        (IEscrow.DirectDepositInput memory input,) = _unreservedDeposit();
        bytes32 unknownId = keccak256("never deposited");
        IEscrow.ReserveInput memory reserveInput = _reserveInput(unknownId, input);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, unknownId));
        s_escrow.reserve(reserveInput);
    }

    function test_reserve_zeroQuoteHashReverts() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        IEscrow.ReserveInput memory reserveInput = _reserveInput(depositId, input);
        reserveInput.reserveWitness.quoteHash = bytes32(0);
        reserveInput.reserveSignature =
            _constructReserveSignature(s_escrow, reserveInput.reserveWitness, reserverPrivateKey);

        vm.expectRevert(IEscrow.QuoteHashCannotBeEmpty.selector);
        s_escrow.reserve(reserveInput);
    }

    // The deposit is the payer's maximum: the winning quote charges less, and `reserve()` sends the
    // difference back to the depositor, stores the charged amount and books the fee on it.
    function test_reserve_belowDepositAmountRefundsOverpayment() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        uint256 sourceAmount = DEPOSIT_AMOUNT / 2;
        uint256 feeAmount = s_escrow.determineFee(sourceAmount, s_escrow.getTokenConfig(s_token));
        IEscrow.ReserveInput memory reserveInput = _reserveInputFor(depositId, input, sourceAmount);
        uint256 ownerBefore = s_token.balanceOf(owner);

        vm.expectEmit(true, true, true, true, address(s_escrow));
        emit IEscrow.DepositReserved(depositId, DEFAULT_QUOTE_HASH, settler, sourceAmount, feeAmount);
        s_escrow.reserve(reserveInput);
        vm.snapshotGasLastCall("reserve_partial_success");

        assertEq(s_token.balanceOf(owner), ownerBefore + DEPOSIT_AMOUNT - sourceAmount, "overpayment refunded");
        assertEq(s_token.balanceOf(address(s_escrow)), sourceAmount, "escrow keeps the charged amount");
        assertEq(
            s_escrow.getDepositHash(depositId),
            _hashOf(DEFAULT_QUOTE_HASH, settler, sourceAmount, feeAmount),
            "stored tuple carries the charged amount and its fee"
        );
    }

    // A quote is priced using the fee terms fixed when its source funds entered escrow.
    function _assertDepositFeeConfigLocked(uint88 percentage, uint80 minFee, uint80 maxFee) internal {
        uint256 sourceAmount = DEPOSIT_AMOUNT / 2;
        uint256 lockedFee = s_escrow.determineFee(sourceAmount, s_escrow.getTokenConfig(s_token));
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        s_escrow.setTokenFeeConfig(s_token, percentage, minFee, maxFee);
        uint256 changedFee = s_escrow.determineFee(sourceAmount, s_escrow.getTokenConfig(s_token));
        assertNotEq(changedFee, lockedFee, "control: the updated config must change the fee");

        vm.expectEmit(true, true, true, true, address(s_escrow));
        emit IEscrow.DepositReserved(depositId, DEFAULT_QUOTE_HASH, settler, sourceAmount, lockedFee);
        s_escrow.reserve(_reserveInputFor(depositId, input, sourceAmount));
        assertEq(s_escrow.getDepositHash(depositId), _hashOf(DEFAULT_QUOTE_HASH, settler, sourceAmount, lockedFee));
        assertEq(s_token.balanceOf(address(s_escrow)), sourceAmount, "surplus returned using the all-in charge");
    }

    function test_reserve_locksDepositPercentage() public {
        _assertDepositFeeConfigLocked(50000, 0, 0);
    }

    function test_reserve_locksDepositMinimum() public {
        _assertDepositFeeConfigLocked(20000, 10_000_000, 0);
    }

    function test_reserve_locksDepositMaximum() public {
        _assertDepositFeeConfigLocked(20000, 0, 50_000);
    }

    function test_reserve_newDepositUsesUpdatedFeeConfig() public {
        (IEscrow.DirectDepositInput memory first, bytes32 firstId) = _unreservedDeposit();
        s_escrow.setTokenFeeConfig(s_token, 1_000_000, 0, 0);
        (IEscrow.DirectDepositInput memory second,) = _directInput(DEFAULT_NONCE + 1);
        uint256 newFee = s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig(s_token));
        _fund(owner, DEPOSIT_AMOUNT);
        vm.prank(owner);
        bytes32 secondId = s_escrow.directDeposit(second);
        s_escrow.reserve(_reserveInput(firstId, first));
        s_escrow.reserve(_reserveInput(secondId, second));
        assertEq(s_escrow.getDepositHash(firstId), _hashOf(DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT, s_feeAmount));
        assertEq(s_escrow.getDepositHash(secondId), _hashOf(DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT, newFee));
    }

    function _assertSnapshot(bytes32 depositId, ITokenConfig.TokenConfig memory expected) internal view {
        assertEq(abi.encode(s_escrow.getDirectDepositFeeConfig(depositId)), abi.encode(expected));
    }

    function _assertSnapshotCleared(bytes32 depositId) internal view {
        ITokenConfig.TokenConfig memory empty;
        _assertSnapshot(depositId, empty);
    }

    function test_directDeposit_feeSnapshotVisibleAndClearedOnReserve() public {
        ITokenConfig.TokenConfig memory expected = s_escrow.getTokenConfig(s_token);
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        _assertSnapshot(depositId, expected);
        s_escrow.clearTokenFeeConfig(s_token);
        _assertSnapshot(depositId, expected);
        s_escrow.reserve(_reserveInput(depositId, input));
        assertEq(s_escrow.getDepositHash(depositId), _expectedReservedHash());
        _assertSnapshotCleared(depositId);
    }

    function test_reserve_reallowDoesNotReplaceDepositFeeConfig() public {
        (IEscrow.DirectDepositInput memory input, bytes32 id) = _unreservedDeposit();
        s_escrow.disallowToken(s_token);
        s_escrow.allowToken(s_token, 18);
        s_escrow.setTokenFeeConfig(s_token, 50000, 0, 0);
        s_escrow.reserve(_reserveInput(id, input));
        assertEq(s_escrow.getDepositHash(id), _expectedReservedHash());
        _assertSnapshotCleared(id);
    }

    function test_directDeposit_zeroFeeSnapshotIsNotMissing() public {
        s_escrow.clearTokenFeeConfig(s_token);
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        s_escrow.setTokenFeeConfig(s_token, 1_000_000, 0, 0);
        s_escrow.reserve(_reserveInput(depositId, input));
        assertEq(s_escrow.getDepositHash(depositId), _hashOf(DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT, 0));
        _assertSnapshotCleared(depositId);
    }

    function test_refundUnreserved_clearsFeeSnapshot() public {
        (, bytes32 depositId) = _unreservedDeposit();
        vm.prank(owner);
        s_escrow.refundUnreserved(_refundUnreservedInput(depositId));
        _assertSnapshotCleared(depositId);
        _assertSnapshotCleared(keccak256("unknown deposit"));
    }

    // ---- EscrowReserveLib missing: deploy.sh and the deploy README claim these, so they are pinned here ----

    /// @dev Empties the library the escrow was linked to. The library's address is not derived: where
    /// forge deploys a linked library depends on its version and on `always_use_create_2_factory`
    /// (CI's forge and a newer local one disagreed). It is read from the escrow's own runtime code
    /// instead, where the linker embedded it as a PUSH20.
    function _etchLibraryEmpty() internal {
        address lib = _linkedLibrary(address(s_escrow).code);
        assertGt(lib.code.length, 0, "the library the escrow embeds has no code");
        vm.etch(lib, "");
        assertEq(lib.code.length, 0, "the library was not emptied");
    }

    /// @dev The one distinct address embedded as `PUSH20 <address>` in `escrowCode` whose code is the reserve
    /// library's. Matched by code length against the compiled runtime (the library's own address is
    /// an immutable, so the bytes differ but the length cannot), which tells it apart from the
    /// escrow's other embedded addresses such as Permit2.
    function _linkedLibrary(bytes memory escrowCode) internal view returns (address lib) {
        uint256 libraryLength = vm.getDeployedCode("EscrowReserveLib.sol:EscrowReserveLib").length;
        for (uint256 i = 0; i + 21 <= escrowCode.length; i++) {
            if (escrowCode[i] != 0x73) continue;
            address candidate;
            assembly {
                candidate := shr(96, mload(add(add(escrowCode, 0x21), i)))
            }
            if (candidate.code.length != libraryLength) continue;
            // The escrow embeds the library address at more than one call site; two different ones is a bug.
            assertTrue(lib == address(0) || lib == candidate, "the escrow embeds more than one library");
            lib = candidate;
        }
        assertTrue(lib != address(0), "the escrow does not embed a linked library address");
    }

    function test_missingLibrary_directDepositStillWorks() public {
        _etchLibraryEmpty();
        (, bytes32 depositId) = _unreservedDeposit();
        assertEq(s_escrow.getDepositHash(depositId), _expectedUnreservedHash(), "the deposit is stored unreserved");
    }

    function test_missingLibrary_reserveAndRefundUnreservedRevertWithEmptyData() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        IEscrow.ReserveInput memory reserveInput = _reserveInput(depositId, input);
        _etchLibraryEmpty();

        vm.expectRevert(bytes(""));
        s_escrow.reserve(reserveInput);

        vm.prank(owner);
        vm.expectRevert(bytes(""));
        s_escrow.refundUnreserved(_refundUnreservedInput(depositId));

        assertEq(
            s_escrow.getDepositHash(depositId),
            _expectedUnreservedHash(),
            "nothing moved: the deposit is still unreserved"
        );
    }

    function _useCallbackToken() internal returns (FeeSnapshotCallbackToken token) {
        token = new FeeSnapshotCallbackToken();
        s_token = IERC20(address(token));
        s_escrow.allowToken(s_token, 18);
        s_escrow.setTokenFeeConfig(s_token, 20000, 0, 25000000);
        // The token itself owns the deposit, so its nested refund call has the correct caller.
        owner = address(token);
        deal(address(token), owner, DEPOSIT_AMOUNT * 1000);
    }

    function test_refundUnreserved_callbackCannotRefundTwiceAndSnapshotClearedFirst() public {
        FeeSnapshotCallbackToken token = _useCallbackToken();
        (, bytes32 id) = _unreservedDeposit();
        token.configure(s_escrow, id, abi.encodeCall(s_escrow.refundUnreserved, (_refundUnreservedInput(id))), false);
        vm.prank(owner);
        s_escrow.refundUnreserved(_refundUnreservedInput(id));
        assertTrue(token.attempted());
        assertFalse(token.reentrySucceeded());
        assertEq(bytes4(token.reentryResult()), IEscrow.DepositNotFound.selector);
        assertTrue(token.snapshotCleared());
        assertEq(s_escrow.getDepositHash(id), bytes32(0));
        assertEq(token.balanceOf(address(s_escrow)), 0);
    }

    function test_refundUnreserved_failedTransferRestoresHashAndSnapshot() public {
        FeeSnapshotCallbackToken token = _useCallbackToken();
        (, bytes32 id) = _unreservedDeposit();
        bytes32 originalHash = s_escrow.getDepositHash(id);
        ITokenConfig.TokenConfig memory config = s_escrow.getDirectDepositFeeConfig(id);
        token.configure(s_escrow, id, "", true);
        vm.expectRevert(bytes("outbound blocked"));
        vm.prank(owner);
        s_escrow.refundUnreserved(_refundUnreservedInput(id));
        assertEq(s_escrow.getDepositHash(id), originalHash);
        _assertSnapshot(id, config);
        assertEq(token.balanceOf(address(s_escrow)), DEPOSIT_AMOUNT);
        token.configure(s_escrow, id, "", false);
        vm.prank(owner);
        s_escrow.refundUnreserved(_refundUnreservedInput(id));
        _assertSnapshotCleared(id);
    }

    function test_reserve_failedSurplusTransferRestoresSnapshot() public {
        FeeSnapshotCallbackToken token = _useCallbackToken();
        (IEscrow.DirectDepositInput memory input, bytes32 id) = _unreservedDeposit();
        bytes32 originalHash = s_escrow.getDepositHash(id);
        ITokenConfig.TokenConfig memory config = s_escrow.getDirectDepositFeeConfig(id);
        s_escrow.setTokenFeeConfig(s_token, 50000, 0, 0);
        token.configure(s_escrow, id, "", true);
        IEscrow.ReserveInput memory reservation = _reserveInputFor(id, input, DEPOSIT_AMOUNT / 2);
        vm.expectRevert(bytes("outbound blocked"));
        s_escrow.reserve(reservation);
        assertEq(s_escrow.getDepositHash(id), originalHash);
        _assertSnapshot(id, config);
        token.configure(s_escrow, id, abi.encodeCall(s_escrow.reserve, (reservation)), false);
        s_escrow.reserve(reservation);
        assertTrue(token.attempted());
        assertFalse(token.reentrySucceeded());
        assertEq(bytes4(token.reentryResult()), IEscrow.InvalidWitnessValues.selector);
        assertTrue(token.snapshotCleared());
        uint256 lockedFee = s_escrow.determineFee(DEPOSIT_AMOUNT / 2, config);
        assertEq(s_escrow.getDepositHash(id), _hashOf(DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT / 2, lockedFee));
    }

    // CORE-3251: the `directDeposit` pull hands the token control inside `transferFrom`, after the
    // fee snapshot and the unreserved hash are written. These tests pin that order. The exact-delta
    // check fixes the outer call's net inflow at `amount`, so a nested payout reverts the call unless
    // an inflow the nested calls make themselves offsets it.
    //
    // This first one makes no nested call, so it keeps guarding the order even if a reentrancy guard
    // later refuses the nested calls below: while the token holds control, the deposit hash and the
    // fee snapshot are already stored. It also pins the two phases of the hook.
    function test_directDeposit_pullCallbackSeesTheDepositAlreadyStored() public {
        FeeSnapshotCallbackToken token = _useCallbackToken();
        _fund(owner, 2 * DEPOSIT_AMOUNT);

        (IEscrow.DirectDepositInput memory first, bytes32 firstId) = _directInput(DEFAULT_NONCE);
        token.configurePull(s_escrow, firstId, "", FeeSnapshotCallbackToken.PullPhase.BeforeFundsLand);
        vm.prank(owner);
        s_escrow.directDeposit(first);
        assertTrue(token.pullAttempted());
        assertEq(token.pullEscrowBalance(), 0);
        assertEq(token.pullObservedHash(), _expectedUnreservedHash());
        assertEq(token.pullObservedFeeDecimals(), 18);

        (IEscrow.DirectDepositInput memory second, bytes32 secondId) = _directInput(DEFAULT_NONCE + 1);
        token.configurePull(s_escrow, secondId, "", FeeSnapshotCallbackToken.PullPhase.AfterFundsLand);
        vm.prank(owner);
        s_escrow.directDeposit(second);
        assertTrue(token.pullAttempted());
        assertEq(token.pullEscrowBalance(), 2 * DEPOSIT_AMOUNT);
        // The stored tuple has no nonce, so the second deposit stores the same unreserved hash
        assertEq(token.pullObservedHash(), _expectedUnreservedHash());
        assertEq(token.pullObservedFeeDecimals(), 18);
    }

    /// @dev Runs the default deposit with the pull hook armed with a nested full-amount `reserve()`
    ///      and asserts the deposit ends reserved with the fee from its deposit-time snapshot, the
    ///      snapshot cleared, and exactly `amount` moved from the depositor to the escrow.
    function _assertReserveInPullIsConsistent(FeeSnapshotCallbackToken.PullPhase phase) internal {
        FeeSnapshotCallbackToken token = _useCallbackToken();
        (IEscrow.DirectDepositInput memory input, bytes32 id) = _directInput(DEFAULT_NONCE);
        // A non-zero fee, so a reserve that read an empty snapshot would store a different hash
        assertGt(s_feeAmount, 0);
        token.configurePull(
            s_escrow, id, abi.encodeCall(s_escrow.reserve, (_reserveInputFor(id, input, DEPOSIT_AMOUNT))), phase
        );
        _fund(owner, DEPOSIT_AMOUNT);
        uint256 ownerBefore = token.balanceOf(owner);
        vm.prank(owner);
        s_escrow.directDeposit(input);

        assertTrue(token.pullReentrySucceeded());
        assertEq(s_escrow.getDepositHash(id), _expectedReservedHash());
        _assertSnapshotCleared(id);
        assertEq(token.balanceOf(address(s_escrow)), DEPOSIT_AMOUNT);
        assertEq(ownerBefore - token.balanceOf(owner), DEPOSIT_AMOUNT);
    }

    // A full-amount `reserve()` from the hook before the funds land refunds nothing, so the pull
    // still delivers exactly `amount` and the deposit ends reserved and funded. Under a reorder the
    // nested reserve finds no deposit (pull above the store) or locks a zero fee from an empty
    // snapshot (pull above the snapshot write only), and this goes red. It pins storage and
    // balances only: the nested reserve logs `DepositReserved` before `directDeposit` logs
    // `Deposited`, because the deposit logs follow the pull.
    function test_directDeposit_reserveInPullCallbackBeforeFundsLandIsConsistent() public {
        _assertReserveInPullIsConsistent(FeeSnapshotCallbackToken.PullPhase.BeforeFundsLand);
    }

    // The same reserve after the funds land: a second nested-call guard on the snapshot ordering.
    function test_directDeposit_reserveInPullCallbackAfterFundsLandIsConsistent() public {
        _assertReserveInPullIsConsistent(FeeSnapshotCallbackToken.PullPhase.AfterFundsLand);
    }

    // A refund from the hook after the funds land takes them straight back out, so the escrow
    // ends where it started and the delta check reverts the whole call.
    function test_directDeposit_refundInPullCallbackAfterFundsLandReverts() public {
        FeeSnapshotCallbackToken token = _useCallbackToken();
        (IEscrow.DirectDepositInput memory input, bytes32 id) = _directInput(DEFAULT_NONCE);
        token.configurePull(
            s_escrow,
            id,
            abi.encodeCall(s_escrow.refundUnreserved, (_refundUnreservedInput(id))),
            FeeSnapshotCallbackToken.PullPhase.AfterFundsLand
        );
        _fund(owner, DEPOSIT_AMOUNT);
        uint256 ownerBefore = token.balanceOf(owner);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.NonExactTransfer.selector, DEPOSIT_AMOUNT, 0));
        vm.prank(owner);
        s_escrow.directDeposit(input);

        assertEq(token.balanceOf(owner), ownerBefore);
        assertEq(token.balanceOf(address(s_escrow)), 0);
        assertEq(s_escrow.getDepositHash(id), bytes32(0));
    }

    /// @dev Another depositor's unreserved deposit of the callback token, made before the pull hook
    ///      is armed, so the escrow holds funds a nested payout could take.
    function _poolDeposit(FeeSnapshotCallbackToken token) internal returns (bytes32 poolId) {
        address other = makeAddr("other depositor");
        deal(address(token), other, DEPOSIT_AMOUNT);
        IEscrow.DirectDepositInput memory input;
        (input, poolId) =
            _directInputFor(s_escrow, other, address(token), _defaultWitness(), DEPOSIT_AMOUNT, DEFAULT_NONCE);
        _fund(other, DEPOSIT_AMOUNT);
        vm.prank(other);
        s_escrow.directDeposit(input);
    }

    /// @dev With another depositor's funds in the escrow, arms the pull hook before the funds land
    ///      with a nested payout of the new deposit and asserts the delta check reverts the whole
    ///      call, `received` being what landed net. The pool, the new id and the nonce all roll back.
    function _assertPooledPullCallbackReverts(
        FeeSnapshotCallbackToken token,
        IEscrow.DirectDepositInput memory input,
        bytes32 id,
        bytes memory callback,
        uint256 received
    ) internal {
        bytes32 poolId = _poolDeposit(token);
        bytes32 poolHash = s_escrow.getDepositHash(poolId);
        token.configurePull(s_escrow, id, callback, FeeSnapshotCallbackToken.PullPhase.BeforeFundsLand);
        _fund(owner, DEPOSIT_AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.NonExactTransfer.selector, DEPOSIT_AMOUNT, received));
        vm.prank(owner);
        s_escrow.directDeposit(input);

        assertEq(token.balanceOf(address(s_escrow)), DEPOSIT_AMOUNT);
        assertEq(s_escrow.getDepositHash(poolId), poolHash);
        assertEq(s_escrow.getDepositHash(id), bytes32(0));
        // The nonce was not consumed: the same deposit goes through once the hook makes no call
        token.configurePull(s_escrow, id, "", FeeSnapshotCallbackToken.PullPhase.BeforeFundsLand);
        vm.prank(owner);
        s_escrow.directDeposit(input);
        assertEq(s_escrow.getDepositHash(id), _expectedUnreservedHash());
    }

    // A refund from the hook before the funds land finds the deposit stored and pays it out of
    // the other depositor's funds; the pull then lands nothing net, and the delta check reverts.
    function test_directDeposit_refundInPullCallbackBeforeFundsLandReverts() public {
        FeeSnapshotCallbackToken token = _useCallbackToken();
        (IEscrow.DirectDepositInput memory input, bytes32 id) = _directInput(DEFAULT_NONCE);
        _assertPooledPullCallbackReverts(
            token, input, id, abi.encodeCall(s_escrow.refundUnreserved, (_refundUnreservedInput(id))), 0
        );
    }

    // A partial `reserve()` from the hook before the funds land refunds the overpayment out of
    // the other depositor's funds; the pull then lands only the charged half net, and the delta
    // check reverts.
    function test_directDeposit_partialReserveInPullCallbackBeforeFundsLandReverts() public {
        FeeSnapshotCallbackToken token = _useCallbackToken();
        (IEscrow.DirectDepositInput memory input, bytes32 id) = _directInput(DEFAULT_NONCE);
        _assertPooledPullCallbackReverts(
            token,
            input,
            id,
            abi.encodeCall(s_escrow.reserve, (_reserveInputFor(id, input, DEPOSIT_AMOUNT / 2))),
            DEPOSIT_AMOUNT / 2
        );
    }

    /// @dev Arms the pull hook with `callback` before the funds land, with nothing else in the
    ///      escrow, and asserts the nested payout itself failed on the escrow's empty balance while
    ///      the deposit went through: stored unreserved, snapshot kept, funded in full.
    function _assertEmptyEscrowPullCallbackCannotPayOut(
        FeeSnapshotCallbackToken token,
        IEscrow.DirectDepositInput memory input,
        bytes32 id,
        bytes memory callback,
        uint256 payout
    ) internal {
        ITokenConfig.TokenConfig memory config = s_escrow.getTokenConfig(s_token);
        token.configurePull(s_escrow, id, callback, FeeSnapshotCallbackToken.PullPhase.BeforeFundsLand);
        _fund(owner, DEPOSIT_AMOUNT);
        vm.prank(owner);
        s_escrow.directDeposit(input);

        assertTrue(token.pullAttempted());
        assertFalse(token.pullReentrySucceeded());
        assertEq(
            token.pullReentryResult(),
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, address(s_escrow), uint256(0), payout
            )
        );
        assertEq(s_escrow.getDepositHash(id), _expectedUnreservedHash());
        _assertSnapshot(id, config);
        assertEq(token.balanceOf(address(s_escrow)), DEPOSIT_AMOUNT);
    }

    // With nothing else in the escrow, a refund from the hook before the funds land has nothing
    // to pay out of: the nested call fails and the deposit completes unreserved.
    function test_directDeposit_refundInPullCallbackFromEmptyEscrowFails() public {
        FeeSnapshotCallbackToken token = _useCallbackToken();
        (IEscrow.DirectDepositInput memory input, bytes32 id) = _directInput(DEFAULT_NONCE);
        _assertEmptyEscrowPullCallbackCannotPayOut(
            token, input, id, abi.encodeCall(s_escrow.refundUnreserved, (_refundUnreservedInput(id))), DEPOSIT_AMOUNT
        );
    }

    // Same for a partial `reserve()`: its overpayment refund fails, so the reserve rolls back.
    function test_directDeposit_partialReserveInPullCallbackFromEmptyEscrowFails() public {
        FeeSnapshotCallbackToken token = _useCallbackToken();
        (IEscrow.DirectDepositInput memory input, bytes32 id) = _directInput(DEFAULT_NONCE);
        _assertEmptyEscrowPullCallbackCannotPayOut(
            token,
            input,
            id,
            abi.encodeCall(s_escrow.reserve, (_reserveInputFor(id, input, DEPOSIT_AMOUNT / 2))),
            DEPOSIT_AMOUNT / 2
        );
    }

    // A charge at or below the token's fee floor is refused at reserve, as `deposit()` refuses it;
    // the deposit stays unreserved and refundable.
    function test_reserve_chargeAtOrBelowTheFeeFloorReverts() public {
        // The fee floor is part of the deposit-time terms, not a later admin change.
        s_escrow.setTokenFeeConfig(s_token, 20000, 1_000_000, 25000000);
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        uint256 sourceAmount = 1e18;

        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, sourceAmount, 1e18));
        s_escrow.reserve(_reserveInputFor(depositId, input, sourceAmount));
        assertEq(s_escrow.getDepositHash(depositId), _expectedUnreservedHash(), "still unreserved");
    }

    // A quote cannot charge more than the deposit holds, nor nothing.
    function test_reserve_sourceAmountAboveDepositAmountReverts() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        IEscrow.ReserveInput memory reserveInput = _reserveInputFor(depositId, input, DEPOSIT_AMOUNT + 1);

        vm.expectRevert(IEscrow.InvalidSourceAmount.selector);
        s_escrow.reserve(reserveInput);
    }

    function test_reserve_zeroSourceAmountReverts() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        IEscrow.ReserveInput memory reserveInput = _reserveInputFor(depositId, input, 0);

        vm.expectRevert(IEscrow.InvalidSourceAmount.selector);
        s_escrow.reserve(reserveInput);
    }

    // A token must still be allowlisted to admit a new reservation, independently of its locked fees;
    // the deposit stays refundable.
    function test_reserve_tokenDisallowedSinceDepositReverts() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        s_escrow.disallowToken(s_token);

        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenNotAllowed.selector, s_token));
        s_escrow.reserve(_reserveInput(depositId, input));
    }

    function test_reserve_zeroSettlerReverts() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        IEscrow.ReserveInput memory reserveInput = _reserveInput(depositId, input);
        reserveInput.reserveWitness.settler = address(0);
        reserveInput.reserveSignature =
            _constructReserveSignature(s_escrow, reserveInput.reserveWitness, reserverPrivateKey);

        vm.expectRevert(IEscrow.SettlerCannotBeZeroAddress.selector);
        s_escrow.reserve(reserveInput);
    }

    function test_reserve_revertsWhenPaused() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        IEscrow.ReserveInput memory reserveInput = _reserveInput(depositId, input);
        s_escrow.grantRole(s_escrow.PAUSER_ROLE(), address(this));
        s_escrow.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        s_escrow.reserve(reserveInput);
    }

    // Release after reserve works unchanged, clears the slot.
    //
    // The TestHelpers release/refund helpers also write `release_success` and `refund_success` into
    // this suite's snapshot file. `release_success` here measures a first payout to a settler that
    // starts with no tokens (a zero-to-nonzero balance write), so it is not comparable with the
    // same-named key in EscrowDepositTest.json; `refund_success` matches it.
    function test_release_afterReserveClearsSlot() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        s_escrow.reserve(_reserveInput(depositId, input));

        releaseDeposit(
            s_escrow,
            depositId,
            owner,
            address(s_token),
            DEPOSIT_AMOUNT,
            s_feeAmount,
            reserver,
            releaser,
            settler,
            releaserPrivateKey
        );

        assertEq(s_escrow.getDepositHash(depositId), bytes32(0), "slot cleared");
        assertEq(s_token.balanceOf(settler), DEPOSIT_AMOUNT - s_feeAmount, "settler paid");
        assertEq(s_escrow.getFeeRevenue(s_token), s_feeAmount, "fee booked");
    }

    // After a reserve below the deposit, release pays the settler the charged amount less its fee.
    function test_release_afterPartialReservePaysTheChargedAmount() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        uint256 sourceAmount = DEPOSIT_AMOUNT / 2;
        uint256 feeAmount = s_escrow.determineFee(sourceAmount, s_escrow.getTokenConfig(s_token));
        s_escrow.reserve(_reserveInputFor(depositId, input, sourceAmount));

        releaseDeposit(
            s_escrow,
            depositId,
            owner,
            address(s_token),
            sourceAmount,
            feeAmount,
            reserver,
            releaser,
            settler,
            releaserPrivateKey
        );

        assertEq(s_token.balanceOf(settler), sourceAmount - feeAmount, "settler paid the charge less fee");
        assertEq(s_escrow.getFeeRevenue(s_token), feeAmount, "fee booked on the charge");
        assertEq(s_token.balanceOf(address(s_escrow)), feeAmount, "escrow holds only the fee");
    }

    // An unreserved deposit cannot be released. The faithful witness, as a log-only consumer
    // rebuilds it, carries zeros for both quoteHash and settler, and the error must name the
    // actual condition (no settler) rather than the quote.
    function test_release_unreservedReverts() public {
        (, bytes32 depositId) = _unreservedDeposit();
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: bytes32(0),
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: owner,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: 0,
            reserver: reserver,
            releaser: releaser,
            settler: address(0)
        });

        vm.expectRevert(abi.encodeWithSelector(IEscrow.NotReserved.selector, depositId));
        s_escrow.release(
            IEscrow.ReleaseInput({
                releaseWitness: witness,
                releaseSignature: _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey)
            })
        );
    }

    /// @dev The refund witness of an unreserved deposit: zeros where the reserve would have written.
    function _unreservedRefundWitness(bytes32 depositId) internal view returns (IEscrow.RefundWitness memory) {
        return IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: bytes32(0),
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: owner,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: 0,
            reserver: reserver,
            releaser: releaser,
            settler: address(0)
        });
    }

    // The releaser cannot refund an unreserved deposit: a witness with a zero quoteHash reverts
    // before the stored-hash check. Only the depositor refunds it, with `refundUnreserved`.
    function test_refund_unreservedByReleaserReverts() public {
        (, bytes32 depositId) = _unreservedDeposit();
        IEscrow.RefundWitness memory witness = _unreservedRefundWitness(depositId);
        IEscrow.RefundInput memory refundInput = IEscrow.RefundInput({
            refundWitness: witness,
            refundSignature: _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey)
        });

        vm.expectRevert(IEscrow.QuoteHashCannotBeEmpty.selector);
        s_escrow.refund(refundInput);
    }

    /// @dev The depositor's refund input for an unreserved default deposit: the stored tuple members
    /// that are not zero before `reserve()`, all recoverable from the deposit's logs.
    function _refundUnreservedInput(bytes32 depositId) internal view returns (IEscrow.RefundUnreservedInput memory) {
        return IEscrow.RefundUnreservedInput({
            depositId: depositId,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            reserver: reserver,
            releaser: releaser
        });
    }

    // The depositor refunds an unreserved deposit alone, with no signature: the full amount comes
    // back, the slot is cleared and `Refunded` is emitted as on the releaser path.
    function test_refundUnreserved_byDepositorRefundsInFull() public {
        (, bytes32 depositId) = _unreservedDeposit();
        uint256 ownerBefore = s_token.balanceOf(owner);

        vm.expectEmit(true, true, true, true, address(s_escrow));
        emit IEscrow.Refunded(depositId, owner, address(s_token), DEPOSIT_AMOUNT);

        vm.prank(owner);
        s_escrow.refundUnreserved(_refundUnreservedInput(depositId));
        vm.snapshotGasLastCall("refund_unreserved_success");

        assertEq(s_escrow.getDepositHash(depositId), bytes32(0), "slot cleared");
        assertEq(s_token.balanceOf(owner), ownerBefore + DEPOSIT_AMOUNT, "owner made whole");
        assertEq(s_token.balanceOf(address(s_escrow)), 0, "escrow empty");
    }

    // Once reserved, the depositor can no longer refund alone: the tuple it rebuilds has zero
    // quoteHash and settler, and the stored one does not. The settler's commitment is safe.
    function test_refundUnreserved_afterReserveReverts() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        s_escrow.reserve(_reserveInput(depositId, input));

        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrow.InvalidWitnessValues.selector, depositId, _expectedReservedHash(), _expectedUnreservedHash()
            )
        );
        vm.prank(owner);
        s_escrow.refundUnreserved(_refundUnreservedInput(depositId));
    }

    // Same after a partial charge, with the charged amount the depositor can read from
    // `DepositReserved`: the zero quoteHash, settler and fee still cannot match.
    function test_refundUnreserved_afterPartialReserveWithChargedAmountReverts() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        uint256 sourceAmount = DEPOSIT_AMOUNT / 2;
        s_escrow.reserve(_reserveInputFor(depositId, input, sourceAmount));

        IEscrow.RefundUnreservedInput memory refundInput = _refundUnreservedInput(depositId);
        refundInput.amount = sourceAmount;
        vm.expectPartialRevert(IEscrow.InvalidWitnessValues.selector);
        vm.prank(owner);
        s_escrow.refundUnreserved(refundInput);
    }

    // Not permissionless: any caller other than the depositor rebuilds a tuple with itself as
    // depositor, which does not match. The releaser and reserver included.
    function testFuzz_refundUnreserved_byAnotherCallerReverts(address caller) public {
        vm.assume(caller != owner);
        (, bytes32 depositId) = _unreservedDeposit();

        vm.expectPartialRevert(IEscrow.InvalidWitnessValues.selector);
        vm.prank(caller);
        s_escrow.refundUnreserved(_refundUnreservedInput(depositId));
    }

    // A pause blocks the depositor refund too, like every transition.
    function test_refundUnreserved_revertsWhenPaused() public {
        (, bytes32 depositId) = _unreservedDeposit();
        s_escrow.grantRole(s_escrow.PAUSER_ROLE(), address(this));
        s_escrow.pause();

        vm.prank(owner);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        s_escrow.refundUnreserved(_refundUnreservedInput(depositId));
    }

    // The race with `reserve()`: a refund that lands first clears the slot, and the reserve then
    // finds no deposit.
    function test_reserve_afterRefundUnreservedReverts() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        vm.prank(owner);
        s_escrow.refundUnreserved(_refundUnreservedInput(depositId));

        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, depositId));
        s_escrow.reserve(_reserveInput(depositId, input));
    }

    // A second refund finds the slot cleared.
    function test_refundUnreserved_twiceReverts() public {
        (, bytes32 depositId) = _unreservedDeposit();
        vm.startPrank(owner);
        s_escrow.refundUnreserved(_refundUnreservedInput(depositId));

        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, depositId));
        s_escrow.refundUnreserved(_refundUnreservedInput(depositId));
        vm.stopPrank();
    }

    // An unreserved deposit stays refundable by its depositor after its token is disallowed, though
    // it can no longer be reserved (test_reserve_tokenDisallowedSinceDepositReverts).
    function test_refundUnreserved_afterTokenDisallowedRefunds() public {
        (, bytes32 depositId) = _unreservedDeposit();
        s_escrow.disallowToken(s_token);
        uint256 ownerBefore = s_token.balanceOf(owner);

        vm.prank(owner);
        s_escrow.refundUnreserved(_refundUnreservedInput(depositId));

        assertEq(s_token.balanceOf(owner), ownerBefore + DEPOSIT_AMOUNT, "owner made whole");
    }

    // A deposit reserved below its maximum and then refunded makes the depositor whole across the
    // two transfers: the overpayment at reserve, the charged amount at refund.
    function test_refund_afterPartialReserveMakesTheDepositorWhole() public {
        uint256 ownerStart = s_token.balanceOf(owner);
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        uint256 sourceAmount = DEPOSIT_AMOUNT / 2;
        uint256 feeAmount = s_escrow.determineFee(sourceAmount, s_escrow.getTokenConfig(s_token));
        s_escrow.reserve(_reserveInputFor(depositId, input, sourceAmount));

        IEscrow.RefundWitness memory witness = _unreservedRefundWitness(depositId);
        witness.quoteHash = DEFAULT_QUOTE_HASH;
        witness.settler = settler;
        witness.amount = sourceAmount;
        witness.feeAmount = feeAmount;
        refundDeposit(s_escrow, witness, releaserPrivateKey);

        assertEq(s_token.balanceOf(owner), ownerStart, "depositor whole across reserve and refund");
        assertEq(s_token.balanceOf(address(s_escrow)), 0, "escrow empty");
    }

    // Re-funding the same id after a refund reverts on the spent nonce: the cleared slot
    // alone would let it through.
    function test_directDeposit_refundedIdCannotBeRefunded() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _unreservedDeposit();
        vm.prank(owner);
        s_escrow.refundUnreserved(_refundUnreservedInput(depositId));

        _fund(owner, DEPOSIT_AMOUNT);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.NonceAlreadyUsed.selector, DEFAULT_NONCE));
        s_escrow.directDeposit(input);
    }

    // Happy path: the owner approves the amount and calls in the same batch; the escrow pulls it,
    // the deposit is stored unreserved, `Deposited` carries zeros for quoteHash, settler and
    // feeAmount, and both logs are emitted.
    function test_directDeposit_happyPath() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _directInput(DEFAULT_NONCE);
        uint256 ownerBefore = s_token.balanceOf(owner);

        vm.startPrank(owner);
        s_token.approve(address(s_escrow), DEPOSIT_AMOUNT);

        vm.expectEmit(true, true, true, true, address(s_escrow));
        emit IEscrow.Deposited(
            depositId, bytes32(0), owner, address(0), address(s_token), DEPOSIT_AMOUNT, 0, reserver, releaser
        );
        vm.expectEmit(true, true, true, true, address(s_escrow));
        emit IEscrow.DepositCommitments(depositId, DEFAULT_DEPOSIT_REQUEST_HASH, DEFAULT_DESTINATION_HASH);

        bytes32 returnedId = s_escrow.directDeposit(input);
        vm.snapshotGasLastCall("direct_deposit_success");
        vm.stopPrank();

        assertEq(returnedId, depositId, "returned id");
        assertEq(s_token.balanceOf(address(s_escrow)), DEPOSIT_AMOUNT, "escrow balance");
        assertEq(s_token.balanceOf(owner), ownerBefore - DEPOSIT_AMOUNT, "owner balance");
        assertEq(s_escrow.getDepositHash(depositId), _expectedUnreservedHash(), "stored hash is the unreserved tuple");
    }

    // Nothing to pull: the call without the owner's approval reverts in the token, and nothing is
    // booked.
    function test_directDeposit_withoutApproveReverts() public {
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _directInput(DEFAULT_NONCE);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(s_escrow), 0, DEPOSIT_AMOUNT
            )
        );
        s_escrow.directDeposit(input);
        assertEq(s_escrow.getDepositHash(depositId), bytes32(0), "nothing stored");
        _assertSnapshotCleared(depositId);
        _fund(owner, DEPOSIT_AMOUNT);
        vm.prank(owner);
        assertEq(s_escrow.directDeposit(input), depositId, "failed pull did not consume the nonce");
    }

    // Same nonce twice reverts; a nonce in another bitmap word is independent; the bitmap is
    // keyed by the caller, so another account's spent nonce does not affect the owner's.
    function test_directDeposit_sameNonceTwiceReverts() public {
        (IEscrow.DirectDepositInput memory input,) = _directInput(DEFAULT_NONCE);
        _fund(owner, DEPOSIT_AMOUNT);
        vm.prank(owner);
        s_escrow.directDeposit(input);

        // A fresh id for the same nonce (different amount), so the active-hash duplicate check
        // cannot be what rejects it: only the spent nonce can.
        (IEscrow.DirectDepositInput memory replay,) =
            _directInputFor(_defaultWitness(), DEPOSIT_AMOUNT - 1, DEFAULT_NONCE);
        _fund(owner, DEPOSIT_AMOUNT);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.NonceAlreadyUsed.selector, DEFAULT_NONCE));
        s_escrow.directDeposit(replay);
    }

    /// @dev Two deposits by `owner` with nonces `a` then `b`, each funded; returns the second id.
    function _depositTwoNonces(uint256 a, uint256 b) internal returns (bytes32 secondId) {
        (IEscrow.DirectDepositInput memory first,) = _directInput(a);
        IEscrow.DirectDepositInput memory second;
        (second, secondId) = _directInput(b);

        vm.startPrank(owner);
        s_token.approve(address(s_escrow), DEPOSIT_AMOUNT);
        s_escrow.directDeposit(first);
        s_token.approve(address(s_escrow), DEPOSIT_AMOUNT);
        assertEq(s_escrow.directDeposit(second), secondId);
        vm.stopPrank();
    }

    // Same bit position, next word: nonce >> 8 differs, nonce & 0xff is the same
    function test_directDeposit_nonceInAnotherWordIsIndependent() public {
        _depositTwoNonces(DEFAULT_NONCE, DEFAULT_NONCE + 256);
        assertEq(s_token.balanceOf(address(s_escrow)), 2 * DEPOSIT_AMOUNT);
    }

    // Same word, another bit: a pinned concrete case of the fuzz below
    function test_directDeposit_otherBitSameWordIsIndependent() public {
        _depositTwoNonces(DEFAULT_NONCE, DEFAULT_NONCE + 128);
    }

    function testFuzz_directDeposit_distinctNoncesInOneWordAreIndependent(uint256 a, uint8 bitB) public {
        uint256 b = (a & ~uint256(0xff)) | bitB;
        vm.assume(a != b);
        _depositTwoNonces(a, b);
    }

    function test_directDeposit_nonceIsPerCaller() public {
        address otherOwner = makeAddr("otherOwner");
        deal(address(s_token), otherOwner, DEPOSIT_AMOUNT);

        // The other account spends DEFAULT_NONCE first, in its own bitmap
        (IEscrow.DirectDepositInput memory otherInput, bytes32 otherId) =
            _directInputFor(s_escrow, otherOwner, address(s_token), _defaultWitness(), DEPOSIT_AMOUNT, DEFAULT_NONCE);
        _fund(otherOwner, DEPOSIT_AMOUNT);
        vm.prank(otherOwner);
        assertEq(s_escrow.directDeposit(otherInput), otherId);

        // The owner's DEFAULT_NONCE is still unspent
        (IEscrow.DirectDepositInput memory input, bytes32 depositId) = _directInput(DEFAULT_NONCE);
        _fund(owner, DEPOSIT_AMOUNT);
        vm.prank(owner);
        assertEq(s_escrow.directDeposit(input), depositId);
    }

    function test_directDeposit_tokenNotAllowedReverts() public {
        MockToken otherToken = new MockToken("Other", "OTH");
        (IEscrow.DirectDepositInput memory input,) =
            _directInputFor(s_escrow, owner, address(otherToken), _defaultWitness(), DEPOSIT_AMOUNT, DEFAULT_NONCE);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenNotAllowed.selector, address(otherToken)));
        s_escrow.directDeposit(input);
    }

    // The shared witness checks run on this path too: a deposit stored with a zero releaser could
    // never be released or refunded, and there is no rescue function.
    function test_directDeposit_zeroReleaserReverts() public {
        IEscrow.DepositWitness memory witness = _defaultWitness();
        witness.releaser = address(0);
        (IEscrow.DirectDepositInput memory input,) = _directInputFor(witness, DEPOSIT_AMOUNT, DEFAULT_NONCE);
        _fund(owner, DEPOSIT_AMOUNT);

        vm.prank(owner);
        vm.expectRevert(IEscrow.ReleaserCannotBeZeroAddress.selector);
        s_escrow.directDeposit(input);
    }

    function test_directDeposit_zeroDepositRequestHashReverts() public {
        IEscrow.DepositWitness memory witness = _defaultWitness();
        witness.depositRequestHash = bytes32(0);
        (IEscrow.DirectDepositInput memory input,) = _directInputFor(witness, DEPOSIT_AMOUNT, DEFAULT_NONCE);
        _fund(owner, DEPOSIT_AMOUNT);

        vm.prank(owner);
        vm.expectRevert(IEscrow.DepositRequestHashCannotBeEmpty.selector);
        s_escrow.directDeposit(input);
    }

    function test_directDeposit_emptyDestinationReverts() public {
        IEscrow.DepositWitness memory witness = _defaultWitness();
        witness.destination = "";
        (IEscrow.DirectDepositInput memory input,) = _directInputFor(witness, DEPOSIT_AMOUNT, DEFAULT_NONCE);
        _fund(owner, DEPOSIT_AMOUNT);

        vm.prank(owner);
        vm.expectRevert(IEscrow.DestinationCannotBeEmpty.selector);
        s_escrow.directDeposit(input);
    }

    function test_directDeposit_destinationTooLongReverts() public {
        IEscrow.DepositWitness memory witness = _defaultWitness();
        witness.destination = string(new bytes(257));
        (IEscrow.DirectDepositInput memory input,) = _directInputFor(witness, DEPOSIT_AMOUNT, DEFAULT_NONCE);
        _fund(owner, DEPOSIT_AMOUNT);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DestinationTooLong.selector, 257));
        s_escrow.directDeposit(input);
    }

    function test_directDeposit_zeroAmountReverts() public {
        (IEscrow.DirectDepositInput memory input,) = _directInputFor(_defaultWitness(), 0, DEFAULT_NONCE);

        vm.prank(owner);
        vm.expectRevert(IEscrow.DepositAmountCannotBeZero.selector);
        s_escrow.directDeposit(input);
    }

    function test_directDeposit_revertsWhenPaused() public {
        (IEscrow.DirectDepositInput memory input,) = _directInput(DEFAULT_NONCE);
        _fund(owner, DEPOSIT_AMOUNT);
        s_escrow.grantRole(s_escrow.PAUSER_ROLE(), address(this));
        s_escrow.pause();

        vm.prank(owner);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        s_escrow.directDeposit(input);
    }

    // Known-answer vector for the direct deposit id, derived out of band with `cast abi-encode` and
    // `cast keccak` from the preimage documented on `directDeposit` (chain id 31337, escrow at
    // KA_ESCROW, owner KA_OWNER, token KA_TOKEN, nonce 7, the default witness: DEFAULT_DEPOSIT_REQUEST_HASH,
    // DEFAULT_DESTINATION, reserver 0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb and releaser
    // 0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9, the makeAddrAndKey("reserver")/("releaser")
    // addresses; amount 1000e18). It pins the member order against the test helper AND against
    // the contract, so a coordinated change of both cannot pass silently; encoders in other
    // languages reproduce this value from the spec.
    address internal constant KA_ESCROW = 0x000000000000000000000000000000000000e5c0;
    address internal constant KA_OWNER = 0x00000000000000000000000000000000000A11cE;
    address internal constant KA_TOKEN = 0x00000000000000000000000000000000000070Ce;
    bytes32 internal constant KA_DEPOSIT_ID = 0xab346d06d4abffab74aa79d969ca268d9f19fdc3d621361434fa2516b2e703e8;

    function test_directDepositId_knownAnswer() public {
        assertEq(block.chainid, 31337, "vector is pinned for the default anvil chain id");
        IEscrow.DepositWitness memory witness = _defaultWitness();
        assertEq(
            _directDepositId(KA_ESCROW, KA_OWNER, KA_TOKEN, 7, witness, 1000e18),
            KA_DEPOSIT_ID,
            "test helper drifted from the known answer"
        );

        deployCodeTo("MockToken.sol:MockToken", abi.encode("Known Answer", "KA"), KA_TOKEN);
        deployCodeTo("Escrow.sol:Escrow", abi.encode(s_permit2, address(this)), KA_ESCROW);
        Escrow escrow = Escrow(KA_ESCROW);
        escrow.grantRole(escrow.TOKEN_CONFIG_ROLE(), address(this));
        escrow.allowToken(IERC20(KA_TOKEN), 18);
        escrow.setTokenFeeConfig(IERC20(KA_TOKEN), 20000, 0, 25000000);
        deal(KA_TOKEN, KA_OWNER, 1000e18);

        (IEscrow.DirectDepositInput memory input,) = _directInputFor(escrow, KA_OWNER, KA_TOKEN, witness, 1000e18, 7);
        vm.startPrank(KA_OWNER);
        IERC20(KA_TOKEN).approve(KA_ESCROW, 1000e18);
        assertEq(escrow.directDeposit(input), KA_DEPOSIT_ID, "contract drifted from the known answer");
        vm.stopPrank();
    }

    // The two id derivations cannot collide: a Permit2 preimage starts with a left-padded address
    // (upper 12 bytes zero), a direct preimage with the domain tag, whose upper bytes are not. The
    // happy path pins the helper's tag to the contract's (returned id == re-derived id).
    function test_directDepositDomainTag_isNotALeftPaddedAddress() public pure {
        assertGt(uint256(DIRECT_DEPOSIT_DOMAIN_TAG), uint256(type(uint160).max));
    }

    // The id is chain-bound: the same inputs on another chain id derive to a different id, and the
    // contract agrees with the helper there too.
    function test_directDeposit_idIsChainBound() public {
        (, bytes32 idAt31337) = _directInput(DEFAULT_NONCE);
        vm.chainId(1);
        (IEscrow.DirectDepositInput memory input, bytes32 idAt1) = _directInput(DEFAULT_NONCE);
        assertNotEq(idAt1, idAt31337, "chain id must reach the preimage");

        _fund(owner, DEPOSIT_AMOUNT);
        vm.prank(owner);
        assertEq(s_escrow.directDeposit(input), idAt1);
    }

    // Fuzz: a direct id never collides with a Permit2-derived id for the same depositor and
    // witness, whatever the nonce, amount or signature bytes. This can only fail on
    // a keccak collision; the structural argument is carried by
    // test_directDepositDomainTag_isNotALeftPaddedAddress and the known-answer vector above.
    function testFuzz_directDeposit_idNeverCollidesWithPermit2Id(
        uint256 nonce,
        uint256 sourceAmount,
        bytes calldata depositSignature
    ) public view {
        bytes32 directId = _directDepositId(
            address(s_escrow), owner, address(s_token), nonce, _defaultWitness(), sourceAmount
        );
        // The Permit2 side goes through the shared helper, as the other suites require, so this
        // test cannot drift from the contract's Permit2 derivation on its own.
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness) = _constructDepositPermitWitness(
            address(s_token), sourceAmount, reserver, releaser, nonce, DEFAULT_DEPOSIT_REQUEST_HASH, DEFAULT_DESTINATION
        );
        bytes32 permit2Id = expectedDepositId(permit, owner, witness, depositSignature);
        assertNotEq(directId, permit2Id);
    }
}

/// @dev Tests the actual token-call boundary of the linked reservation/refund library.
contract FeeSnapshotCallbackToken is MockToken {
    Escrow private escrow;
    bytes32 private depositId;
    bytes private reentry;
    bool private rejectOutbound;
    bool public attempted;
    bool public reentrySucceeded;
    bytes public reentryResult;
    bool public snapshotCleared;

    /// @dev When the pull hook runs relative to the tokens moving into the escrow.
    enum PullPhase {
        BeforeFundsLand,
        AfterFundsLand
    }

    // The pull hook's own target and state, so it and the outbound `transfer` hook stay independent.
    Escrow private pullEscrow;
    bytes32 private pullDepositId;
    bytes private pullReentry;
    PullPhase private pullPhase;
    bool public pullAttempted;
    bool public pullReentrySucceeded;
    bytes public pullReentryResult;
    uint256 public pullEscrowBalance;
    bytes32 public pullObservedHash;
    uint8 public pullObservedFeeDecimals;

    constructor() MockToken("Fee Snapshot Token", "FEE") {}

    function configure(Escrow target, bytes32 id, bytes memory callback, bool rejectTransfer) external {
        escrow = target;
        depositId = id;
        reentry = callback;
        rejectOutbound = rejectTransfer;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (msg.sender == address(escrow)) {
            require(!rejectOutbound, "outbound blocked");
            if (reentry.length != 0 && !attempted) {
                attempted = true;
                snapshotCleared = escrow.getDirectDepositFeeConfig(depositId).tokenDecimals == 0;
                (reentrySucceeded, reentryResult) = address(escrow).call(reentry);
            }
        }
        return super.transfer(to, amount);
    }

    /// @dev Arms the hook on the escrow's next pull, recording deposit `id`'s stored hash and fee
    ///      snapshot, and clears the last run's results. An empty callback only records.
    function configurePull(Escrow target, bytes32 id, bytes memory callback, PullPhase phase) external {
        pullEscrow = target;
        pullDepositId = id;
        pullReentry = callback;
        pullPhase = phase;
        pullAttempted = false;
        pullReentrySucceeded = false;
        delete pullReentryResult;
        pullEscrowBalance = 0;
        pullObservedHash = bytes32(0);
        pullObservedFeeDecimals = 0;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool isPull = msg.sender == address(pullEscrow) && to == address(pullEscrow) && !pullAttempted;
        if (isPull && pullPhase == PullPhase.BeforeFundsLand) _onPull();
        bool ok = super.transferFrom(from, to, amount);
        if (isPull && pullPhase == PullPhase.AfterFundsLand) _onPull();
        return ok;
    }

    /// @dev Records the escrow's balance and the deposit's stored hash and fee snapshot, then runs
    ///      the nested call, if any.
    function _onPull() private {
        pullAttempted = true;
        pullEscrowBalance = balanceOf(address(pullEscrow));
        pullObservedHash = pullEscrow.getDepositHash(pullDepositId);
        pullObservedFeeDecimals = pullEscrow.getDirectDepositFeeConfig(pullDepositId).tokenDecimals;
        if (pullReentry.length != 0) {
            (pullReentrySucceeded, pullReentryResult) = address(pullEscrow).call(pullReentry);
        }
    }
}
