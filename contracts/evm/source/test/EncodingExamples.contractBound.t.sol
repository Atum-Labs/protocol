// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {Escrow} from "../src/Escrow.sol";
import {IPermit2, ISignatureTransfer} from "permit2/src/interfaces/IPermit2.sol";
import {SignatureVerification} from "permit2/src/libraries/SignatureVerification.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockToken} from "./mock/MockToken.sol";

/// @notice CORE-2120 SECOND, INDEPENDENT DRIFT DETECTOR: makes encoding-examples.json's published
/// `expectedDigest` goldens LOAD-BEARING ON THE CONTRACT.
///
/// @dev test/EncodingExamples.verify.t.sol recomputes each golden with its own `abi.encode(...)`
/// argument list and never calls the escrow. That makes the published cross-language fixture a
/// test-side mirror: a consistent transposition in src/Escrow.sol, test/helpers/Signatures.sol
/// AND that verifier keeps every golden internally consistent. And a single detector is
/// defeatable by regenerating the numbers it compares against — test/Escrow.canonicalDigest.t.sol
/// pins the digests to out-of-band literals, but someone who transposes the contract can repoint
/// two literals in one file and be green again.
///
/// This file closes that. It reads the digests OUT OF encoding-examples.json AT RUNTIME, signs
/// them, and requires the real contract to accept them:
///
///   * deposit[i].expectedDigest  — signed by the depositor, passed to deposit(); REAL Permit2
///     (Uniswap's precompiled runtime bytecode, etched at the canonical address) must recover the
///     depositor from it, which it can only do if src/Escrow.sol's DepositWitness struct hash and
///     full witness type string match the ones the golden was built from.
///   * release[i]/refund[i].expectedDigest — signed by the releaser, passed to release()/refund();
///     src/Escrow.sol must recover the releaser from it.
///
/// No Solidity re-encode of any EIP-712 struct happens here. Every witness field is parsed from
/// the JSON, so a contract-side transposition now fails UNLESS the shared fixture is edited too —
/// and that fixture is what other repositories' signers copy, so editing it is loud.
///
/// Which fixture entries CANNOT be bound this way, and exactly why:
///   * `reserve[0]`, `reserve[1]` — the escrow only ever verifies a ReserveWitness inside
///     deposit(), and only after requiring `reserveWitness.depositId ==
///     keccak256(abi.encode(depositor, depositSignature, permit.nonce))`. Reaching a deposit whose
///     depositId equals the fixture's (0xbbbf298f…/0x419d1a28…) would mean finding a preimage for
///     that keccak256, so these goldens cannot be exercised through the contract at all. They stay
///     covered by EncodingExamples.verify.t.sol, and the ReserveWitness digest ENCODING is pinned
///     to an out-of-band literal by test/Escrow.canonicalDigest.t.sol's deposit leg.
///   * `depositId[0]`, `depositId[1]` — their `signature` fields are not valid Permit2 signatures
///     for any deposit (they are standalone examples: signing deposit[0].expectedDigest with the
///     fixture depositor's key yields different bytes), so a deposit carrying them can never
///     succeed. The depositId FORMULA is contract-bound instead: the two tests below pass an
///     out-of-band `depositId` literal in the ReserveWitness and the contract's own equality check
///     accepts it.
///
/// The out-of-band literals in this file (the two seeded ActiveDeposit hashes, the two depositIds,
/// the two ReserveWitness digests) were derived exactly like the ones in
/// test/Escrow.canonicalDigest.t.sol — from the JSON's OWN field values, with a from-scratch
/// keccak-256 outside this repository. THE SAME RULE APPLIES: never regenerate them with a
/// Solidity helper and never copy what a failing assertion prints. If a fixture value changes,
/// re-derive them out of band.
contract EncodingExamplesContractBoundTest is Test {
    string private constant FIXTURE_PATH = "encoding-examples.json";

    /// @dev Permit2's canonical cross-chain address. The fixture's `permit2` field must equal it:
    /// the etched blob rebuilds its domain separator from `address(this)`, so the golden is only
    /// reproducible in-contract at this address.
    address private constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @dev Fee configuration applied to the fixture's token. 0.02% with a non-binding $25 cap:
    /// 0.02% of the fixture's 1000e18 amount is the fixture's own 0.2e18 `feeAmount`.
    uint88 private constant FEE_PERCENTAGE = 0.02e6;
    uint80 private constant MAX_FEE = 25e6;
    uint8 private constant TOKEN_DECIMALS = 18;

    /// @dev Storage slots per `forge inspect src/Escrow.sol:Escrow storageLayout`; both seedings
    /// are verified through public getters, so a layout change fails loudly.
    uint256 private constant ACTIVE_DEPOSIT_HASHES_SLOT = 9;
    uint256 private constant ROLES_SLOT = 2;

    /// @dev Entries per bindable fixture group that this file actually binds. Asserted against the
    /// JSON, so a newly published golden cannot ship with a test-side check only.
    uint256 private constant BOUND_DEPOSIT_FIXTURES = 2;
    uint256 private constant BOUND_RELEASE_FIXTURES = 2;
    uint256 private constant BOUND_REFUND_FIXTURES = 2;

    /// @dev keccak256(abi.encode(ActiveDeposit{...})) built from encoding-examples.json's
    /// `release[i]` field set (identical to `refund[i]`'s), derived OUT OF BAND. Seeded so the
    /// settlement legs reach their signature check; a fixture field change makes the contract's
    /// rebuilt tuple disagree with this literal and the call reverts InvalidWitnessValues.
    bytes32 private constant SETTLEMENT_0_ACTIVE_DEPOSIT_HASH =
        0xe1a405fe46d76f610c72c5e834a17b3282a5f51236bcc4229cdb83c79d42393b;
    bytes32 private constant SETTLEMENT_1_ACTIVE_DEPOSIT_HASH =
        0x9e4fcc449c558c36c753590b9479ce5d4591a55f1b6551bf94441782992e795f;

    /// @dev Out-of-band depositIds: keccak256(abi.encode(depositor, signature, nonce)) where
    /// `signature` is the depositor's (deterministic, RFC-6979) signature over the JSON's
    /// deposit[i].expectedDigest and `nonce` is the JSON's deposit[i].nonce.
    bytes32 private constant DEPOSIT_0_ID = 0x490700b34c96dad410aeece02ea6ab87dbf3d4e6bea0627719d520a890a9d9a5;
    bytes32 private constant DEPOSIT_1_ID = 0x9f02e31be96787954e7d5d15981fd329677a5fb0ccfefa18a9ac3580153b06ec;
    /// @dev Out-of-band ReserveWitness digests for (DEPOSIT_i_ID, RESERVE_QUOTE_HASH,
    /// RESERVE_SETTLER, the JSON's deposit[i].amount) under the escrow's EIP-712 domain at the
    /// fixture's chain id and escrow address. Plumbing: the deposit path verifies a reserve
    /// signature before it calls Permit2.
    bytes32 private constant DEPOSIT_0_RESERVE_DIGEST =
        0x779ee25db6b7fd14d9caa67ea751180b4d60cc6d595e701da3539537d00abdf6;
    bytes32 private constant DEPOSIT_1_RESERVE_DIGEST =
        0xa8e4afb903fb07222d3c90465f2579564c27ca4da532a750dffed7bcafd38a07;
    /// @dev Reserve-leg values the two digests above were derived with. Not fixture goldens —
    /// they are pinned BY those digests (a different value recovers a different signer).
    bytes32 private constant RESERVE_QUOTE_HASH = 0x095b62b4af754ec82a94c9e500313b362f073033c63d6d888b3c8f47dcbb33e9;
    address private constant RESERVE_SETTLER = 0x1E85c6266C9EDf9e6BA293d780DcdDE76dC7Acf7;

    Escrow private s_escrow;

    function _fixture() private view returns (string memory) {
        return vm.readFile(FIXTURE_PATH);
    }

    function _path(string memory group, uint256 index, string memory field) private pure returns (string memory) {
        return string.concat(".", group, "[", vm.toString(index), "].", field);
    }

    /// @dev Etches the escrow (and a mock token) at the addresses the fixture names, at the
    /// fixture's chain id: both are EIP-712 digest inputs, so the golden is only reproducible
    /// in-contract there. The escrow deliberately starts with empty storage; everything the leg
    /// under test needs is seeded explicitly below.
    function _etchEscrowAndToken(uint256 chainId, address escrowAddr, address tokenAddr) private {
        vm.chainId(chainId);
        vm.etch(tokenAddr, address(new MockToken("Fixture Token", "FIX")).code);
        // The etched runtime contains `reserve()`'s delegatecall to EscrowReserveLib at the address forge
        // linked for THIS test's VM, where it also deployed the library; a reserve case added here
        // needs that library in place, which `new Escrow(...)` above already guarantees.
        vm.etch(escrowAddr, address(new Escrow(IPermit2(PERMIT2), address(this))).code);
        s_escrow = Escrow(escrowAddr);
    }

    /// @dev Grants TOKEN_CONFIG_ROLE by poking AccessControl's `_roles` mapping, then allowlists
    /// through the contract's own API so the fee parameters are the contract's.
    function _allowlistToken(address escrowAddr, address tokenAddr) private {
        bytes32 role = s_escrow.TOKEN_CONFIG_ROLE();
        bytes32 roleDataSlot = keccak256(abi.encode(role, ROLES_SLOT));
        vm.store(escrowAddr, keccak256(abi.encode(address(this), roleDataSlot)), bytes32(uint256(1)));
        assertTrue(
            s_escrow.hasRole(role, address(this)),
            "TOKEN_CONFIG_ROLE seeding failed: AccessControl's `_roles` mapping is no longer at storage slot 2 (re-run `forge inspect src/Escrow.sol:Escrow storageLayout`)"
        );
        s_escrow.allowTokenAndSetFeeConfig(IERC20(tokenAddr), TOKEN_DECIMALS, FEE_PERCENTAGE, 0, MAX_FEE);
    }

    function _seedActiveDeposit(address escrowAddr, bytes32 depositId, bytes32 activeDepositHash) private {
        vm.store(escrowAddr, keccak256(abi.encode(depositId, ACTIVE_DEPOSIT_HASHES_SLOT)), activeDepositHash);
        assertEq(
            s_escrow.getDepositHash(depositId),
            activeDepositHash,
            "ActiveDeposit hash seeding failed: s_activeDepositHashes is no longer at storage slot 9 (re-run `forge inspect src/Escrow.sol:Escrow storageLayout`)"
        );
    }

    function _sign(uint256 privateKey, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev The fixture's actor addresses are forge-std `makeAddr` labels, which is how we can
    /// sign as them. Asserted, not assumed: if the fixture is regenerated with different actors,
    /// this fails with an actionable message instead of an opaque signature error.
    function _keyFor(string memory label, address expected, string memory role) private returns (uint256 key) {
        address addr;
        (addr, key) = makeAddrAndKey(label);
        assertEq(
            addr,
            expected,
            string.concat(
                "encoding-examples.json's ",
                role,
                " is no longer makeAddr(\"",
                label,
                "\"), so this test cannot sign as it. Regenerate the fixture with the makeAddr actors, or add the new key here."
            )
        );
    }

    /// @dev Release and refund carry identical field sets, so one reader serves both.
    function _settlementWitness(string memory group, uint256 index)
        private
        view
        returns (IEscrow.ReleaseWitness memory witness, uint256 chainId, address escrowAddr, bytes32 expectedDigest)
    {
        string memory json = _fixture();
        chainId = vm.parseJsonUint(json, _path(group, index, "chainID"));
        escrowAddr = vm.parseJsonAddress(json, _path(group, index, "escrow"));
        expectedDigest = vm.parseJsonBytes32(json, _path(group, index, "expectedDigest"));
        witness = IEscrow.ReleaseWitness({
            depositId: vm.parseJsonBytes32(json, _path(group, index, "depositId")),
            quoteHash: vm.parseJsonBytes32(json, _path(group, index, "quoteHash")),
            depositRequestHash: vm.parseJsonBytes32(json, _path(group, index, "depositRequestHash")),
            destinationHash: vm.parseJsonBytes32(json, _path(group, index, "destinationHash")),
            depositor: vm.parseJsonAddress(json, _path(group, index, "depositor")),
            token: vm.parseJsonAddress(json, _path(group, index, "token")),
            amount: vm.parseJsonUint(json, _path(group, index, "amount")),
            feeAmount: vm.parseJsonUint(json, _path(group, index, "feeAmount")),
            reserver: vm.parseJsonAddress(json, _path(group, index, "reserver")),
            releaser: vm.parseJsonAddress(json, _path(group, index, "releaser")),
            settler: vm.parseJsonAddress(json, _path(group, index, "settler"))
        });
    }

    /// @notice Every bindable fixture entry must actually be bound here.
    /// @dev Without this, adding a `release[1]` (or a third deposit) to encoding-examples.json
    /// would publish a golden that only the test-side recompute in
    /// test/EncodingExamples.verify.t.sol ever looks at — i.e. exactly the no-contract-binding gap
    /// this file exists to close. The `reserve` and `depositId` groups are deliberately absent:
    /// see the header for why they cannot be bound at all.
    function test_contractBinding_coversEveryBindableFixtureEntry() public view {
        string memory json = _fixture();
        _assertBoundEntryCount(json, "deposit", BOUND_DEPOSIT_FIXTURES);
        _assertBoundEntryCount(json, "release", BOUND_RELEASE_FIXTURES);
        _assertBoundEntryCount(json, "refund", BOUND_REFUND_FIXTURES);
    }

    function _assertBoundEntryCount(string memory json, string memory group, uint256 expected) private view {
        uint256 count;
        while (vm.keyExistsJson(json, string.concat(".", group, "[", vm.toString(count), "]"))) {
            count++;
        }
        assertEq(
            count,
            expected,
            string.concat(
                "encoding-examples.json group `",
                group,
                "` no longer has the number of entries this file binds to the contract. Every bindable golden needs a require-success test HERE, not just the test-side recompute in test/EncodingExamples.verify.t.sol - otherwise the new entry ships with no contract binding at all. Binding one needs out-of-band literals; see the header."
            )
        );
    }

    /// CORE-2120: release() must accept a signature over encoding-examples.json's published
    /// `release[0].expectedDigest`.
    function test_release_acceptsSignatureOverPublishedFixtureDigest_0() public {
        _bindReleaseFixture(0, SETTLEMENT_0_ACTIVE_DEPOSIT_HASH);
    }

    /// CORE-2120: same for `release[1]`, which is a standalone settlement example on a DIFFERENT
    /// chain id and escrow address — the two variable terms of the escrow's EIP-712 domain
    /// separator. `[0]` alone would still pass if the contract hardcoded either of them.
    function test_release_acceptsSignatureOverPublishedFixtureDigest_1() public {
        _bindReleaseFixture(1, SETTLEMENT_1_ACTIVE_DEPOSIT_HASH);
    }

    function _bindReleaseFixture(uint256 index, bytes32 activeDepositHash) private {
        (IEscrow.ReleaseWitness memory witness, uint256 chainId, address escrowAddr, bytes32 expectedDigest) =
            _settlementWitness("release", index);
        uint256 releaserKey =
            _keyFor("releaser", witness.releaser, string.concat("release[", vm.toString(index), "].releaser"));

        _etchEscrowAndToken(chainId, escrowAddr, witness.token);
        _seedActiveDeposit(escrowAddr, witness.depositId, activeDepositHash);
        deal(witness.token, escrowAddr, witness.amount);

        uint256 settlerBalanceBefore = IERC20(witness.token).balanceOf(witness.settler);

        try s_escrow.release(
            IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: _sign(releaserKey, expectedDigest)})
        ) {
            assertEq(s_escrow.getDepositHash(witness.depositId), bytes32(0), "deposit not cleared by release");
            assertEq(
                IERC20(witness.token).balanceOf(witness.settler),
                settlerBalanceBefore + witness.amount - witness.feeAmount,
                "settler did not receive amount - feeAmount"
            );
        } catch (bytes memory err) {
            _reportSettlementDrift(string.concat("release[", vm.toString(index), "]"), err);
        }
    }

    /// CORE-2120: refund() must accept a signature over encoding-examples.json's published
    /// `refund[0].expectedDigest`. Refund is the escape hatch, so this is the leg that matters most.
    function test_refund_acceptsSignatureOverPublishedFixtureDigest_0() public {
        _bindRefundFixture(0, SETTLEMENT_0_ACTIVE_DEPOSIT_HASH);
    }

    /// CORE-2120: same for `refund[1]` — different chain id and escrow address, and the RefundWitness
    /// typehash over a field set identical to `release[1]`'s, so the two digests must differ.
    function test_refund_acceptsSignatureOverPublishedFixtureDigest_1() public {
        _bindRefundFixture(1, SETTLEMENT_1_ACTIVE_DEPOSIT_HASH);
    }

    function _bindRefundFixture(uint256 index, bytes32 activeDepositHash) private {
        (IEscrow.ReleaseWitness memory witness, uint256 chainId, address escrowAddr, bytes32 expectedDigest) =
            _settlementWitness("refund", index);
        uint256 releaserKey =
            _keyFor("releaser", witness.releaser, string.concat("refund[", vm.toString(index), "].releaser"));

        _etchEscrowAndToken(chainId, escrowAddr, witness.token);
        _seedActiveDeposit(escrowAddr, witness.depositId, activeDepositHash);
        deal(witness.token, escrowAddr, witness.amount);

        uint256 depositorBalanceBefore = IERC20(witness.token).balanceOf(witness.depositor);

        try s_escrow.refund(
            IEscrow.RefundInput({
                refundWitness: IEscrow.RefundWitness({
                    depositId: witness.depositId,
                    quoteHash: witness.quoteHash,
                    depositRequestHash: witness.depositRequestHash,
                    destinationHash: witness.destinationHash,
                    depositor: witness.depositor,
                    token: witness.token,
                    amount: witness.amount,
                    feeAmount: witness.feeAmount,
                    reserver: witness.reserver,
                    releaser: witness.releaser,
                    settler: witness.settler
                }),
                refundSignature: _sign(releaserKey, expectedDigest)
            })
        ) {
            assertEq(s_escrow.getDepositHash(witness.depositId), bytes32(0), "deposit not cleared by refund");
            assertEq(
                IERC20(witness.token).balanceOf(witness.depositor),
                depositorBalanceBefore + witness.amount,
                "depositor was not made whole by the refund"
            );
        } catch (bytes memory err) {
            _reportSettlementDrift(string.concat("refund[", vm.toString(index), "]"), err);
        }
    }

    /// CORE-2120: deposit() must accept a depositor signature over encoding-examples.json's
    /// published `deposit[0].expectedDigest`, as verified by REAL Permit2.
    function test_deposit_acceptsSignatureOverPublishedFixtureDigest_0() public {
        _bindDepositFixture(0, DEPOSIT_0_ID, DEPOSIT_0_RESERVE_DIGEST);
    }

    /// CORE-2120: same for `deposit[1]` (a different nonce and deadline, both of which the
    /// contract passes through to Permit2 verbatim).
    function test_deposit_acceptsSignatureOverPublishedFixtureDigest_1() public {
        _bindDepositFixture(1, DEPOSIT_1_ID, DEPOSIT_1_RESERVE_DIGEST);
    }

    function _bindDepositFixture(uint256 index, bytes32 depositIdLiteral, bytes32 reserveDigestLiteral) private {
        string memory json = _fixture();
        uint256 chainId = vm.parseJsonUint(json, _path("deposit", index, "chainID"));
        address escrowAddr = vm.parseJsonAddress(json, _path("deposit", index, "spender"));
        address tokenAddr = vm.parseJsonAddress(json, _path("deposit", index, "token"));
        uint256 amount = vm.parseJsonUint(json, _path("deposit", index, "amount"));
        uint256 deadline = vm.parseJsonUint(json, _path("deposit", index, "deadline"));
        bytes32 expectedDigest = vm.parseJsonBytes32(json, _path("deposit", index, "expectedDigest"));

        assertEq(
            vm.parseJsonAddress(json, _path("deposit", index, "permit2")),
            PERMIT2,
            "encoding-examples.json's deposit fixture no longer uses Permit2's canonical address; the digest is not reproducible in-contract anywhere else"
        );

        IEscrow.DepositWitness memory depositWitness = IEscrow.DepositWitness({
            depositRequestHash: vm.parseJsonBytes32(json, _path("deposit", index, "depositRequestHash")),
            destination: vm.parseJsonString(json, _path("deposit", index, "destination")),
            reserver: vm.parseJsonAddress(json, _path("deposit", index, "reserver")),
            releaser: vm.parseJsonAddress(json, _path("deposit", index, "releaser"))
        });

        uint256 depositorKey;
        address depositor;
        (depositor, depositorKey) = makeAddrAndKey("depositor");
        uint256 reserverKey = _keyFor("reserver", depositWitness.reserver, _reserverLabel(index));

        _etchEscrowAndToken(chainId, escrowAddr, tokenAddr);
        // Real Permit2 at its canonical address: it is Permit2, not the escrow, that recovers the
        // depositor from the fixture digest, so the binding only means something against the
        // genuine implementation.
        new DeployPermit2().deployPermit2();
        _allowlistToken(escrowAddr, tokenAddr);

        deal(tokenAddr, depositor, amount);
        vm.prank(depositor);
        IERC20(tokenAddr).approve(PERMIT2, type(uint256).max);
        vm.warp(deadline);

        try s_escrow.deposit(
            IEscrow.DepositInput({
                permit: ISignatureTransfer.PermitTransferFrom({
                    permitted: ISignatureTransfer.TokenPermissions({token: tokenAddr, amount: amount}),
                    nonce: vm.parseJsonUint(json, _path("deposit", index, "nonce")),
                    deadline: deadline
                }),
                depositor: depositor,
                depositWitness: depositWitness,
                depositSignature: _sign(depositorKey, expectedDigest),
                reserveWitness: IEscrow.ReserveWitness({
                    depositId: depositIdLiteral,
                    quoteHash: RESERVE_QUOTE_HASH,
                    settler: RESERVE_SETTLER,
                    sourceAmount: amount
                }),
                reserveSignature: _sign(reserverKey, reserveDigestLiteral)
            })
        ) returns (
            bytes32 depositId
        ) {
            assertEq(depositId, depositIdLiteral, "deposit() returned a depositId other than the pinned one");
            assertEq(
                IERC20(tokenAddr).balanceOf(escrowAddr), amount, "escrow did not receive the fixture's deposit amount"
            );
        } catch (bytes memory err) {
            _reportDepositDrift(index, err);
        }
    }

    function _reserverLabel(uint256 index) private pure returns (string memory) {
        return string.concat("deposit[", vm.toString(index), "].reserver");
    }

    function _reportSettlementDrift(string memory leg, bytes memory err) private {
        bytes4 selector = err.length >= 4 ? bytes4(err) : bytes4(0);

        if (selector == IEscrow.InvalidSignature.selector) {
            fail(
                string.concat(
                    "src/Escrow.sol no longer computes encoding-examples.json's published ",
                    leg,
                    " digest. The releaser signed the fixture's own `expectedDigest`, read from the file at runtime, and the contract recovered a different signer. Either the contract's ",
                    leg,
                    " struct-hash encode order/typehash/domain drifted from the published fixture, or the fixture golden is wrong. Work out WHICH is wrong - do NOT regenerate the fixture from the contract, and note that other repositories' signers consume this file."
                )
            );
        } else if (selector == IEscrow.InvalidWitnessValues.selector) {
            fail(
                string.concat(
                    "the ActiveDeposit tuple src/Escrow.sol rebuilds from the fixture's ",
                    leg,
                    " witness no longer hashes to this file's SETTLEMENT_i_ACTIVE_DEPOSIT_HASH literal. Either the ActiveDeposit field order/membership changed, or a fixture field changed - in which case re-derive that literal OUT OF BAND from the fixture's new values."
                )
            );
        } else {
            fail(string.concat(leg, " reverted unexpectedly with ", vm.toString(err)));
        }
    }

    function _reportDepositDrift(uint256 index, bytes memory err) private {
        bytes4 selector = err.length >= 4 ? bytes4(err) : bytes4(0);
        string memory entry = string.concat("deposit[", vm.toString(index), "]");

        if (selector == SignatureVerification.InvalidSigner.selector) {
            fail(
                string.concat(
                    "src/Escrow.sol no longer computes encoding-examples.json's published ",
                    entry,
                    ".expectedDigest. The depositor signed that golden, read from the file at runtime, and REAL Permit2 recovered a different signer - so the DepositWitness struct hash the contract passes to Permit2 (or FULL_DEPOSIT_WITNESS_TYPE_STRING, or the keccak256(bytes(destination)) treatment of the `string` member) disagrees with the published fixture. Work out WHICH side is wrong; other repositories' signers copy this fixture."
                )
            );
        } else if (selector == IEscrow.InvalidSignature.selector) {
            fail(
                string.concat(
                    "the ReserveWitness digest for ",
                    entry,
                    " no longer matches the out-of-band literal in this file: the reserve struct-hash encode order, RESERVE_WITNESS_TYPE_HASH, or the EIP-712 domain drifted. (If the fixture's amount/chainID/spender changed instead, re-derive the reserve digest literals out of band.)"
                )
            );
        } else if (selector == IEscrow.DepositNotFound.selector) {
            fail(
                string.concat(
                    "deposit() computed a different depositId than this file's literal for ",
                    entry,
                    ". Either keccak256(abi.encode(depositor, depositSignature, permit.nonce)) changed, or the fixture's expectedDigest/nonce changed (which changes the signature bytes). Re-derive the depositId AND the reserve digest literals OUT OF BAND."
                )
            );
        } else {
            fail(string.concat(entry, " deposit reverted unexpectedly with ", vm.toString(err)));
        }
    }
}
