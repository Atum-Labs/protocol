// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IPermit2} from "@alexroan/permit2-tron/contracts/interfaces/IPermit2.sol";
import {ISignatureTransfer} from "@alexroan/permit2-tron/contracts/interfaces/ISignatureTransfer.sol";
import {SignatureVerification} from "@alexroan/permit2-tron/contracts/libraries/SignatureVerification.sol";
import {Escrow} from "../contracts/Escrow.sol";
import {IEscrow} from "../contracts/interfaces/IEscrow.sol";
import {TestHelpers} from "./helpers/TestHelpers.sol";
import {LocalPermit2} from "./helpers/LocalPermit2.sol";
import {DeployCoreContracts} from "../foundry_scripts/DeployCoreContracts.s.sol";
import {MockToken6DecimalsTransferReturnsFalse} from "./mock/MockToken.sol";

/// @notice CORE-2120: the depositor's commitment to `destination` and `depositRequestHash`, from the
/// DepositWitness through storage and back out through both settlement paths.
///
/// WHY THIS FILE EXISTS ON TRON. The destination commitment shipped here with no coverage at all:
/// `DestinationCannotBeEmpty`, `DestinationTooLong`, `DepositRequestHashCannotBeEmpty` and the
/// `DepositCommitments` event appeared in no TVM test, while the EVM tree carries this suite plus an
/// event suite for byte-identical logic. Those are new revert paths on the deposit leg and two new
/// members of the tuple `_release`/`_refund` rebuild — and this escrow has NO rescue function, so a
/// settlement leg that cannot reconstruct what `_deposit` stored is a permanent fund lock, not a bug
/// report.
///
/// TRON-SPECIFIC NOTES, because they change what these tests actually exercise:
///   - No fork. `LocalPermit2.etch()` puts the real Tron Permit2 at its canonical address, so the
///     deposit leg still goes through genuine Permit2 witness recovery: a drifted witness type string
///     or struct hash surfaces here as `InvalidSigner`, exactly as it does on a forked EVM run.
///   - The escrowed token is ALSO the escrow's `i_usdt`, because the standard fixture token models
///     Tron USDT's "successful transfer returns false" behaviour and `SafeERC20` would revert on it.
///     That is not a workaround, it is the more interesting configuration: every release and refund
///     below therefore runs `Escrow._usdtTransfer` — the raw call plus balance-delta check that Tron
///     needs and EVM does not — so the fund-lock regressions cover the payout path Tron will really
///     use in production.
contract EscrowDestinationCommitmentTest is Test, TestHelpers {
    bytes32 private constant EXPECTED_DEPOSIT_WITNESS_TYPE_HASH =
        0x49bfb2c307c3a42001389497e5f5b9dc592052768c1f3cdf09aac3c58ec582b9;

    /// @dev Escrow.sol's own source, read by the type-string pin below.
    string private constant ESCROW_SOURCE_PATH = "contracts/Escrow.sol";

    /// @dev 1,000 units of a 6-decimal token. EVM's fixture is 18-decimal; the standard TVM fixture
    /// token reports 6 decimals, and the fee config below is scaled to match, so the fee terms stay
    /// load-bearing rather than rounding to zero.
    uint256 private constant DEPOSIT_AMOUNT = 1000e6;

    /// @dev Non-zero protocol fee, so `feeAmount` is a load-bearing term of both rebuilt
    /// ActiveDeposit tuples and of the release balance assertion. At a zero fee every feeAmount
    /// word is trivially zero and a dropped or misplaced fee term would go unnoticed.
    /// 0.02% of DEPOSIT_AMOUNT = 0.2e6; the $25 cap is deliberately not binding.
    uint88 private constant FEE_PERCENTAGE = 0.02e6;
    uint80 private constant MAX_FEE = 25e6;

    /// @dev The fixture token's declared decimals. `allowToken` cross-checks this against the token's
    /// own `decimals()`, so it is not a free parameter.
    uint8 private constant TOKEN_DECIMALS = 6;

    /// @dev The widest destination the contract accepts. Hashing the destination into storage
    /// instead of keeping the plaintext is what makes this width free downstream, so both
    /// settlement legs are exercised at it, not just the deposit leg.
    uint256 private constant MAX_DESTINATION_BYTES = 256;

    /// @dev Distinct from Signatures.sol's DEFAULT_* so these tests never accidentally pass
    /// because the fixture default happened to be the value under test. Enforced, not merely
    /// claimed, by test_fixtureValues_areDistinctFromTheSharedHelperDefaults below.
    bytes32 private constant REQUEST_HASH = keccak256("request-content");
    // Both destinations are ARBITRARY byte strings chosen to exercise commitment behavior and are
    // NOT canonical-form examples (mixed-case hex). They deliberately name non-Tron payout chains:
    // the escrow here is the SOURCE, and the contract validates length only, so a Tron deposit
    // paying out on an EVM chain is the ordinary case rather than an odd one.
    string private constant DESTINATION =
        "eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831@0x2222222222222222222222222222222222222222";
    string private constant OTHER_DESTINATION =
        "eip155:10/erc20:0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85@0x3333333333333333333333333333333333333333";

    Escrow private s_escrow;
    IERC20 private s_token;
    IPermit2 private s_permit2;

    address private depositor;
    uint256 private depositorPrivateKey;
    address private reserver;
    uint256 private reserverPrivateKey;
    address private releaser;
    uint256 private releaserPrivateKey;
    address private settler;

    // Deliberately NO `test_depositWitnessTypeHash_isPinned`: it would hash a type string written in
    // this file and compare the result with a literal written in this file, with no tie to contracts/
    // at all — two halves of the same edit agreeing with each other. Its assertion is also the FIRST
    // assertion of test_depositWitness_fullTypeStringInEscrowSourceMatchesTypeHash below, which adds
    // the missing tie by requiring contracts/Escrow.sol's own FULL_DEPOSIT_WITNESS_TYPE_STRING to
    // embed that exact type string. The member ORDER of the struct declaration is pinned separately
    // in Escrow.declarationOrder.t.sol, and the runtime encode order in Escrow.canonicalDepositDigest.t.sol.

    /// @dev Ties the DepositWitness member list to the contract's OWN Permit2 witness type string.
    /// Permit2 hashes FULL_DEPOSIT_WITNESS_TYPE_STRING out of contracts/Escrow.sol at runtime while
    /// Escrow hashes the witness values with DEPOSIT_WITNESS_TYPE_HASH: if the two ever disagree on
    /// the member list or its order, every deposit reverts InvalidSigner. Nothing in the TVM tree
    /// checked the full type string those two have to agree on — an assertion over a locally built
    /// struct never could, and Escrow.declarationOrder.t.sol reads IEscrow.sol, not Escrow.sol.
    ///
    /// REQUIRES ONE foundry.toml LINE. `fs_permissions` currently grants read access to
    /// contracts/interfaces/IEscrow.sol and the Permit2 artifact only, so this test needs
    /// `{ access = "read", path = "contracts/Escrow.sol" }` added alongside them. Without it
    /// vm.readFile reverts. Do NOT weaken the test to avoid the config line: a source-tie assertion
    /// that reads no source proves nothing.
    function test_depositWitness_fullTypeStringInEscrowSourceMatchesTypeHash() public view {
        string memory canonical =
            "DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)";

        assertEq(
            keccak256(bytes(canonical)),
            EXPECTED_DEPOSIT_WITNESS_TYPE_HASH,
            "canonical DepositWitness type string no longer hashes to the pinned typehash"
        );

        assertTrue(
            vm.contains(
                vm.readFile(ESCROW_SOURCE_PATH),
                string.concat("DepositWitness witness)", canonical, "TokenPermissions(address token,uint256 amount)")
            ),
            "contracts/Escrow.sol's FULL_DEPOSIT_WITNESS_TYPE_STRING no longer embeds the canonical 4-member DepositWitness type string in order - Permit2 hashes that string at runtime, so every deposit would revert InvalidSigner"
        );
    }

    /// @dev Makes the "distinct from the shared helper defaults" claim above enforceable. If a
    /// fixture value collides with Signatures.sol's default, a test meant to prove a value travels
    /// end to end can pass on the default instead. This file overrides the two witness members the
    /// helper hardcodes, so a collision would be silent.
    function test_fixtureValues_areDistinctFromTheSharedHelperDefaults() public pure {
        assertTrue(
            keccak256(bytes(DESTINATION)) != keccak256(bytes(DEFAULT_DESTINATION)),
            "DESTINATION equals Signatures.sol's DEFAULT_DESTINATION; destination tests can pass vacuously"
        );
        assertTrue(
            keccak256(bytes(OTHER_DESTINATION)) != keccak256(bytes(DEFAULT_DESTINATION)),
            "OTHER_DESTINATION equals Signatures.sol's DEFAULT_DESTINATION"
        );
        assertTrue(
            keccak256(bytes(DESTINATION)) != keccak256(bytes(OTHER_DESTINATION)),
            "DESTINATION and OTHER_DESTINATION are identical; the tamper tests prove nothing"
        );
        assertTrue(
            REQUEST_HASH != DEFAULT_DEPOSIT_REQUEST_HASH,
            "REQUEST_HASH equals Signatures.sol's DEFAULT_DEPOSIT_REQUEST_HASH"
        );
        // Deliberately no `bytes(DESTINATION).length <= MAX_DESTINATION_BYTES` assertion: both
        // sides are compile-time constants (a ~104-byte string against 256), so it could never
        // fail and would only look like coverage. The cap - and this file's MAX_DESTINATION_BYTES
        // mirror of the contract's private constant - is pinned for real by
        // test_deposit_revertsOnTooLongDestination (expects DestinationTooLong at cap + 1) and
        // test_deposit_succeedsWithMaxLengthDestination (a deposit at exactly the cap).
    }

    function setUp() public {
        // Real Permit2, no RPC: see foundry_tests/helpers/LocalPermit2.sol. Nothing in this suite
        // reads any other chain state -- the token, the escrow and every key are local.
        s_permit2 = LocalPermit2.etch();

        MockToken6DecimalsTransferReturnsFalse mockToken =
            new MockToken6DecimalsTransferReturnsFalse("Test Token", "TEST");
        s_token = IERC20(address(mockToken));

        DeployCoreContracts deployCoreContracts = new DeployCoreContracts();
        // The escrowed token is handed over as the escrow's USDT address on purpose: this fixture
        // models Tron USDT (a SUCCESSFUL transfer returns false), which SafeERC20 rejects. Routing it
        // through `i_usdt` is both the only way the settlement legs below can pay out and the
        // configuration Tron actually runs, so the refund/release regressions exercise
        // `_usdtTransfer`'s balance-delta check rather than the SafeERC20 path EVM uses.
        (s_escrow,) = deployCoreContracts.run(s_token);

        address tokenConfig = makeAddr("destinationCommitmentTokenConfig");
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), tokenConfig);

        vm.startPrank(tokenConfig);
        // Non-zero fee on purpose: see FEE_PERCENTAGE.
        s_escrow.allowTokenAndSetFeeConfig(s_token, TOKEN_DECIMALS, FEE_PERCENTAGE, 0, MAX_FEE);
        vm.stopPrank();

        uint256 feeAmount = _feeAmount();
        assertTrue(feeAmount != 0, "protocol fee is zero; the feeAmount term of every rebuilt tuple is vacuous");
        assertTrue(feeAmount < DEPOSIT_AMOUNT, "the fee must leave a non-zero release payout to assert on");

        (depositor, depositorPrivateKey) = makeAddrAndKey("destinationCommitmentDepositor");
        (reserver, reserverPrivateKey) = makeAddrAndKey("destinationCommitmentReserver");
        (releaser, releaserPrivateKey) = makeAddrAndKey("destinationCommitmentReleaser");
        settler = makeAddr("destinationCommitmentSettler");

        // mint(), not deal(): the fixture is Ownable and this contract deployed it, and the tree's
        // other no-RPC suites fund the same way.
        mockToken.mint(depositor, DEPOSIT_AMOUNT * 1000);

        vm.prank(depositor);
        s_token.approve(address(s_permit2), type(uint256).max);
    }

    /// @dev Built separately from submission on purpose: constructing the input calls
    /// `permit2.DOMAIN_SEPARATOR()`, and `vm.expectRevert` binds to the NEXT call — so building
    /// inside an expectRevert window would arm the cheatcode against the domain-separator read
    /// instead of against `deposit`, and the test would pass for the wrong reason.
    ///
    /// The two commitments are written onto the witness AFTER the helper returns because TVM's
    /// helpers/Signatures.sol has no overload that takes them: `_constructDepositPermitWitness`
    /// always fills in DEFAULT_DEPOSIT_REQUEST_HASH and DEFAULT_DESTINATION. Overriding before
    /// signing is equivalent, not a shortcut — `_constructDepositSignature` hashes whatever witness
    /// it is handed, so the depositor still signs exactly the values submitted, which is precisely
    /// what the tamper tests below rely on.
    function _buildDepositInput(uint256 nonce, bytes32 depositRequestHash, string memory destination)
        private
        view
        returns (IEscrow.DepositInput memory depositInput)
    {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _constructDepositPermitWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, nonce);
        depositWitness.depositRequestHash = depositRequestHash;
        depositWitness.destination = destination;

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        // Shared helper on purpose: an inlined keccak256(abi.encode(depositor, signature, nonce))
        // here would silently diverge if the depositId formula ever changes.
        bytes32 depositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness =
            _constructReserveWitness(depositId, DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
    }

    function _feeAmount() private view returns (uint256) {
        return s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig(s_token));
    }

    function _deposit(uint256 nonce, bytes32 depositRequestHash, string memory destination)
        private
        returns (bytes32 depositId)
    {
        return s_escrow.deposit(_buildDepositInput(nonce, depositRequestHash, destination));
    }

    /// @dev ARBITRARY length probe ("a" repeated), NOT a canonical-form destination.
    function _destinationOfLength(uint256 length) private pure returns (string memory) {
        bytes memory destination = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            destination[i] = "a";
        }
        return string(destination);
    }

    /// @dev Rebuilds what the contract stored, from the values the depositor committed to.
    /// destinationHash is derived here from the plaintext, independently of the contract.
    function _expectedActiveDepositHash(bytes32 depositRequestHash, string memory destination)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: depositor,
                    quoteHash: DEFAULT_QUOTE_HASH,
                    depositRequestHash: depositRequestHash,
                    destinationHash: keccak256(bytes(destination)),
                    token: address(s_token),
                    amount: DEPOSIT_AMOUNT,
                    feeAmount: _feeAmount(),
                    reserver: reserver,
                    releaser: releaser,
                    settler: settler
                })
            )
        );
    }

    function _releaseWitnessFor(bytes32 depositId, bytes32 depositRequestHash, bytes32 destinationHash)
        private
        view
        returns (IEscrow.ReleaseWitness memory)
    {
        return IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: depositRequestHash,
            destinationHash: destinationHash,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: _feeAmount(),
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });
    }

    function _refundWitnessFor(bytes32 depositId, bytes32 depositRequestHash, bytes32 destinationHash)
        private
        view
        returns (IEscrow.RefundWitness memory)
    {
        return IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: depositRequestHash,
            destinationHash: destinationHash,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: _feeAmount(),
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });
    }

    function _release(IEscrow.ReleaseWitness memory witness) private {
        s_escrow.release(
            IEscrow.ReleaseInput({
                releaseWitness: witness,
                releaseSignature: _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey)
            })
        );
    }

    function _refund(IEscrow.RefundWitness memory witness) private {
        s_escrow.refund(
            IEscrow.RefundInput({
                refundWitness: witness,
                refundSignature: _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey)
            })
        );
    }

    // ---- deposit-side guards ----

    function test_deposit_revertsOnEmptyDestination() public {
        IEscrow.DepositInput memory depositInput = _buildDepositInput(1, REQUEST_HASH, "");

        vm.expectRevert(IEscrow.DestinationCannotBeEmpty.selector);
        s_escrow.deposit(depositInput);
    }

    function test_deposit_revertsOnTooLongDestination() public {
        string memory tooLong = _destinationOfLength(MAX_DESTINATION_BYTES + 1);

        IEscrow.DepositInput memory depositInput = _buildDepositInput(1, REQUEST_HASH, tooLong);

        vm.expectRevert(abi.encodeWithSelector(IEscrow.DestinationTooLong.selector, MAX_DESTINATION_BYTES + 1));
        s_escrow.deposit(depositInput);
    }

    function test_deposit_succeedsWithMaxLengthDestination() public {
        string memory maxLen = _destinationOfLength(MAX_DESTINATION_BYTES);

        bytes32 depositId = s_escrow.deposit(_buildDepositInput(1, REQUEST_HASH, maxLen));

        // `depositId != 0` cannot fail: it is a keccak256 over a non-empty preimage. Assert the
        // full-width destination actually reached the stored commitment as its hash instead.
        assertEq(
            s_escrow.getDepositHash(depositId),
            _expectedActiveDepositHash(REQUEST_HASH, maxLen),
            "a 256-byte destination did not enter the stored commitment as keccak256(bytes(destination))"
        );
    }

    /// CORE-2120: a zero depositRequestHash means "committed to nothing". Rejected on the
    /// deposit path so no stored deposit can carry it, which is what lets _release/_refund
    /// rely on the hash-equality check alone instead of paying for a repeat guard.
    function test_deposit_revertsOnZeroDepositRequestHash() public {
        IEscrow.DepositInput memory depositInput = _buildDepositInput(1, bytes32(0), DESTINATION);

        vm.expectRevert(IEscrow.DepositRequestHashCannotBeEmpty.selector);
        s_escrow.deposit(depositInput);
    }

    /// The guard lives in the shared _deposit, so depositMany() inherits it per item —
    /// a valid first deposit must not launder a zero-commitment second one through the batch.
    function test_depositMany_revertsOnZeroDepositRequestHash() public {
        IEscrow.DepositInput[] memory depositInputs = new IEscrow.DepositInput[](2);
        depositInputs[0] = _buildDepositInput(1, REQUEST_HASH, DESTINATION);
        depositInputs[1] = _buildDepositInput(2, bytes32(0), DESTINATION);

        vm.expectRevert(IEscrow.DepositRequestHashCannotBeEmpty.selector);
        s_escrow.depositMany(depositInputs);
    }

    // ---- deposit-side tamper: the property the ticket actually buys ----

    /// CORE-2120 core security property: the depositor signs a witness committing to
    /// destination A; submitting the same signature with destination B must not transfer
    /// funds. Permit2 recomputes the witness hash from the submitted struct, so the
    /// substitution shows up as InvalidSigner. This is a real Permit2 rejection, not a mocked
    /// one — LocalPermit2 etches the vendored runtime bytecode, so the recovery is the same code
    /// Tron runs.
    function test_deposit_tamperedDestination_rejectedByPermit2() public {
        IEscrow.DepositInput memory depositInput = _buildDepositInput(1, REQUEST_HASH, DESTINATION);

        // Same signature, same depositId (and so the same valid ReserveWitness), new destination.
        depositInput.depositWitness.destination = OTHER_DESTINATION;

        vm.expectRevert(SignatureVerification.InvalidSigner.selector);
        s_escrow.deposit(depositInput);
    }

    /// Sibling of the above for the other new DepositWitness member.
    function test_deposit_tamperedDepositRequestHash_rejectedByPermit2() public {
        IEscrow.DepositInput memory depositInput = _buildDepositInput(1, REQUEST_HASH, DESTINATION);

        depositInput.depositWitness.depositRequestHash = keccak256("other-request-content");

        vm.expectRevert(SignatureVerification.InvalidSigner.selector);
        s_escrow.deposit(depositInput);
    }

    // ---- storage ----

    /// Pins what enters storage: both commitments, in the ActiveDeposit field order the
    /// release/refund hash-equality check depends on. The plaintext destination never
    /// enters storage — only keccak256(bytes(destination)) does.
    function test_deposit_storesBothCommitmentHashes() public {
        bytes32 depositId = _deposit(1, REQUEST_HASH, DESTINATION);

        assertEq(
            s_escrow.getDepositHash(depositId),
            _expectedActiveDepositHash(REQUEST_HASH, DESTINATION),
            "stored ActiveDeposit hash does not commit to depositRequestHash + destinationHash"
        );
    }

    /// A deposit that differs ONLY in destination must store a different hash, otherwise
    /// the destination is not really part of the escrow's state commitment.
    function test_deposit_differentDestinationStoresDifferentHash() public {
        bytes32 first = _deposit(1, REQUEST_HASH, DESTINATION);
        bytes32 second = _deposit(2, REQUEST_HASH, OTHER_DESTINATION);

        // Deliberately no `first != second` guard. The two deposits use different permit nonces, so
        // they carry different depositor signatures and keccak256(depositor, signature, nonce)
        // differs; and if it somehow did not, the second _deposit above would already have reverted
        // DepositAlreadyExists rather than reaching this line. The assertion could not fail.
        assertTrue(
            s_escrow.getDepositHash(first) != s_escrow.getDepositHash(second),
            "destination is not part of the stored deposit commitment"
        );
    }

    // ---- the fund-lock regressions ----

    /// CORE-2120 FUND-LOCK GUARD: a refund MUST succeed after a deposit that carried a
    /// destination and a depositRequestHash. _refund rebuilds the ActiveDeposit tuple FROM
    /// the RefundWitness and requires hash equality, so any field entering ActiveDeposit
    /// that RefundWitness cannot supply reverts EVERY refund on EVERY chain — and the
    /// escrow has no rescue function. Refund is the escape hatch; it must never brick.
    function test_refundSucceedsAfterDepositWithDestination() public {
        bytes32 depositId = _deposit(1, REQUEST_HASH, DESTINATION);
        uint256 depositorBalanceBefore = s_token.balanceOf(depositor);

        _refund(_refundWitnessFor(depositId, REQUEST_HASH, keccak256(bytes(DESTINATION))));

        assertEq(s_escrow.getDepositHash(depositId), bytes32(0), "deposit not cleared by refund");
        assertEq(
            s_token.balanceOf(depositor),
            depositorBalanceBefore + DEPOSIT_AMOUNT,
            "depositor was not made whole by the refund"
        );
    }

    /// Release counterpart: the settlement path must also survive the new fields.
    function test_releaseSucceedsAfterDepositWithDestination() public {
        bytes32 depositId = _deposit(1, REQUEST_HASH, DESTINATION);
        uint256 settlerBalanceBefore = s_token.balanceOf(settler);
        uint256 feeAmount = _feeAmount();

        _release(_releaseWitnessFor(depositId, REQUEST_HASH, keccak256(bytes(DESTINATION))));

        assertEq(s_escrow.getDepositHash(depositId), bytes32(0), "deposit not cleared by release");
        assertEq(
            s_token.balanceOf(settler),
            settlerBalanceBefore + DEPOSIT_AMOUNT - feeAmount,
            "settler did not receive the released amount"
        );
    }

    /// Release at the maximum accepted destination width. The 256-byte case is what motivates
    /// keeping only the hash in storage, so it has to be shown surviving the settlement legs
    /// and not just the deposit leg: nothing in the reconstruction should depend on the
    /// preimage's length, and this is the test that would notice if that stopped being true.
    function test_releaseSucceedsWithMaxLengthDestination() public {
        string memory maxLen = _destinationOfLength(MAX_DESTINATION_BYTES);
        bytes32 depositId = _deposit(1, REQUEST_HASH, maxLen);
        uint256 settlerBalanceBefore = s_token.balanceOf(settler);
        uint256 feeAmount = _feeAmount();

        _release(_releaseWitnessFor(depositId, REQUEST_HASH, keccak256(bytes(maxLen))));

        assertEq(s_escrow.getDepositHash(depositId), bytes32(0), "deposit not cleared by release");
        assertEq(
            s_token.balanceOf(settler),
            settlerBalanceBefore + DEPOSIT_AMOUNT - feeAmount,
            "settler did not receive the released amount for a 256-byte destination"
        );
    }

    /// Refund counterpart at the same width. Refund is the escape hatch, so a width-dependent
    /// failure here would be a fund lock.
    function test_refundSucceedsWithMaxLengthDestination() public {
        string memory maxLen = _destinationOfLength(MAX_DESTINATION_BYTES);
        bytes32 depositId = _deposit(1, REQUEST_HASH, maxLen);
        uint256 depositorBalanceBefore = s_token.balanceOf(depositor);

        _refund(_refundWitnessFor(depositId, REQUEST_HASH, keccak256(bytes(maxLen))));

        assertEq(s_escrow.getDepositHash(depositId), bytes32(0), "deposit not cleared by refund");
        assertEq(
            s_token.balanceOf(depositor),
            depositorBalanceBefore + DEPOSIT_AMOUNT,
            "depositor was not made whole for a 256-byte destination"
        );
    }

    // ---- settlement-side tamper ----
    //
    // These assert the FULL 3-argument InvalidWitnessValues data rather than only its selector,
    // matching the convention for this code path elsewhere in the suite: the reverting branch also
    // reports the two hashes it compared, and pinning those shows the rejection came from the
    // tampered field and not from some unrelated reconstruction difference that happens to raise the
    // same error.

    /// @dev Expects the exact stored-vs-passed payload the contract reports for a bad witness.
    function _expectInvalidWitnessValues(bytes32 depositId, bytes32 passedHash) private {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrow.InvalidWitnessValues.selector, depositId, s_escrow.getDepositHash(depositId), passedHash
            )
        );
    }

    /// @dev The ActiveDeposit hash the contract will rebuild from a witness carrying these two
    /// commitments. Mirrors the reconstruction in _release/_refund, and is used only to predict
    /// the revert payload - never to verify a digest.
    function _rebuiltHash(bytes32 depositRequestHash, bytes32 destinationHash) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: depositor,
                    quoteHash: DEFAULT_QUOTE_HASH,
                    depositRequestHash: depositRequestHash,
                    destinationHash: destinationHash,
                    token: address(s_token),
                    amount: DEPOSIT_AMOUNT,
                    feeAmount: _feeAmount(),
                    reserver: reserver,
                    releaser: releaser,
                    settler: settler
                })
            )
        );
    }

    function test_refund_revertsOnTamperedDestinationHash() public {
        bytes32 depositId = _deposit(1, REQUEST_HASH, DESTINATION);

        bytes32 tamperedDestinationHash = keccak256(bytes(OTHER_DESTINATION));
        IEscrow.RefundWitness memory witness = _refundWitnessFor(depositId, REQUEST_HASH, tamperedDestinationHash);

        _expectInvalidWitnessValues(depositId, _rebuiltHash(REQUEST_HASH, tamperedDestinationHash));
        _refund(witness);
    }

    function test_refund_revertsOnTamperedDepositRequestHash() public {
        bytes32 depositId = _deposit(1, REQUEST_HASH, DESTINATION);

        bytes32 tamperedRequestHash = keccak256("other-request-content");
        IEscrow.RefundWitness memory witness =
            _refundWitnessFor(depositId, tamperedRequestHash, keccak256(bytes(DESTINATION)));

        _expectInvalidWitnessValues(depositId, _rebuiltHash(tamperedRequestHash, keccak256(bytes(DESTINATION))));
        _refund(witness);
    }

    function test_release_revertsOnTamperedDestinationHash() public {
        bytes32 depositId = _deposit(1, REQUEST_HASH, DESTINATION);

        bytes32 tamperedDestinationHash = keccak256(bytes(OTHER_DESTINATION));
        IEscrow.ReleaseWitness memory witness = _releaseWitnessFor(depositId, REQUEST_HASH, tamperedDestinationHash);

        _expectInvalidWitnessValues(depositId, _rebuiltHash(REQUEST_HASH, tamperedDestinationHash));
        _release(witness);
    }

    function test_release_revertsOnTamperedDepositRequestHash() public {
        bytes32 depositId = _deposit(1, REQUEST_HASH, DESTINATION);

        bytes32 tamperedRequestHash = keccak256("other-request-content");
        IEscrow.ReleaseWitness memory witness =
            _releaseWitnessFor(depositId, tamperedRequestHash, keccak256(bytes(DESTINATION)));

        _expectInvalidWitnessValues(depositId, _rebuiltHash(tamperedRequestHash, keccak256(bytes(DESTINATION))));
        _release(witness);
    }

    /// The stored commitment has to be POSITION-sensitive, not merely content-sensitive: a
    /// witness that exchanges the two adjacent bytes32 commitments carries exactly the same
    /// multiset of values as the honest one, so only their order tells them apart. None of the
    /// tampered-field tests above shows that - each of them changes a value. This one asserts
    /// the swapped-order tuple hashes differently from the stored one, then that the contract
    /// rejects it with that precise hash.
    ///
    /// What it does NOT cover, despite the shape of the mistake it imitates: the field order
    /// inside contracts/Escrow.sol's own digest and tuple encodings. Both sides of the comparison
    /// here are built by this file, so a consistent transposition in the contract would keep it
    /// green. Nor does test_deposit_storesBothCommitmentHashes cover the tuple order: that test
    /// compares getDepositHash() against _expectedActiveDepositHash(), which assembles the
    /// ActiveDeposit struct HERE - a mirror of the contract, not a check on it.
    ///
    /// Both encodings are pinned out of band elsewhere in this tree instead: the release/refund
    /// digest order in Escrow.canonicalDigest.t.sol, and the deposit-witness encode order in
    /// Escrow.canonicalDepositDigest.t.sol, whose PINNED_DEPOSIT_WITNESS_HASH was derived outside
    /// this package and is accepted or rejected by a real Permit2 recovery.
    function test_refund_revertsOnSwappedCommitmentHashes() public {
        bytes32 depositId = _deposit(1, REQUEST_HASH, DESTINATION);

        bytes32 destinationHash = keccak256(bytes(DESTINATION));
        // destinationHash and depositRequestHash exchanged.
        bytes32 swappedHash = _rebuiltHash(destinationHash, REQUEST_HASH);

        assertTrue(
            swappedHash != s_escrow.getDepositHash(depositId),
            "exchanging depositRequestHash and destinationHash left the stored commitment unchanged: the ActiveDeposit encoding is not position-sensitive"
        );

        IEscrow.RefundWitness memory witness = _refundWitnessFor(depositId, destinationHash, REQUEST_HASH);

        _expectInvalidWitnessValues(depositId, swappedHash);
        _refund(witness);
    }

    // ---- batch: two deposits with DIFFERENT destinations, settled ----
    //
    // `destinationHash` is per-deposit state, and `depositMany` writes it inside a loop that caches
    // the token config across items. Everything above exercises one deposit at a time, so nothing
    // showed that two deposits in the SAME transaction keep their own destination commitment all the
    // way through settlement. These two tests do: the first settles both, the second requires the
    // pairing to be exact by crossing the two commitments over.
    //
    // The two destinations are DESTINATION and OTHER_DESTINATION, which
    // test_fixtureValues_areDistinctFromTheSharedHelperDefaults already keeps distinct from each
    // other and from the shared helper default — so there is no fixture-distinctness assertion here.

    function _depositManyWithBothDestinations() private returns (bytes32[] memory depositIds) {
        IEscrow.DepositInput[] memory depositInputs = new IEscrow.DepositInput[](2);
        depositInputs[0] = _buildDepositInput(1, REQUEST_HASH, DESTINATION);
        depositInputs[1] = _buildDepositInput(2, REQUEST_HASH, OTHER_DESTINATION);
        return s_escrow.depositMany(depositInputs);
    }

    function _refundInputFor(IEscrow.RefundWitness memory witness) private view returns (IEscrow.RefundInput memory) {
        return IEscrow.RefundInput({
            refundWitness: witness,
            refundSignature: _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey)
        });
    }

    /// CORE-2120: a `depositMany()` of two deposits that differ ONLY in destination stores two
    /// different commitments, and `refundMany()` clears BOTH and pays the depositor for both.
    /// Refund is the escape hatch and this escrow has no rescue function, so the batch leg has to be
    /// shown surviving the new fields too, not just the single leg.
    ///
    /// Each stored hash is asserted against the tuple built from THAT item's destination, which is
    /// what pins the per-item pairing: an implementation that wrote the first item's destinationHash
    /// for both would satisfy a "the two hashes differ" check only by accident, and would fail here.
    function test_depositMany_twoDistinctDestinations_bothStoredAndBothRefunded() public {
        bytes32[] memory depositIds = _depositManyWithBothDestinations();

        assertEq(
            s_escrow.getDepositHash(depositIds[0]),
            _expectedActiveDepositHash(REQUEST_HASH, DESTINATION),
            "the first batch deposit did not store its own destination commitment"
        );
        assertEq(
            s_escrow.getDepositHash(depositIds[1]),
            _expectedActiveDepositHash(REQUEST_HASH, OTHER_DESTINATION),
            "the second batch deposit did not store its own destination commitment"
        );
        assertTrue(
            s_escrow.getDepositHash(depositIds[0]) != s_escrow.getDepositHash(depositIds[1]),
            "two deposits differing only in destination stored the same commitment: destination is not per-deposit state on the batch path"
        );

        uint256 depositorBalanceBefore = s_token.balanceOf(depositor);

        IEscrow.RefundInput[] memory refundInputs = new IEscrow.RefundInput[](2);
        refundInputs[0] = _refundInputFor(_refundWitnessFor(depositIds[0], REQUEST_HASH, keccak256(bytes(DESTINATION))));
        refundInputs[1] =
            _refundInputFor(_refundWitnessFor(depositIds[1], REQUEST_HASH, keccak256(bytes(OTHER_DESTINATION))));

        s_escrow.refundMany(refundInputs);

        assertEq(s_escrow.getDepositHash(depositIds[0]), bytes32(0), "the first batch deposit was not cleared");
        assertEq(s_escrow.getDepositHash(depositIds[1]), bytes32(0), "the second batch deposit was not cleared");
        assertEq(
            s_token.balanceOf(depositor),
            depositorBalanceBefore + DEPOSIT_AMOUNT * 2,
            "the depositor was not made whole for BOTH batch deposits"
        );
    }

    /// The pairing has to be exact: swapping the two items' `destinationHash` values between their
    /// witnesses - each one still a destination the depositor really committed to, in the same
    /// transaction, with every other field untouched - must be rejected. `refundMany` processes
    /// index 0 first, so the reported payload is that item's: the stored commitment versus the tuple
    /// rebuilt with the OTHER item's destinationHash.
    function test_refundMany_crossedDestinationHashes_revert() public {
        bytes32[] memory depositIds = _depositManyWithBothDestinations();

        IEscrow.RefundInput[] memory refundInputs = new IEscrow.RefundInput[](2);
        refundInputs[0] =
            _refundInputFor(_refundWitnessFor(depositIds[0], REQUEST_HASH, keccak256(bytes(OTHER_DESTINATION))));
        refundInputs[1] = _refundInputFor(_refundWitnessFor(depositIds[1], REQUEST_HASH, keccak256(bytes(DESTINATION))));

        _expectInvalidWitnessValues(depositIds[0], _rebuiltHash(REQUEST_HASH, keccak256(bytes(OTHER_DESTINATION))));
        s_escrow.refundMany(refundInputs);
    }
}
