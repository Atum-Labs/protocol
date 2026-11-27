// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {Escrow} from "../src/Escrow.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {LocalPermit2} from "./helpers/LocalPermit2.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
import {SignatureVerification} from "permit2/src/libraries/SignatureVerification.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockToken} from "./mock/MockToken.sol";
import {DeployCoreContracts} from "../script/deploy/DeployCoreContracts.s.sol";
import {TestHelpers} from "./helpers/TestHelpers.sol";

/// @notice CORE-2120: the depositor's commitment to `destination` and `depositRequestHash`,
/// from the DepositWitness through storage and back out through both settlement paths.
/// @dev The pinning tests need no chain state (they hash type strings and read src/Escrow.sol);
/// everything else is a mainnet-fork test exercising the real
/// deposit() path against the live Permit2 (same fixture shape as Escrow.depositFlow.t.sol),
/// so a broken witness type string/struct hash surfaces as InvalidSigner here too.
contract EscrowDestinationCommitmentTest is Test, TestHelpers {
    using SafeERC20 for IERC20;

    bytes32 private constant EXPECTED_DEPOSIT_WITNESS_TYPE_HASH =
        0x49bfb2c307c3a42001389497e5f5b9dc592052768c1f3cdf09aac3c58ec582b9;

    uint256 private constant DEPOSIT_AMOUNT = 1000e18;

    /// @dev Non-zero protocol fee, so `feeAmount` is a load-bearing term of both rebuilt
    /// ActiveDeposit tuples and of the release balance assertion. At a zero fee every feeAmount
    /// word is trivially zero and a dropped or misplaced fee term would go unnoticed.
    /// 0.02% of DEPOSIT_AMOUNT = 0.2e18; the $25 cap is deliberately not binding.
    uint88 private constant FEE_PERCENTAGE = 0.02e6;
    uint80 private constant MAX_FEE = 25e6;

    /// @dev The widest destination the contract accepts. Hashing the destination into storage
    /// instead of keeping the plaintext is what makes this width free downstream, so both
    /// settlement legs are exercised at it, not just the deposit leg.
    uint256 private constant MAX_DESTINATION_BYTES = 256;

    /// @dev Distinct from Signatures.sol's DEFAULT_* so these tests never accidentally pass
    /// because the fixture default happened to be the value under test. Enforced, not merely
    /// claimed, by test_fixtureValues_areDistinctFromTheSharedHelperDefaults below: DESTINATION
    /// was byte-identical to DEFAULT_DESTINATION when this comment was first written, which
    /// made exactly the vacuous pass it warns about possible.
    bytes32 private constant REQUEST_HASH = keccak256("request-content");
    // Both destinations are ARBITRARY byte strings chosen to exercise commitment behavior and are
    // NOT canonical-form examples (mixed-case hex) — copy from
    // test/Destination.canonicalExamples.t.sol instead.
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

    // Deliberately NO `test_depositWitnessTypeHash_isPinned`: it hashed a type string written in
    // this file and compared the result with a literal written in this file, with no tie to src/ at
    // all — two halves of the same edit agreeing with each other. Its assertion is also the FIRST
    // assertion of test_depositWitness_fullTypeStringInEscrowSourceMatchesTypeHash below, which adds
    // the missing tie by requiring src/Escrow.sol's own FULL_DEPOSIT_WITNESS_TYPE_STRING to embed
    // that exact type string. The typehash literal itself is tied to src/Escrow.sol's declared
    // constant, and the type string to the struct DECLARATION in src/interfaces/IEscrow.sol, in
    // test/EncodingExamples.verify.t.sol.

    /// @dev Ties the DepositWitness member list to the contract's OWN Permit2 witness type
    /// string. Permit2 hashes FULL_DEPOSIT_WITNESS_TYPE_STRING out of src/Escrow.sol at runtime
    /// while Escrow hashes the witness values with DEPOSIT_WITNESS_TYPE_HASH: if the two ever
    /// disagree on the member list or its order, every deposit reverts InvalidSigner. The
    /// typehash literal is tied to Escrow.sol's declaration in
    /// test/EncodingExamples.verify.t.sol, but nothing checked the full type string it has to
    /// agree with - and an assertion over a locally built struct never could.
    function test_depositWitness_fullTypeStringInEscrowSourceMatchesTypeHash() public {
        string memory canonical =
            "DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)";

        assertEq(
            keccak256(bytes(canonical)),
            EXPECTED_DEPOSIT_WITNESS_TYPE_HASH,
            "canonical DepositWitness type string no longer hashes to the pinned typehash"
        );

        assertTrue(
            vm.contains(
                vm.readFile("src/Escrow.sol"),
                string.concat("DepositWitness witness)", canonical, "TokenPermissions(address token,uint256 amount)")
            ),
            "src/Escrow.sol's FULL_DEPOSIT_WITNESS_TYPE_STRING no longer embeds the canonical 4-member DepositWitness type string in order - Permit2 hashes that string at runtime, so every deposit would revert InvalidSigner"
        );
    }

    /// @dev Makes the "distinct from the shared helper defaults" claim above enforceable. If a
    /// fixture value collides with Signatures.sol's default, a test meant to prove a value
    /// travels end to end can pass on the default instead.
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
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol.
        s_permit2 = LocalPermit2.etch();

        MockToken mockToken = new MockToken("Test Token", "TEST");
        s_token = IERC20(address(mockToken));

        DeployCoreContracts deployCoreContracts = new DeployCoreContracts();
        (s_escrow,) = deployCoreContracts.run();

        address tokenConfig = makeAddr("destinationCommitmentTokenConfig");
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), tokenConfig);

        vm.startPrank(tokenConfig);
        // Non-zero fee on purpose: see FEE_PERCENTAGE.
        s_escrow.allowTokenAndSetFeeConfig(s_token, 18, FEE_PERCENTAGE, 0, MAX_FEE);
        vm.stopPrank();

        uint256 feeAmount = _feeAmount();
        assertTrue(feeAmount != 0, "protocol fee is zero; the feeAmount term of every rebuilt tuple is vacuous");
        assertTrue(feeAmount < DEPOSIT_AMOUNT, "the fee must leave a non-zero release payout to assert on");

        (depositor, depositorPrivateKey) = makeAddrAndKey("destinationCommitmentDepositor");
        (reserver, reserverPrivateKey) = makeAddrAndKey("destinationCommitmentReserver");
        (releaser, releaserPrivateKey) = makeAddrAndKey("destinationCommitmentReleaser");
        settler = makeAddr("destinationCommitmentSettler");

        deal(address(s_token), depositor, DEPOSIT_AMOUNT * 1000);

        vm.startPrank(depositor);
        s_token.forceApprove(address(s_permit2), type(uint256).max);
        vm.stopPrank();
    }

    function _buildDepositInput(uint256 nonce, bytes32 depositRequestHash, string memory destination)
        private
        view
        returns (IEscrow.DepositInput memory depositInput)
    {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) = _constructDepositPermitWitness(
            address(s_token), DEPOSIT_AMOUNT, reserver, releaser, nonce, depositRequestHash, destination
        );

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
    /// substitution shows up as InvalidSigner. Permanent regression: this held only
    /// transiently in review and a source mutation was needed to prove it at all.
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
    // matching the convention for this code path elsewhere in the suite: the reverting require
    // also reports the two hashes it compared, and pinning those shows the rejection came from
    // the tampered field and not from some unrelated reconstruction difference that happens to
    // raise the same error.

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
    /// inside src/Escrow.sol's own digest and tuple encodings. Both sides of the comparison
    /// here are built by this file, so a consistent transposition in the contract would keep it
    /// green. Nor does test_deposit_storesBothCommitmentHashes cover the tuple order, as an
    /// earlier version of this comment claimed: that test compares getDepositHash() against
    /// _expectedActiveDepositHash(), which assembles the ActiveDeposit struct HERE - a mirror of
    /// the contract, not a check on it.
    ///
    /// Both encodings are pinned out of band in test/Escrow.canonicalDigest.t.sol instead: the
    /// digest value order by signing hardcoded digest literals derived from the canonical type
    /// strings, and the stored-tuple field order by two ActiveDeposit hash literals - the read
    /// side (seeded before release/refund) and the write side (asserted against what deposit()
    /// stores). test/EncodingExamples.contractBound.t.sol is the second, independent detector.
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
