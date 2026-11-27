// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IPermit2} from "@alexroan/permit2-tron/contracts/interfaces/IPermit2.sol";
import {ISignatureTransfer} from "@alexroan/permit2-tron/contracts/interfaces/ISignatureTransfer.sol";
import {Escrow} from "../contracts/Escrow.sol";
import {IEscrow} from "../contracts/interfaces/IEscrow.sol";
import {TestHelpers} from "./helpers/TestHelpers.sol";
import {LocalPermit2} from "./helpers/LocalPermit2.sol";
import {DeployCoreContracts} from "../foundry_scripts/DeployCoreContracts.s.sol";
import {MockToken6Decimals, MockToken6DecimalsTransferReturnsFalse} from "./mock/MockToken.sol";

// ====================================================================================
//  THE bytes32 TOPIC0 LITERALS IN THIS FILE MUST NOT BE REGENERATED FROM THIS REPOSITORY.
//
//  Each one is keccak256 of the canonical event signature string, computed OUTSIDE this repo. Their
//  value as a guard comes entirely from that provenance. Do NOT "fix" a failing one by pasting the
//  value the assertion printed, and do NOT derive one by hashing a signature string written in this
//  file: either turns the literal into a mirror of the code it is supposed to check.
//
//  Nothing here hashes a signature string at all. Every assertion compares a pinned literal with a
//  topic0 THE COMPILER derived from the event declaration in contracts/interfaces/IEscrow.sol and
//  the contract actually emitted.
//
//  There is already a topic0 guard next door — ../bindings/go/escrow-encoding/encoding/event_topic0_test.go,
//  whose golden holds these same seven values — but it derives them from the source-extracted ABI.
//  That catches a changed declaration; it cannot catch an emit that was added, removed, reordered,
//  or moved between the single and batch paths, because no log ever enters it. This file closes
//  that half: the tie is to the EMITTED LOG.
// ====================================================================================

/// @notice CORE-2120 on Tron: `DepositCommitments` — log-only recoverability of the two commitment
/// hashes, and the event-ABI shape of everything around it, PINNED.
///
/// @dev Two properties are enforced here.
///
/// 1. LOG-ONLY RECOVERABILITY. `Deposited` deliberately carries neither `depositRequestHash` nor
///    `destinationHash` — two of the eleven members of both settlement witnesses — so its topic0 and
///    decode layout stay stable for anything already filtering on it. Without `DepositCommitments` a
///    releaser that indexes logs could not assemble a `RefundWitness` on the single-deposit path, and
///    refund is the escape hatch: this escrow has NO rescue function, and on Tron there is no
///    fallback recovery route at all. The tests below do a real `deposit()`, then build the
///    settlement witness from values DECODED OUT OF THE EMITTED LOGS — never from this file's fixture
///    variables — and require the settlement to succeed. Restating the property with fixture values
///    would prove nothing: mutate the emitted `destinationHash` to `bytes32(0)` in contracts/Escrow.sol
///    and `test_logsAlone_rebuildARefundWitness_andRefundSucceeds` must fail.
///
///    The BATCH path is covered separately, and it is NOT the same procedure.
///    `test_depositMany_logsAlone_rebuildRefundWitnesses_andRefundManySucceeds` executes it:
///    `DepositedMany` yields only nine of the eleven members, and `depositor` and `token` have to come
///    from each item's TRC-20 `Transfer` log (its `topics[1]` and its emitter). The negative half,
///    `test_depositMany_depositedManyAlone_cannotCompleteARefundWitness`, shows that a consumer that
///    reads only `DepositedMany` cannot complete the witness at all.
///
/// 2. EVENT ABI PINNING. Every deposit/settlement entry point is invoked with logs recorded, and the
///    topic0s the ESCROW emitted are asserted, in order and by exact count, against out-of-band
///    literals. Asserting the COUNT is what makes "only the new event appeared" checkable: an extra
///    emit, a removed emit, a reordered pair, or a field added to any existing event all fail here.
///
///    Every literal below is BYTE-IDENTICAL to the one the EVM escrow emits, and that is a property
///    worth failing on rather than a coincidence: the two contracts declare the same events over the
///    same tuples, so one indexer generation serves both chains. If the TVM interface ever drifted —
///    a member added to a witness struct, a parameter reordered — these assertions fail here, on the
///    chain where the drift happened, instead of surfacing as a Tron deposit the EVM-shaped scanner
///    silently never sees.
///
/// @dev NO FORK. Permit2 is etched locally by helpers/LocalPermit2.sol, so this suite passes with no
/// RPC env var set. The deposit leg is still the real one — real Permit2, real signature recovery —
/// which is what a log-completeness claim about `deposit()` needs: it is only worth as much as the
/// `deposit()` that produced the logs.
contract EscrowCommitmentEventsTest is Test, TestHelpers {
    // ---- out-of-band topic0 literals (see the banner above) ----

    /// @dev keccak256("DepositCommitments(bytes32,bytes32,bytes32)")
    bytes32 private constant DEPOSIT_COMMITMENTS_TOPIC0 =
        0xdd71cfeda84126f075a6e6c4e6aacadc514806a79f1bccb0619818b7736eefc5;
    /// @dev keccak256("Deposited(bytes32,bytes32,address,address,address,uint256,uint256,address,address)")
    bytes32 private constant DEPOSITED_TOPIC0 = 0x00d99cb530e2d4ecb11da22fd966de4bd68000fdbc6b822f902163642404000e;
    /// @dev keccak256("DepositedMany(bytes32[],(bytes32,string,address,address)[],(bytes32,bytes32,address,uint256)[],uint256[])")
    bytes32 private constant DEPOSITED_MANY_TOPIC0 = 0x837f538e17106ab6df4c0f8a1de4e8127c1dc86827e956daebf9942a0406e2d0;
    /// @dev keccak256("Released(bytes32,address,address,uint256,uint256)")
    bytes32 private constant RELEASED_TOPIC0 = 0x703d1f677dc7a240b8578621df4ac5a0d8323e943fcc50ce0ffd9dcc8f6974cc;
    /// @dev keccak256("ReleasedMany((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address)[])")
    bytes32 private constant RELEASED_MANY_TOPIC0 = 0x63ae99db9a784d0cfddbfc24a172533fca09ed92f286131b04742dbceac30016;
    /// @dev keccak256("Refunded(bytes32,address,address,uint256)")
    bytes32 private constant REFUNDED_TOPIC0 = 0x2e0668a62a5f556368dca9c7113e20f2852c05155548243804bf714ce72b25a6;
    /// @dev keccak256("RefundedMany((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address)[])")
    bytes32 private constant REFUNDED_MANY_TOPIC0 = 0x949fa5cc9abe2cf38fdd057482e67cc01d31361a8981e80cc0ac93396ecfa801;

    /// @dev keccak256("Transfer(address,address,uint256)") — the TRC-20/ERC-20 standard's Transfer
    /// topic0. Not an escrow event: it is the only place `depositor` and `token` are recoverable from
    /// the logs of a `depositMany()` transaction (see the batch recovery test below). This value is
    /// published by EIP-20 itself and is emitted identically by every TRC-20, so it is out-of-band by
    /// construction rather than by derivation.
    bytes32 private constant ERC20_TRANSFER_TOPIC0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;

    /// @dev Six decimals throughout: Tron USDT has six, and both mocks below report six.
    uint256 private constant DEPOSIT_AMOUNT = 1000e6;

    /// @dev Non-zero protocol fee, so the `feeAmount` word decoded out of `Deposited` is load-bearing
    /// in the rebuilt witness: at a zero fee a dropped or misplaced fee term would still hash to the
    /// stored tuple. 0.02% of DEPOSIT_AMOUNT = 0.2 tokens = 200_000; the $25 cap is not binding.
    uint88 private constant FEE_PERCENTAGE = 0.02e6;
    uint80 private constant MAX_FEE = 25e6;
    uint8 private constant TOKEN_DECIMALS = 6;

    /// @dev Mirror of the contract's private MAX_DESTINATION_BYTES. Pinned for real by the
    /// destination-commitment suite (a revert at cap + 1 and a deposit at exactly the cap); used here
    /// only to emit at the widest accepted preimage.
    uint256 private constant MAX_DESTINATION_BYTES = 256;

    /// @dev Distinct from Signatures.sol's DEFAULT_* — enforced below, not merely claimed. That
    /// matters more here than on EVM: helpers/Signatures.sol's `_constructDepositPermitWitness` has
    /// no parameters for these two fields, so `_buildDepositInputFor` OVERWRITES the defaults it
    /// returns. If either value collided with the default it replaces, the overwrite would be a
    /// no-op and a test meant to prove a value travelled from calldata to a log would pass without
    /// the value ever having travelled.
    bytes32 private constant REQUEST_HASH = keccak256("commitment-events-request-content");
    /// @dev An ARBITRARY byte string chosen to exercise event plumbing. The contract validates the
    /// destination's LENGTH only and is otherwise format-agnostic, so nothing here should be read as
    /// a canonical destination.
    string private constant DESTINATION =
        "tron:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t@TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs";

    Escrow private s_escrow;
    IPermit2 private s_permit2;
    /// @dev Also the escrow's `i_usdt`, and deliberately the returns-false mock. On Tron a SUCCESSFUL
    /// USDT transfer returns false, so every payout for this token goes through `Escrow._usdtTransfer`
    /// rather than SafeERC20 — which means the release and refund legs of the log-only reconstruction
    /// exercise the payout path Tron actually runs, not a generic-token one.
    MockToken6DecimalsTransferReturnsFalse private s_token;
    /// @dev Kept so the batch recovery test can allowlist a SECOND token: that test needs the two
    /// items of one `depositMany()` to carry different tokens, which is what makes the `token` decoded
    /// from each item's TRC-20 `Transfer` log load-bearing.
    address private s_tokenConfigAdmin;

    address private depositor;
    uint256 private depositorPrivateKey;
    address private reserver;
    uint256 private reserverPrivateKey;
    address private releaser;
    uint256 private releaserPrivateKey;
    address private settler;

    function setUp() public {
        // Real Permit2, no RPC: see foundry_tests/helpers/LocalPermit2.sol. Nothing in this suite
        // reads any other chain state.
        s_permit2 = LocalPermit2.etch();

        s_token = new MockToken6DecimalsTransferReturnsFalse("Test Token", "TEST");

        // The TVM escrow takes the USDT address in its constructor; passing this suite's primary token
        // is what puts the single-deposit tests on the `_usdtTransfer` payout path.
        DeployCoreContracts deployCoreContracts = new DeployCoreContracts();
        (s_escrow,) = deployCoreContracts.run(IERC20(address(s_token)));

        s_tokenConfigAdmin = makeAddr("commitmentEventsTokenConfig");
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), s_tokenConfigAdmin);

        // Non-zero fee on purpose: see FEE_PERCENTAGE.
        _allowlistToken(IERC20(address(s_token)));

        uint256 feeAmount = _feeAmount();
        assertTrue(feeAmount != 0, "protocol fee is zero; the feeAmount word of every rebuilt tuple is vacuous");
        assertTrue(feeAmount < DEPOSIT_AMOUNT, "the fee must leave a non-zero release payout to assert on");

        (depositor, depositorPrivateKey) = makeAddrAndKey("commitmentEventsDepositor");
        (reserver, reserverPrivateKey) = makeAddrAndKey("commitmentEventsReserver");
        (releaser, releaserPrivateKey) = makeAddrAndKey("commitmentEventsReleaser");
        settler = makeAddr("commitmentEventsSettler");

        s_token.mint(depositor, DEPOSIT_AMOUNT * 1000);
        vm.prank(depositor);
        s_token.approve(address(s_permit2), type(uint256).max);
    }

    /// @dev Makes the "distinct from the shared helper defaults" claim above enforceable.
    function test_fixtureValues_areDistinctFromTheSharedHelperDefaults() public pure {
        assertTrue(
            keccak256(bytes(DESTINATION)) != keccak256(bytes(DEFAULT_DESTINATION)),
            "DESTINATION equals Signatures.sol's DEFAULT_DESTINATION; the destinationHash assertions can pass vacuously"
        );
        assertTrue(
            REQUEST_HASH != DEFAULT_DEPOSIT_REQUEST_HASH,
            "REQUEST_HASH equals Signatures.sol's DEFAULT_DEPOSIT_REQUEST_HASH"
        );
    }

    // ---- fixture plumbing ----

    function _feeAmount() private view returns (uint256) {
        return s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig(IERC20(address(s_token))));
    }

    function _allowlistToken(IERC20 token) private {
        vm.prank(s_tokenConfigAdmin);
        s_escrow.allowTokenAndSetFeeConfig(token, TOKEN_DECIMALS, FEE_PERCENTAGE, 0, MAX_FEE);
    }

    /// @dev Everything that varies between the deposits this file builds. Grouped into a struct so the
    /// batch test can vary the depositor, the token and the charged amount per item without four more
    /// positional parameters on the builder.
    struct DepositFixture {
        uint256 nonce;
        bytes32 depositRequestHash;
        string destination;
        address depositorAddr;
        uint256 depositorKey;
        address token;
        /// @dev The reserver-attested charge. `permitAmount` is only the authorization ceiling.
        uint256 sourceAmount;
        uint256 permitAmount;
    }

    function _buildDepositInput(uint256 nonce, bytes32 depositRequestHash, string memory destination)
        private
        view
        returns (IEscrow.DepositInput memory depositInput)
    {
        return _buildDepositInputFor(
            DepositFixture({
                nonce: nonce,
                depositRequestHash: depositRequestHash,
                destination: destination,
                depositorAddr: depositor,
                depositorKey: depositorPrivateKey,
                token: address(s_token),
                sourceAmount: DEPOSIT_AMOUNT,
                permitAmount: DEPOSIT_AMOUNT
            })
        );
    }

    function _buildDepositInputFor(DepositFixture memory fixture)
        private
        view
        returns (IEscrow.DepositInput memory depositInput)
    {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _constructDepositPermitWitness(fixture.token, fixture.permitAmount, reserver, releaser, fixture.nonce);

        // helpers/Signatures.sol's builder hard-codes DEFAULT_DEPOSIT_REQUEST_HASH and
        // DEFAULT_DESTINATION; it takes no parameters for the two fields this whole file is about.
        // They are overwritten HERE rather than by hand-rolling the permit, so the signature is still
        // produced by the shared `_constructDepositSignature`, which hashes the witness it is handed —
        // an inlined witness hash would diverge silently if the type string ever changed.
        depositWitness.depositRequestHash = fixture.depositRequestHash;
        depositWitness.destination = fixture.destination;

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), fixture.depositorKey);

        // Shared helper on purpose: an inlined keccak256(abi.encode(depositor, signature, nonce)) here
        // would silently diverge if the depositId formula ever changes.
        bytes32 depositId = expectedDepositId(permit, fixture.depositorAddr, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness =
            _constructReserveWitness(depositId, DEFAULT_QUOTE_HASH, settler, fixture.sourceAmount);

        depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: fixture.depositorAddr,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey)
        });
    }

    /// @dev ARBITRARY length probe ("a" repeated), NOT a canonical-form destination.
    function _destinationOfLength(uint256 length) private pure returns (string memory) {
        bytes memory destination = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            destination[i] = "a";
        }
        return string(destination);
    }

    /// @dev Records logs, deposits, and hands back everything the escrow emitted.
    ///
    /// The input is built BEFORE `vm.recordLogs()` and before any submission for the same reason the
    /// rest of this tree builds before `vm.expectRevert`: constructing it calls
    /// `permit2.DOMAIN_SEPARATOR()`, and a cheatcode that binds to the NEXT call would bind to that.
    function _depositRecordingLogs(uint256 nonce, bytes32 depositRequestHash, string memory destination)
        private
        returns (bytes32 depositId, Vm.Log[] memory escrowLogs)
    {
        IEscrow.DepositInput memory depositInput = _buildDepositInput(nonce, depositRequestHash, destination);
        vm.recordLogs();
        depositId = s_escrow.deposit(depositInput);
        escrowLogs = _escrowLogs(vm.getRecordedLogs());
    }

    // ---- log plumbing ----

    /// @dev Every recorded log emitted BY THE ESCROW, in emission order. Filtering by EMITTER rather
    /// than by an expected topic list is deliberate: a filter that keeps only known topic0s would let
    /// a new or renamed escrow event slip past the count assertions below.
    function _escrowLogs(Vm.Log[] memory logs) private view returns (Vm.Log[] memory escrowLogs) {
        uint256 count;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(s_escrow)) count++;
        }
        escrowLogs = new Vm.Log[](count);
        uint256 next;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(s_escrow)) {
                escrowLogs[next] = logs[i];
                next++;
            }
        }
    }

    /// @dev Asserts the escrow emitted EXACTLY `expectedTopic0s`, in that order. The length check is
    /// the half that makes "only the new event appeared" falsifiable.
    function _assertEscrowTopic0s(Vm.Log[] memory escrowLogs, bytes32[] memory expectedTopic0s, string memory context)
        private
        pure
    {
        assertEq(
            escrowLogs.length,
            expectedTopic0s.length,
            string.concat(
                context,
                " emitted a different NUMBER of escrow logs than expected: an emit was added, removed or moved between the single and batch paths"
            )
        );
        for (uint256 i; i < expectedTopic0s.length; i++) {
            assertEq(
                escrowLogs[i].topics[0],
                expectedTopic0s[i],
                string.concat(
                    context,
                    " log #",
                    vm.toString(i),
                    " has an unexpected topic0: the event's parameter list or name changed, or the emits were reordered. These values are shared with the EVM escrow and with the committed Go topic0 golden - re-derive OUT OF BAND before touching this literal"
                )
            );
        }
    }

    function _topic0s(bytes32 a) private pure returns (bytes32[] memory topics) {
        topics = new bytes32[](1);
        topics[0] = a;
    }

    function _topic0s(bytes32 a, bytes32 b) private pure returns (bytes32[] memory topics) {
        topics = new bytes32[](2);
        topics[0] = a;
        topics[1] = b;
    }

    /// @dev The one escrow log carrying `topic0`. Fails if it is missing or duplicated.
    function _uniqueLog(Vm.Log[] memory escrowLogs, bytes32 topic0, string memory name)
        private
        pure
        returns (Vm.Log memory found)
    {
        uint256 count;
        for (uint256 i; i < escrowLogs.length; i++) {
            if (escrowLogs[i].topics[0] == topic0) {
                found = escrowLogs[i];
                count++;
            }
        }
        assertEq(count, 1, string.concat("expected exactly one ", name, " log from the escrow"));
    }

    function _countLogs(Vm.Log[] memory escrowLogs, bytes32 topic0) private pure returns (uint256 count) {
        for (uint256 i; i < escrowLogs.length; i++) {
            if (escrowLogs[i].topics[0] == topic0) count++;
        }
    }

    // ---- the log-only reconstruction ----

    /// @dev Everything a Release/RefundWitness needs, decoded from LOGS ONLY.
    struct LoggedDeposit {
        bytes32 depositId;
        bytes32 quoteHash;
        bytes32 depositRequestHash;
        bytes32 destinationHash;
        address depositor;
        address token;
        uint256 amount;
        uint256 feeAmount;
        address reserver;
        address releaser;
        address settler;
    }

    /// @dev THE point of this file: an offchain consumer's view of a deposit, reconstructed from the
    /// emitted logs and nothing else. The two commitments come from `DepositCommitments`; every other
    /// member comes from the flat `Deposited`. No fixture variable and no calldata is read.
    function _decodeFromLogsOnly(Vm.Log[] memory escrowLogs) private view returns (LoggedDeposit memory logged) {
        Vm.Log memory deposited = _uniqueLog(escrowLogs, DEPOSITED_TOPIC0, "Deposited");
        assertEq(deposited.topics.length, 4, "Deposited no longer has 3 indexed parameters");
        logged.depositId = deposited.topics[1];
        logged.quoteHash = deposited.topics[2];
        // Safe: an indexed `address` topic is the left-padded 20-byte value.
        logged.depositor = address(uint160(uint256(deposited.topics[3])));
        (logged.settler, logged.token, logged.amount, logged.feeAmount, logged.reserver, logged.releaser) =
            abi.decode(deposited.data, (address, address, uint256, uint256, address, address));

        Vm.Log memory commitments = _uniqueLog(escrowLogs, DEPOSIT_COMMITMENTS_TOPIC0, "DepositCommitments");
        assertEq(
            commitments.topics.length,
            2,
            "DepositCommitments no longer indexes exactly one parameter; a consumer cannot filter it by depositId"
        );
        assertEq(
            commitments.topics[1],
            logged.depositId,
            "DepositCommitments cannot be correlated with Deposited: its indexed depositId differs, so a consumer cannot tell which deposit the commitments belong to"
        );
        (logged.depositRequestHash, logged.destinationHash) = abi.decode(commitments.data, (bytes32, bytes32));

        // The witness the consumer is about to build is worthless if the logs left holes in it.
        assertTrue(logged.depositRequestHash != bytes32(0), "depositRequestHash decoded from the logs is zero");
        assertTrue(logged.destinationHash != bytes32(0), "destinationHash decoded from the logs is zero");
        assertTrue(logged.amount != 0, "amount decoded from the logs is zero; the balance assertions would be vacuous");
        assertTrue(logged.feeAmount != 0, "feeAmount decoded from the logs is zero; the fee word is vacuous");
        // A log-only consumer signs with the key of whatever releaser the logs name. This suite can
        // only sign for its fixture releaser, so the two must be the same address.
        assertEq(
            logged.releaser,
            releaser,
            "the releaser decoded from the logs is not the fixture releaser; the signature below would not be one a log-only consumer could produce"
        );
    }

    function _refundWitnessFromLogs(LoggedDeposit memory logged)
        private
        pure
        returns (IEscrow.RefundWitness memory witness)
    {
        witness = IEscrow.RefundWitness({
            depositId: logged.depositId,
            quoteHash: logged.quoteHash,
            depositRequestHash: logged.depositRequestHash,
            destinationHash: logged.destinationHash,
            depositor: logged.depositor,
            token: logged.token,
            amount: logged.amount,
            feeAmount: logged.feeAmount,
            reserver: logged.reserver,
            releaser: logged.releaser,
            settler: logged.settler
        });
    }

    function _releaseWitnessFromLogs(LoggedDeposit memory logged)
        private
        pure
        returns (IEscrow.ReleaseWitness memory witness)
    {
        witness = IEscrow.ReleaseWitness({
            depositId: logged.depositId,
            quoteHash: logged.quoteHash,
            depositRequestHash: logged.depositRequestHash,
            destinationHash: logged.destinationHash,
            depositor: logged.depositor,
            token: logged.token,
            amount: logged.amount,
            feeAmount: logged.feeAmount,
            reserver: logged.reserver,
            releaser: logged.releaser,
            settler: logged.settler
        });
    }

    /// CORE-2120 KEY TEST: a consumer that has only the logs of a `deposit()` transaction can execute
    /// a refund. Refund is the escape hatch and this escrow has no rescue function, so "the releaser
    /// can always construct a refund" is the property that matters most.
    ///
    /// The witness is assembled EXCLUSIVELY from decoded log data - that is what makes this a proof
    /// rather than a restatement. If `DepositCommitments` carried a wrong `destinationHash` (or a
    /// wrong `depositRequestHash`), the rebuilt tuple would not hash to the stored commitment and the
    /// refund would revert `InvalidWitnessValues`.
    function test_logsAlone_rebuildARefundWitness_andRefundSucceeds() public {
        (, Vm.Log[] memory escrowLogs) = _depositRecordingLogs(1, REQUEST_HASH, DESTINATION);

        LoggedDeposit memory logged = _decodeFromLogsOnly(escrowLogs);
        IEscrow.RefundWitness memory witness = _refundWitnessFromLogs(logged);

        uint256 depositorBalanceBefore = IERC20(logged.token).balanceOf(logged.depositor);

        s_escrow.refund(
            IEscrow.RefundInput({
                refundWitness: witness,
                refundSignature: _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey)
            })
        );

        assertEq(s_escrow.getDepositHash(logged.depositId), bytes32(0), "deposit not cleared by the log-built refund");
        assertEq(
            IERC20(logged.token).balanceOf(logged.depositor),
            depositorBalanceBefore + logged.amount,
            "depositor was not made whole by the log-built refund"
        );
    }

    /// Release counterpart. `ReleaseWitness` and `RefundWitness` have identical member lists but are
    /// distinct types with distinct typehashes, verified against distinct signatures, so the refund
    /// test above does not cover this path.
    function test_logsAlone_rebuildAReleaseWitness_andReleaseSucceeds() public {
        (, Vm.Log[] memory escrowLogs) = _depositRecordingLogs(1, REQUEST_HASH, DESTINATION);

        LoggedDeposit memory logged = _decodeFromLogsOnly(escrowLogs);
        IEscrow.ReleaseWitness memory witness = _releaseWitnessFromLogs(logged);

        uint256 settlerBalanceBefore = IERC20(logged.token).balanceOf(logged.settler);

        s_escrow.release(
            IEscrow.ReleaseInput({
                releaseWitness: witness,
                releaseSignature: _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey)
            })
        );

        assertEq(s_escrow.getDepositHash(logged.depositId), bytes32(0), "deposit not cleared by the log-built release");
        assertEq(
            IERC20(logged.token).balanceOf(logged.settler),
            settlerBalanceBefore + logged.amount - logged.feeAmount,
            "settler did not receive amount - feeAmount from the log-built release"
        );
    }

    /// The same reconstruction at the widest destination the contract accepts. Emitting the HASH
    /// rather than the plaintext is what makes the preimage width irrelevant to the log payload; this
    /// is the test that would notice if that stopped being true.
    function test_logsAlone_rebuildARefundWitness_atMaxDestinationLength() public {
        string memory maxLen = _destinationOfLength(MAX_DESTINATION_BYTES);
        (, Vm.Log[] memory escrowLogs) = _depositRecordingLogs(1, REQUEST_HASH, maxLen);

        LoggedDeposit memory logged = _decodeFromLogsOnly(escrowLogs);
        assertEq(
            logged.destinationHash,
            keccak256(bytes(maxLen)),
            "DepositCommitments did not carry keccak256 of the 256-byte destination"
        );

        IEscrow.RefundWitness memory witness = _refundWitnessFromLogs(logged);
        uint256 depositorBalanceBefore = IERC20(logged.token).balanceOf(logged.depositor);

        s_escrow.refund(
            IEscrow.RefundInput({
                refundWitness: witness,
                refundSignature: _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey)
            })
        );

        assertEq(s_escrow.getDepositHash(logged.depositId), bytes32(0), "deposit not cleared by the log-built refund");
        assertEq(
            IERC20(logged.token).balanceOf(logged.depositor),
            depositorBalanceBefore + logged.amount,
            "depositor was not made whole for a 256-byte destination"
        );
    }

    // ---- the event's own payload ----

    /// CORE-2120: `DepositCommitments` carries the depositId it belongs to and the exact two
    /// commitment hashes the depositor signed - `destinationHash` as keccak256(bytes(destination)),
    /// which is the form both settlement witnesses and `ActiveDeposit` use.
    function test_depositCommitments_carriesTheCommittedValues() public {
        (bytes32 depositId, Vm.Log[] memory escrowLogs) = _depositRecordingLogs(1, REQUEST_HASH, DESTINATION);

        Vm.Log memory commitments = _uniqueLog(escrowLogs, DEPOSIT_COMMITMENTS_TOPIC0, "DepositCommitments");

        assertEq(commitments.topics.length, 2, "DepositCommitments must index exactly `depositId`");
        assertEq(commitments.topics[1], depositId, "DepositCommitments indexed the wrong depositId");
        assertEq(commitments.data.length, 64, "DepositCommitments data must be exactly two unindexed bytes32 words");

        // Position-sensitive by construction: `data` is decoded POSITIONALLY into (loggedRequestHash,
        // loggedDestinationHash) and each word is then asserted against its own expected value, so a
        // transposed emit fails one of the two assertions below. Deliberately no
        // `loggedRequestHash != loggedDestinationHash` guard for that: the two expected values are
        // keccak256 over distinct fixed preimages, so an equality between them is a keccak collision,
        // not a test defect - the assertion could never fail and would only look like coverage.
        (bytes32 loggedRequestHash, bytes32 loggedDestinationHash) = abi.decode(commitments.data, (bytes32, bytes32));
        assertEq(loggedRequestHash, REQUEST_HASH, "DepositCommitments carried the wrong depositRequestHash");
        assertEq(
            loggedDestinationHash,
            keccak256(bytes(DESTINATION)),
            "DepositCommitments carried a destinationHash that is not keccak256(bytes(destination))"
        );
    }

    /// Same payload assertions at the 256-byte cap, where a `string` variant of this event would have
    /// cost several times the log data - the reason it emits the hash. Log bandwidth is not free on
    /// Tron either: energy is charged per byte of log data.
    function test_depositCommitments_carriesTheCommittedValuesAtMaxDestinationLength() public {
        // Deliberately no `bytes(maxLen).length == MAX_DESTINATION_BYTES` assertion: `maxLen` is
        // _destinationOfLength(MAX_DESTINATION_BYTES), so it is true by construction and could never
        // fail. That the cap really is 256 is pinned for real by the destination-commitment suite
        // (DestinationTooLong at cap + 1, a successful deposit at exactly the cap).
        string memory maxLen = _destinationOfLength(MAX_DESTINATION_BYTES);

        (bytes32 depositId, Vm.Log[] memory escrowLogs) = _depositRecordingLogs(1, REQUEST_HASH, maxLen);

        Vm.Log memory commitments = _uniqueLog(escrowLogs, DEPOSIT_COMMITMENTS_TOPIC0, "DepositCommitments");

        assertEq(commitments.topics[1], depositId, "DepositCommitments indexed the wrong depositId");
        assertEq(
            commitments.data.length, 64, "DepositCommitments data width must not depend on the destination's length"
        );

        (bytes32 loggedRequestHash, bytes32 loggedDestinationHash) = abi.decode(commitments.data, (bytes32, bytes32));
        assertEq(loggedRequestHash, REQUEST_HASH, "DepositCommitments carried the wrong depositRequestHash");
        assertEq(
            loggedDestinationHash,
            keccak256(bytes(maxLen)),
            "DepositCommitments carried a destinationHash that is not keccak256 of the 256-byte destination"
        );
    }

    // ---- the deliberate single-vs-batch asymmetry ----

    /// CORE-2120: `depositMany()` must NOT emit `DepositCommitments`. `DepositedMany` already carries
    /// the whole `DepositWitness[]`, so BOTH COMMITMENTS are in that one log for every item, and a
    /// per-item emit from the shared `_deposit` would pay LOG energy x N to duplicate them.
    /// (`DepositCommitments` carries neither `depositor` nor `token`, so emitting it from the batch
    /// path would not close the two gaps `DepositedMany` does have - see
    /// `test_depositMany_logsAlone_rebuildRefundWitnesses_andRefundManySucceeds`.) This asserts the
    /// asymmetry AND the premise it rests on: the batch log really does carry both commitments for
    /// every item. If that premise ever breaks, this fails and the asymmetry stops being defensible.
    function test_depositMany_doesNotEmitDepositCommitments() public {
        string memory otherDestination = _destinationOfLength(MAX_DESTINATION_BYTES);
        bytes32 otherRequestHash = keccak256("commitment-events-second-request-content");

        IEscrow.DepositInput[] memory depositInputs = new IEscrow.DepositInput[](2);
        depositInputs[0] = _buildDepositInput(1, REQUEST_HASH, DESTINATION);
        depositInputs[1] = _buildDepositInput(2, otherRequestHash, otherDestination);

        vm.recordLogs();
        bytes32[] memory depositIds = s_escrow.depositMany(depositInputs);
        Vm.Log[] memory escrowLogs = _escrowLogs(vm.getRecordedLogs());

        assertEq(
            _countLogs(escrowLogs, DEPOSIT_COMMITMENTS_TOPIC0),
            0,
            "depositMany() emitted DepositCommitments: the emit moved into the shared _deposit and the batch path now pays LOG energy per item to duplicate what DepositedMany already carries"
        );
        // Exactly one escrow log, and it is DepositedMany.
        _assertEscrowTopic0s(escrowLogs, _topic0s(DEPOSITED_MANY_TOPIC0), "depositMany()");

        // The premise of the asymmetry: DepositedMany carries BOTH COMMITMENTS for every item. (It is
        // not log-complete for a witness - it is short of `depositor` and `token`, which is a separate
        // matter and covered by the two batch tests below.)
        (bytes32[] memory loggedIds, IEscrow.DepositWitness[] memory loggedWitnesses,,) =
            abi.decode(escrowLogs[0].data, (bytes32[], IEscrow.DepositWitness[], IEscrow.ReserveWitness[], uint256[]));

        assertEq(loggedIds.length, 2, "DepositedMany did not carry both depositIds");
        assertEq(loggedWitnesses.length, 2, "DepositedMany did not carry both deposit witnesses");
        assertEq(loggedIds[0], depositIds[0], "DepositedMany carried the wrong first depositId");
        assertEq(loggedIds[1], depositIds[1], "DepositedMany carried the wrong second depositId");
        assertEq(
            loggedWitnesses[0].depositRequestHash,
            REQUEST_HASH,
            "DepositedMany's DepositWitness[] lost the first depositRequestHash"
        );
        assertEq(
            keccak256(bytes(loggedWitnesses[0].destination)),
            keccak256(bytes(DESTINATION)),
            "DepositedMany's DepositWitness[] lost the first destination preimage"
        );
        assertEq(
            loggedWitnesses[1].depositRequestHash,
            otherRequestHash,
            "DepositedMany's DepositWitness[] lost the second depositRequestHash"
        );
        assertEq(
            keccak256(bytes(loggedWitnesses[1].destination)),
            keccak256(bytes(otherDestination)),
            "DepositedMany's DepositWitness[] lost the second destination preimage"
        );
    }

    // ---- the batch path's OWN log-only reconstruction ----
    //
    // `DepositedMany(bytes32[] depositIds, DepositWitness[], ReserveWitness[], uint256[] feeAmounts)`
    // yields NINE of the eleven settlement-witness members. `depositor` and `token` are in NONE of its
    // four parameters: `DepositWitness` is {depositRequestHash, destination, reserver, releaser} and
    // `ReserveWitness` is {depositId, quoteHash, settler, sourceAmount}. The token is
    // `permit.permitted.token` and the depositor is `DepositInput.depositor`, neither of which the
    // event carries.
    //
    // They are recoverable from the TRC-20 `Transfer` log the same transaction emits per item: `token`
    // is that log's EMITTER address and `depositor` is its `topics[1]` (the `from`). The documentation
    // for both paths says exactly this; the test below is what makes it checkable. Emitting
    // `DepositCommitments` from `depositMany()` would NOT help, which is why the asymmetry above is
    // not a gap: that event carries neither of the two missing members.

    /// @dev One item of a `depositMany()`, rebuilt from the logs of that transaction ALONE: nine
    /// members from `DepositedMany`, `depositor` + `token` from the item's TRC-20 `Transfer`.
    function _decodeBatchFromLogsOnly(Vm.Log[] memory allLogs) private view returns (LoggedDeposit[] memory rebuilt) {
        Vm.Log memory batch = _uniqueLog(_escrowLogs(allLogs), DEPOSITED_MANY_TOPIC0, "DepositedMany");
        (
            bytes32[] memory depositIds,
            IEscrow.DepositWitness[] memory depositWitnesses,
            IEscrow.ReserveWitness[] memory reserveWitnesses,
            uint256[] memory feeAmounts
        ) = abi.decode(batch.data, (bytes32[], IEscrow.DepositWitness[], IEscrow.ReserveWitness[], uint256[]));

        // The escrow-inbound TRC-20 Transfers, in emission order. `_deposit` runs once per item and
        // each call makes Permit2 move that item's token, so the i-th such Transfer belongs to
        // depositIds[i]. This is the join the documented procedure prescribes.
        Vm.Log[] memory transfers = _escrowInboundTransfers(allLogs);
        assertEq(
            transfers.length,
            depositIds.length,
            "one escrow-inbound TRC-20 Transfer per deposit is what the documented batch join relies on; the counts differ, so the per-item mapping is not sound"
        );

        rebuilt = new LoggedDeposit[](depositIds.length);
        for (uint256 i; i < depositIds.length; i++) {
            rebuilt[i].depositId = depositIds[i];
            rebuilt[i].quoteHash = reserveWitnesses[i].quoteHash;
            rebuilt[i].depositRequestHash = depositWitnesses[i].depositRequestHash;
            // The batch log carries the PLAINTEXT destination; the witness needs its hash.
            rebuilt[i].destinationHash = keccak256(bytes(depositWitnesses[i].destination));
            rebuilt[i].amount = reserveWitnesses[i].sourceAmount;
            rebuilt[i].feeAmount = feeAmounts[i];
            rebuilt[i].reserver = depositWitnesses[i].reserver;
            rebuilt[i].releaser = depositWitnesses[i].releaser;
            rebuilt[i].settler = reserveWitnesses[i].settler;

            // The two members DepositedMany does not carry.
            rebuilt[i].token = transfers[i].emitter;
            // Safe: an indexed `address` topic is the left-padded 20-byte value.
            rebuilt[i].depositor = address(uint160(uint256(transfers[i].topics[1])));

            // Cross-check that fixes the join: the Transfer's value must be the charge the
            // ReserveWitness at the same index attested. The two items below carry DIFFERENT amounts,
            // so a mis-joined pair fails here rather than silently rebuilding a witness out of one
            // item's commitments and another item's depositor.
            assertEq(
                abi.decode(transfers[i].data, (uint256)),
                reserveWitnesses[i].sourceAmount,
                "the TRC-20 Transfer joined to this item moved a different amount than the item's attested sourceAmount: the per-item log join is wrong"
            );
            // No `token != address(0)` guard: `token` is the log's EMITTER, and a log's emitter is
            // never the zero address, so such an assertion could not fail. The `depositor` one below
            // can: `_escrowInboundTransfers` filters on `to`, so a MINT to the escrow inside the
            // recorded window (`from` = 0) would be joined to an item and produce a witness with a zero
            // depositor - a wrong join this catches before the refund attempt.
            assertTrue(
                rebuilt[i].depositor != address(0),
                "the Transfer joined to this item has a zero `from`: it is a mint to the escrow, not this item's deposit transfer"
            );
            // A log-only consumer signs with the key of whatever releaser the logs name.
            assertEq(
                rebuilt[i].releaser,
                releaser,
                "the releaser decoded from DepositedMany is not the fixture releaser; the signature below would not be one a log-only consumer could produce"
            );
        }
    }

    /// @dev Every recorded TRC-20 `Transfer` whose `to` is the escrow, in emission order.
    function _escrowInboundTransfers(Vm.Log[] memory logs) private view returns (Vm.Log[] memory inbound) {
        uint256 count;
        for (uint256 i; i < logs.length; i++) {
            if (_isEscrowInboundTransfer(logs[i])) count++;
        }
        inbound = new Vm.Log[](count);
        uint256 next;
        for (uint256 i; i < logs.length; i++) {
            if (_isEscrowInboundTransfer(logs[i])) {
                inbound[next] = logs[i];
                next++;
            }
        }
    }

    function _isEscrowInboundTransfer(Vm.Log memory log) private view returns (bool) {
        if (log.topics.length != 3 || log.topics[0] != ERC20_TRANSFER_TOPIC0) return false;
        return address(uint160(uint256(log.topics[2]))) == address(s_escrow);
    }

    /// @dev The two items of the batch below: different depositors, different tokens, different
    /// destinations, different request hashes and different charged amounts. Each difference makes one
    /// part of the documented join load-bearing — a reconstruction that mixed item 0's `Transfer` with
    /// item 1's `DepositedMany` entry could not produce a witness that hashes to either stored tuple.
    function _batchFixtures(address secondDepositor, uint256 secondDepositorKey, address secondToken)
        private
        view
        returns (IEscrow.DepositInput[] memory depositInputs)
    {
        depositInputs = new IEscrow.DepositInput[](2);
        depositInputs[0] = _buildDepositInput(1, REQUEST_HASH, DESTINATION);
        depositInputs[1] = _buildDepositInputFor(
            DepositFixture({
                nonce: 2,
                depositRequestHash: keccak256("commitment-events-batch-second-request-content"),
                // ARBITRARY byte string, NOT a canonical-form example.
                destination: "tron:nile/trc20:TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf@TJRabPrwbZy45sbavfcjinPJC18kjpRTv8",
                depositorAddr: secondDepositor,
                depositorKey: secondDepositorKey,
                token: secondToken,
                // Distinct from item 0's charge, and below the permit ceiling.
                sourceAmount: DEPOSIT_AMOUNT / 4,
                permitAmount: DEPOSIT_AMOUNT
            })
        );
    }

    /// @dev A second depositor and a second allowlisted token, funded and approved.
    ///
    /// The second token is a PLAIN mock, not the returns-false one `s_token` uses, and that is forced
    /// rather than incidental: the escrow special-cases exactly one address (`i_usdt`) onto
    /// `_usdtTransfer`, and every other token is paid out through SafeERC20, which rejects a `false`
    /// return. A second returns-false token would therefore revert on refund for a reason that has
    /// nothing to do with the log join under test. The pairing is also the realistic one - a Tron
    /// batch mixing USDT with a standards-compliant TRC-20 - so `refundMany` below crosses BOTH payout
    /// paths in a single call.
    function _secondActor() private returns (address secondDepositor, uint256 secondDepositorKey, IERC20 secondToken) {
        (secondDepositor, secondDepositorKey) = makeAddrAndKey("commitmentEventsSecondDepositor");
        MockToken6Decimals token = new MockToken6Decimals("Second Token", "TEST2");
        secondToken = IERC20(address(token));
        _allowlistToken(secondToken);
        token.mint(secondDepositor, DEPOSIT_AMOUNT * 10);
        vm.prank(secondDepositor);
        token.approve(address(s_permit2), type(uint256).max);
    }

    /// CORE-2120: the BATCH path's documented recovery procedure, executed. A consumer that has only
    /// the logs of a `depositMany()` transaction can refund every item — but it needs TWO kinds of log,
    /// not one: `DepositedMany` for nine of the eleven members, and each item's TRC-20 `Transfer` for
    /// `depositor` (its `topics[1]`) and `token` (its emitter).
    ///
    /// Everything below is DECODED FROM LOGS; no fixture variable is read into a witness. That is what
    /// makes this a proof of the documented procedure rather than a restatement of it: decode the wrong
    /// token, or join the wrong `Transfer` to an item, and the rebuilt tuple does not hash to the
    /// stored one and `refundMany` reverts `InvalidWitnessValues`.
    function test_depositMany_logsAlone_rebuildRefundWitnesses_andRefundManySucceeds() public {
        (address secondDepositor, uint256 secondDepositorKey, IERC20 secondToken) = _secondActor();

        vm.recordLogs();
        s_escrow.depositMany(_batchFixtures(secondDepositor, secondDepositorKey, address(secondToken)));
        LoggedDeposit[] memory rebuilt = _decodeBatchFromLogsOnly(vm.getRecordedLogs());
        assertEq(rebuilt.length, 2, "DepositedMany did not describe both deposits");

        uint256[] memory balancesBefore = new uint256[](2);
        IEscrow.RefundInput[] memory refundInputs = new IEscrow.RefundInput[](2);
        for (uint256 i; i < 2; i++) {
            balancesBefore[i] = IERC20(rebuilt[i].token).balanceOf(rebuilt[i].depositor);
            IEscrow.RefundWitness memory witness = _refundWitnessFromLogs(rebuilt[i]);
            refundInputs[i] = IEscrow.RefundInput({
                refundWitness: witness,
                refundSignature: _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey)
            });
        }

        s_escrow.refundMany(refundInputs);

        for (uint256 i; i < 2; i++) {
            assertEq(
                s_escrow.getDepositHash(rebuilt[i].depositId),
                bytes32(0),
                "a deposit was not cleared by the log-built batch refund"
            );
            assertEq(
                IERC20(rebuilt[i].token).balanceOf(rebuilt[i].depositor),
                balancesBefore[i] + rebuilt[i].amount,
                "a depositor was not made whole by the log-built batch refund"
            );
        }
    }

    /// The other half of the claim, and the reason the documentation must not say `DepositedMany`
    /// alone is enough: with the nine members it carries and NOTHING else, the witness cannot be
    /// completed. `depositor` and `token` have no value a consumer could take from that log, and a
    /// witness that leaves them empty is rejected — the deposit would look unrefundable to an indexer
    /// that never looked at the `Transfer` logs.
    function test_depositMany_depositedManyAlone_cannotCompleteARefundWitness() public {
        (address secondDepositor, uint256 secondDepositorKey, IERC20 secondToken) = _secondActor();

        vm.recordLogs();
        s_escrow.depositMany(_batchFixtures(secondDepositor, secondDepositorKey, address(secondToken)));
        LoggedDeposit[] memory rebuilt = _decodeBatchFromLogsOnly(vm.getRecordedLogs());

        // Exactly the witness a `DepositedMany`-only consumer can build: the nine members it carries,
        // and the two it does not left at their default.
        LoggedDeposit memory withoutTransferLog = rebuilt[0];
        withoutTransferLog.depositor = address(0);
        withoutTransferLog.token = address(0);
        IEscrow.RefundWitness memory witness = _refundWitnessFromLogs(withoutTransferLog);

        // Built ahead of the cheatcode, not inline in the reverting call: `vm.expectRevert` binds to
        // the NEXT call, and both the signature builder and `getDepositHash` make calls of their own.
        IEscrow.RefundInput memory refundInput = IEscrow.RefundInput({
            refundWitness: witness,
            refundSignature: _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey)
        });
        bytes32 storedHash = s_escrow.getDepositHash(witness.depositId);

        // The FULL 3-argument payload, matching the convention for this error elsewhere in the suite:
        // pinning both hashes shows the rejection came from the two missing members and not from some
        // unrelated reconstruction difference that raises the same error.
        vm.expectRevert(
            abi.encodeWithSelector(
                IEscrow.InvalidWitnessValues.selector,
                witness.depositId,
                storedHash,
                _refundWitnessActiveDepositHash(witness)
            )
        );
        s_escrow.refund(refundInput);
    }

    /// @dev Mirrors _refund's reconstruction. Used ONLY to predict the revert payload of the test
    /// above — never to verify a digest, and never on a success path.
    function _refundWitnessActiveDepositHash(IEscrow.RefundWitness memory witness) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: witness.depositor,
                    quoteHash: witness.quoteHash,
                    depositRequestHash: witness.depositRequestHash,
                    destinationHash: witness.destinationHash,
                    token: witness.token,
                    amount: witness.amount,
                    feeAmount: witness.feeAmount,
                    reserver: witness.reserver,
                    releaser: witness.releaser,
                    settler: witness.settler
                })
            )
        );
    }

    // ---- event ABI pinning ----
    //
    // Each test below invokes one entry point with logs recorded and asserts the escrow's emitted
    // topic0s against out-of-band literals, in order and by exact count. The compiler derives those
    // topic0s from the declarations in contracts/interfaces/IEscrow.sol, so this is a tie between the
    // source and values this repository did not compute - not two literals agreeing with each other.
    //
    // WHAT A READER IS HERE TO DECIDE is what a deployed indexer can keep filtering on. Every literal
    // is shared with the EVM escrow and with the committed Go golden in
    // ../bindings/go/escrow-encoding/encoding/testdata/event_topic0_golden.json, which the block scanner's
    // pre-filter is generated from. A topic0 that moves without that golden moving with it does not
    // fail loudly anywhere: the scanner simply stops seeing the event, and on the deposit path that
    // means a deposit nobody indexes and a refund nobody can build - with no rescue function behind it.

    /// CORE-2120: `deposit()` emits exactly `Deposited` then the new `DepositCommitments` - the
    /// pre-existing topic0 unchanged, and exactly ONE new log.
    function test_deposit_emitsDepositedThenDepositCommitments_withPinnedTopic0s() public {
        (, Vm.Log[] memory escrowLogs) = _depositRecordingLogs(1, REQUEST_HASH, DESTINATION);

        _assertEscrowTopic0s(escrowLogs, _topic0s(DEPOSITED_TOPIC0, DEPOSIT_COMMITMENTS_TOPIC0), "deposit()");
    }

    // Deliberately NO `test_depositCommitmentsTopic0_collidesWithNothing`: it would compare the seven
    // topic0 literals in this file only with each other, which is unfailable in any way that matters.
    // Every one of those seven is separately asserted against a topic0 the CONTRACT emitted, by an
    // `_assertEscrowTopic0s` call in this section, so a literal that duplicated another event's value
    // could not match the log it is checked against and one of those tests fails first — with a message
    // that names the event. A literals-only inequality check adds no detection, only the appearance of
    // it.

    function test_release_topic0IsPinned() public {
        (, Vm.Log[] memory escrowLogs) = _depositRecordingLogs(1, REQUEST_HASH, DESTINATION);
        IEscrow.ReleaseWitness memory witness = _releaseWitnessFromLogs(_decodeFromLogsOnly(escrowLogs));

        vm.recordLogs();
        s_escrow.release(
            IEscrow.ReleaseInput({
                releaseWitness: witness,
                releaseSignature: _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey)
            })
        );

        _assertEscrowTopic0s(_escrowLogs(vm.getRecordedLogs()), _topic0s(RELEASED_TOPIC0), "release()");
    }

    function test_refund_topic0IsPinned() public {
        (, Vm.Log[] memory escrowLogs) = _depositRecordingLogs(1, REQUEST_HASH, DESTINATION);
        IEscrow.RefundWitness memory witness = _refundWitnessFromLogs(_decodeFromLogsOnly(escrowLogs));

        vm.recordLogs();
        s_escrow.refund(
            IEscrow.RefundInput({
                refundWitness: witness,
                refundSignature: _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey)
            })
        );

        _assertEscrowTopic0s(_escrowLogs(vm.getRecordedLogs()), _topic0s(REFUNDED_TOPIC0), "refund()");
    }

    /// @dev `ReleasedMany`'s parameter is a `ReleaseWitness[]`, so its topic0 tracks every member of
    /// that struct - the two CORE-2120 added included. Pinning it here is what stops a further witness
    /// change from moving the topic0 quietly.
    function test_releaseMany_topic0IsPinned() public {
        (, Vm.Log[] memory escrowLogs) = _depositRecordingLogs(1, REQUEST_HASH, DESTINATION);
        IEscrow.ReleaseWitness memory witness = _releaseWitnessFromLogs(_decodeFromLogsOnly(escrowLogs));

        IEscrow.ReleaseInput[] memory releaseInputs = new IEscrow.ReleaseInput[](1);
        releaseInputs[0] = IEscrow.ReleaseInput({
            releaseWitness: witness,
            releaseSignature: _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey)
        });

        vm.recordLogs();
        s_escrow.releaseMany(releaseInputs);

        _assertEscrowTopic0s(_escrowLogs(vm.getRecordedLogs()), _topic0s(RELEASED_MANY_TOPIC0), "releaseMany()");
    }

    /// @dev `RefundedMany`'s parameter is a `RefundWitness[]`; same reasoning as `ReleasedMany` above.
    function test_refundMany_topic0IsPinned() public {
        (, Vm.Log[] memory escrowLogs) = _depositRecordingLogs(1, REQUEST_HASH, DESTINATION);
        IEscrow.RefundWitness memory witness = _refundWitnessFromLogs(_decodeFromLogsOnly(escrowLogs));

        IEscrow.RefundInput[] memory refundInputs = new IEscrow.RefundInput[](1);
        refundInputs[0] = IEscrow.RefundInput({
            refundWitness: witness,
            refundSignature: _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey)
        });

        vm.recordLogs();
        s_escrow.refundMany(refundInputs);

        _assertEscrowTopic0s(_escrowLogs(vm.getRecordedLogs()), _topic0s(REFUNDED_MANY_TOPIC0), "refundMany()");
    }
}
