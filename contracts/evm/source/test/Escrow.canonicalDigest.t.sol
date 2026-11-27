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

// ====================================================================================
//  THE bytes32 LITERALS IN THIS FILE MUST NEVER BE REGENERATED FROM THIS REPOSITORY.
//
//  Every `CANONICAL_*` / `*_ACTIVE_DEPOSIT_HASH` literal below was computed OUTSIDE this
//  repo (a from-scratch keccak-256 implementation, cross-checked with `cast`) directly
//  from the canonical EIP-712 type strings. That is the entire source of their value as a
//  guard. If you intentionally change a witness struct, a typehash, the EIP-712 domain, the
//  ActiveDeposit tuple, or any pinned input below, you must RE-DERIVE the affected literals
//  OUT OF BAND and paste the result here.
//
//  It is NOT acceptable to:
//    - recompute them with a Solidity helper, a `forge script`, or anything under src/ or test/;
//    - copy the "actual" value a failing assertion prints, or one this test logs;
//    - copy them from test/helpers/Signatures.sol, encoding-examples.json, or another test.
//  Any of those turns the literal into a mirror of the code it is supposed to check, which is
//  exactly the failure this file exists to prevent (see commit 630167a).
// ====================================================================================

/// @notice CORE-2120 IRREVERSIBILITY GUARD: pins src/Escrow.sol's OWN deposit/release/refund
/// EIP-712 digest *value* encoding to digest literals derived OUT OF BAND from the canonical
/// type strings.
///
/// @dev Why this file exists (and why it deliberately shares nothing with the other suites):
///
/// Every other settlement test signs with test/helpers/Signatures.sol, which rebuilds the
/// struct hash with its own `abi.encode(...)` argument list. That makes the test oracle a
/// MIRROR of the contract, not a check on it: a CONSISTENT transposition of two adjacent
/// members (`depositRequestHash` <-> `destinationHash` on the settlement witnesses,
/// `depositRequestHash` <-> `keccak256(bytes(destination))` on the deposit witness) in BOTH
/// src/Escrow.sol and Signatures.sol keeps the whole suite green, because both sides make the
/// same mistake. That exact shared-oracle failure mode already bit this branch once — commit
/// 630167a repaired a stale ReserveWitness golden that survived precisely because its oracle
/// shared the error.
///
/// The mainnet-fork suites cannot catch it either, on any leg. Permit2 receives the
/// DepositWitness as an opaque `bytes32`, so a fork test only ever proves that the contract and
/// the test helper agree with each other — never that either agrees with the published type
/// string. Whether Permit2 is real or not is irrelevant to that gap; what closes it is signing
/// a digest the repo did not compute.
///
/// Shipping a drift on any leg would be unrecoverable, and the escrow has no rescue function:
///   - deposit  — every depositor signature fails Permit2 `InvalidSigner`, so NO deposit can
///                ever succeed (fails closed: an outage, no funds stranded);
///   - release / refund — every releaser signature fails `InvalidSignature`, so funds already in
///                escrow can neither be released NOR refunded (fails open with the money inside).
///
/// The property enforced here, per leg: a signature is produced over a HARDCODED bytes32 digest
/// literal, and the contract must recover the expected signer from it. The literals were
/// computed with a pure-Python keccak-256 and independently reproduced with `cast`, from the
/// canonical type strings:
///
///   keccak256(0x1901 ++ domainSeparator ++ structHash)
///
///   Escrow domain  = keccak256(abi.encode(
///       keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
///       keccak256("Escrow"), keccak256("3"), 1, 0xc0De212000000000000000000000000000000001))
///                  = 0xad6857056ae1400c0fc6957710e33fd259ae6f196822da87ada57369cd7b3537
///   Permit2 domain = keccak256(abi.encode(
///       keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
///       keccak256("Permit2"), 1, 0x000000000022D473030F116dDEE9F6B43aC78BA3))
///                  = 0x866a5aba21966af95d6c7ab78eb2b2fc913915c28be3b9aa07cc04ff903e3f28
///
///   release/refund structHash = keccak256(abi.encode(<typehash>, depositId, quoteHash,
///       depositRequestHash, destinationHash, depositor, token, amount, feeAmount,
///       reserver, releaser, settler))
///   release structHash = 0xfd388f23a4f3ce1c34d9a69ade38f27fb2be89f05eef78a567656cfef0a79173
///   refund  structHash = 0x277adab3306374b0eede70e9fae2a04bd8d491022ffc6c5d0c0d3709aaadf134
///
///   deposit structHash = keccak256(abi.encode(
///       keccak256("PermitWitnessTransferFrom(TokenPermissions permitted,address spender,"
///                 "uint256 nonce,uint256 deadline,DepositWitness witness)DepositWitness(bytes32 "
///                 "depositRequestHash,string destination,address reserver,address releaser)"
///                 "TokenPermissions(address token,uint256 amount)"),
///       keccak256(abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"),
///                            token, permit.amount)),
///       spender /* the escrow */, nonce, deadline,
///       keccak256(abi.encode(DEPOSIT_WITNESS_TYPE_HASH, depositRequestHash,
///                            keccak256(bytes(destination)), reserver, releaser))))
///   DepositWitness structHash = 0x7f8bf4727b488716e33607fc2f62eb79fc26955c33534af10431d6c33c0ecdb1
///
/// The derivation method was validated by reproducing untouched published goldens
/// byte-for-byte first: encoding-examples.json `reserve[0].expectedDigest`
/// 0x7c0b1e2da8e7edd46fdfb4fd58f5a68f127c0face233f545e1e9174cf5d09252 and
/// `deposit[0].expectedDigest` 0x8394727a442fa0baf5a8919fb8db4b4c03fab9c90696b77f77f70add43bfa0d1.
///
/// NO test-side encoder participates in any assertion below. If src/Escrow.sol's internal
/// `abi.encode` order (or a typehash constant, or the domain, or the ActiveDeposit tuple) ever
/// differs from the canonical type string the literals came from, the contract computes a
/// different digest, recovers a different signer, and reverts — and this test fails.
///
/// Non-fork on purpose, and hermetic: the verifying contract address and the chain id are part
/// of every digest, so both are PINNED (`vm.chainId` + `vm.etch` at fixed addresses) rather than
/// left to a deployment nonce or a fork's chain id — and no RPC is involved. The deposit leg
/// still runs against REAL Permit2: `permit2/test/utils/DeployPermit2.sol` etches Uniswap's
/// precompiled Permit2 runtime bytecode at the canonical address (see
/// `test_etchedPermit2IsRealPermit2`). For release/refund the stored ActiveDeposit hash is
/// seeded directly from an out-of-band literal, so not even the storage precondition depends on
/// a test-side `abi.encode`; the deposit leg instead ASSERTS the tuple the contract writes
/// against an out-of-band literal, which is what pins the ActiveDeposit field order on the write
/// path.
contract EscrowCanonicalDigestTest is Test {
    /// @dev Pinned verifying contract / token addresses: both are inputs to the digest literal.
    address private constant ESCROW = 0xc0De212000000000000000000000000000000001;
    address private constant TOKEN = 0xC0DE212000000000000000000000000000000002;
    /// @dev Permit2's canonical cross-chain address. Real Permit2 bytecode is etched here (the
    /// deposit leg calls it); the release/refund paths only need the constructor's non-zero check.
    address private constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 private constant PINNED_CHAIN_ID = 1;

    /// @dev Well-known development keys, so the addresses baked into the digest literals have
    /// signable keys. Every pairing is asserted in setUp rather than trusted.
    uint256 private constant RELEASER_PRIVATE_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 private constant DEPOSITOR_PRIVATE_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 private constant RESERVER_PRIVATE_KEY = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    address private constant RELEASER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address private constant DEPOSITOR = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address private constant RESERVER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address private constant SETTLER = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;

    // Settlement under test. Fixed values; all of them feed the digest literal.
    bytes32 private constant DEPOSIT_ID = 0x483782343cd4eae3d5a10af043beb53761ff42c0fcd67e6e9fcff41d3c22d1ec;
    bytes32 private constant QUOTE_HASH = 0x1af047ad3c0a628ed3851d6854a8adf9b388428ada77f1a2a8a4e7bfbccf4d07;
    bytes32 private constant DEPOSIT_REQUEST_HASH = 0xa1cddb23bc51ec7263a0d1a006920a4ccc6ca418f480d0598e3e4384ad7b4f14;
    /// @dev The deposit leg signs over the PLAINTEXT string; the settlement legs sign over its
    /// hash. Keeping one preimage for both makes the documented pairing load-bearing: the
    /// contract hashes DESTINATION itself on the deposit path, and the ActiveDeposit literal
    /// asserted there was derived from DESTINATION_HASH.
    // NOT canonical form, deliberately: the account segment is EIP-55 mixed-case, predating the
    // ratified all-lowercase-hex rule (ONCHAIN_SPEC.md). This string is the preimage of every
    // pinned out-of-band literal below (DESTINATION_HASH and all four digests), so it MUST NOT be
    // re-cased. The same logical destination, with the ASSET segment also EIP-55, is the pinned
    // release[1]/refund[1] destinationHash preimage in encoding-examples.json (documented in
    // test/EncodingExamples.verify.t.sol); the two are deliberate, distinct byte strings, each
    // behind its own pinned digests. Copy canonical examples from
    // test/Destination.canonicalExamples.t.sol instead.
    string private constant DESTINATION =
        "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639AC7E10F9d54979";
    /// @dev keccak256(bytes(DESTINATION))
    bytes32 private constant DESTINATION_HASH = 0x20de32487c3d0b0b0f90543749846aca433bd31fe14beee53d48d64f7eba8e3b;
    uint256 private constant AMOUNT = 1000e18;
    /// @dev Deliberately non-zero and distinct from AMOUNT, so the `feeAmount` word of the
    /// digest is load-bearing: a dropped or misplaced fee term changes the digest.
    uint256 private constant FEE_AMOUNT = 3.5e18;

    /// @dev keccak256(abi.encode(ActiveDeposit{...})) for the settlement above, derived out of
    /// band (10 static words, ActiveDeposit declaration order).
    bytes32 private constant CANONICAL_ACTIVE_DEPOSIT_HASH =
        0xea9e1c05f30db8deea694b4e6fb3c6bc5a95271ccf5463b56e44db03be5a43f9;

    /// @dev THE point of this file. Out-of-band EIP-712 digests over the canonical
    /// Release/RefundWitness type strings. DO NOT regenerate these from any Solidity helper:
    /// the whole guarantee is that they were produced without one.
    bytes32 private constant CANONICAL_RELEASE_DIGEST =
        0xb64394896db6b206c78932944decf4d11d53f0747997574d1df70b85be7ef822;
    bytes32 private constant CANONICAL_REFUND_DIGEST =
        0x6248d4d13a0f3b2bd7f58744ef102c8066ed5658cd09462dd59fdb702a44fc96;

    // ---- deposit leg (Permit2 `PermitWitnessTransferFrom` over the DepositWitness) ----

    /// @dev Permit2's own EIP-712 domain separator at chain id 1 for the canonical address,
    /// derived out of band. Asserted against the etched contract in setUp, which is what proves
    /// the etched Permit2 is hashing under the domain the deposit digest literal was built for.
    bytes32 private constant PERMIT2_DOMAIN_SEPARATOR =
        0x866a5aba21966af95d6c7ab78eb2b2fc913915c28be3b9aa07cc04ff903e3f28;

    /// @dev The permit is only an authorization CEILING; the reserver-attested `sourceAmount` is
    /// the charge. They are deliberately different, so a leg that used the wrong one is visible
    /// in the transferred balances and in the stored tuple.
    uint256 private constant PERMIT_AMOUNT = 1000e18;
    uint256 private constant SOURCE_AMOUNT = 750e18;
    uint256 private constant PERMIT_NONCE = 2120;
    uint256 private constant PERMIT_DEADLINE = 1_800_000_000;
    /// @dev Pinned so the deadline check cannot depend on when or how the suite is invoked.
    uint256 private constant DEPOSIT_TIMESTAMP = 1_799_000_000;

    /// @dev Token fee config for the deposit leg: 0.02% with a non-binding $25 cap, the same
    /// configuration test/Escrow.depositFlow.t.sol uses. 0.02% of SOURCE_AMOUNT = 0.15e18, which
    /// is a term of DEPOSITED_ACTIVE_DEPOSIT_HASH — so the fee is load-bearing here too.
    uint88 private constant FEE_PERCENTAGE = 0.02e6;
    uint80 private constant MAX_FEE = 25e6;
    uint8 private constant TOKEN_DECIMALS = 18;
    uint256 private constant DEPOSIT_FEE_AMOUNT = 0.15e18;

    /// @dev Out-of-band Permit2 `PermitWitnessTransferFrom` digest for the deposit above,
    /// including Permit2's own domain separator and the DepositWitness struct hash with
    /// keccak256(bytes(destination)) for the `string` member.
    bytes32 private constant CANONICAL_DEPOSIT_DIGEST =
        0x7956cfa0f3811193e0be7c5e5f37ac15ad22a276da01ef98997cde683a449465;
    /// @dev keccak256(abi.encode(DEPOSITOR, <the 65-byte signature over CANONICAL_DEPOSIT_DIGEST>,
    /// PERMIT_NONCE)), derived out of band. `vm.sign` is deterministic (RFC-6979) and was checked
    /// byte-for-byte against `cast wallet sign --no-hash` for this key and digest, so the
    /// signature — and therefore this depositId — is reproducible without running the repo.
    bytes32 private constant CANONICAL_DEPOSIT_ID = 0xa92e46d57547375d75c1fba8ccf6d31017a133c329761f6a72491658de1eb0df;
    /// @dev Out-of-band ReserveWitness digest for (CANONICAL_DEPOSIT_ID, QUOTE_HASH, SETTLER,
    /// SOURCE_AMOUNT) under the escrow domain. Plumbing for the deposit leg — and, as a
    /// by-product, the only place the reserve digest encoding is checked without a test-side
    /// encoder.
    bytes32 private constant CANONICAL_RESERVE_DIGEST =
        0x59a7b1044c6ab302ed9415e3719f96a7106645262f66259e4e48219c0e9fdea0;
    /// @dev keccak256(abi.encode(ActiveDeposit{...})) the contract MUST write for that deposit,
    /// derived out of band with amount = SOURCE_AMOUNT and feeAmount = DEPOSIT_FEE_AMOUNT.
    bytes32 private constant DEPOSITED_ACTIVE_DEPOSIT_HASH =
        0x7c808e90b0051eaed232392fb707e48a6fb610603d6d5494ff1b7a214c2edcac;

    /// @dev Etched Permit2 runtime code, for the provenance check below. Uniswap's precompiled
    /// blob is byte-identical to live mainnet Permit2 except for the two cached EIP-712
    /// immutables (`_CACHED_CHAIN_ID` 31337 vs 1 and the separator built from it), which is
    /// exactly why `DOMAIN_SEPARATOR()` takes the rebuild path at PINNED_CHAIN_ID.
    uint256 private constant PERMIT2_CODE_LENGTH = 9152;
    bytes32 private constant PERMIT2_CODE_HASH = 0xa1ad0529565c25202190d4ae7f75d4ca08dc432cc760544ee7d0313b68e82ecd;

    /// @dev Slot of `s_activeDepositHashes` per `forge inspect src/Escrow.sol:Escrow
    /// storageLayout`. Verified through the public getter after seeding, so a storage layout
    /// change fails loudly instead of silently seeding the wrong slot.
    uint256 private constant ACTIVE_DEPOSIT_HASHES_SLOT = 9;
    /// @dev Slot of AccessControl's `_roles` mapping, same source. Also verified through a
    /// public getter (`hasRole`) after seeding.
    uint256 private constant ROLES_SLOT = 2;

    Escrow private s_escrow;

    function setUp() public {
        // Chain id is an input to both domain separators, and both contracts read it at call
        // time (see the etch notes below), so pin it to the value the literals were derived for.
        vm.chainId(PINNED_CHAIN_ID);

        assertEq(
            vm.addr(RELEASER_PRIVATE_KEY),
            RELEASER,
            "RELEASER_PRIVATE_KEY does not correspond to the RELEASER address baked into the digest literal"
        );
        assertEq(
            vm.addr(DEPOSITOR_PRIVATE_KEY),
            DEPOSITOR,
            "DEPOSITOR_PRIVATE_KEY does not correspond to the DEPOSITOR address baked into the digest literal"
        );
        assertEq(
            vm.addr(RESERVER_PRIVATE_KEY),
            RESERVER,
            "RESERVER_PRIVATE_KEY does not correspond to the RESERVER address baked into the digest literal"
        );

        // Fixed addresses, because the verifying contract and the token are digest inputs.
        // Runtime code is etched at the pinned addresses rather than deployed there: every
        // value the settlement paths need from the escrow is either an immutable (baked into the
        // runtime code, including OpenZeppelin EIP712's name/version hashes and `i_permit2`) or
        // is seeded explicitly below.
        //
        // Note the domain separator is REBUILT on every call rather than served from the cache.
        // In OpenZeppelin 5.3.0 `_cachedDomainSeparator` / `_cachedChainId` / `_cachedThis` are
        // `private immutable`, i.e. baked into the runtime bytecode that `vm.etch` copies — so
        // the etched code carries `_cachedThis` = the TEMPORARY construction address below,
        // which is not ESCROW. `_domainSeparatorV4()` serves the cache only when
        // `address(this) == _cachedThis && block.chainid == _cachedChainId`, so it falls through
        // to `_buildDomainSeparator()` and hashes `address(this)` == the pinned ESCROW — which is
        // what the digest literals were derived for. (Empty storage is a consequence of etching,
        // not the reason the separator is rebuilt.)
        vm.etch(TOKEN, address(new MockToken("Canonical Token", "CANON")).code);
        // The etched runtime contains `reserve()`'s delegatecall to EscrowReserveLib at the address forge
        // linked for THIS test's VM, where it also deployed the library; a reserve case added here
        // needs that library in place, which `new Escrow(...)` above already guarantees.
        vm.etch(ESCROW, address(new Escrow(IPermit2(PERMIT2), address(this))).code);
        s_escrow = Escrow(ESCROW);

        // REAL Permit2, hermetically: Uniswap's precompiled runtime bytecode etched at the
        // canonical address. Permit2 caches its domain separator against `block.chainid` only,
        // and the blob's baked `_CACHED_CHAIN_ID` is 31337 (it was produced on anvil), so at
        // PINNED_CHAIN_ID it rebuilds from `address(this)` = PERMIT2 and chain id 1. The
        // assertion below is what proves that rather than assuming it: if a future permit2
        // bump changed the blob's caching behaviour, this fails here instead of silently
        // hashing the deposit witness under a different domain than the literal.
        new DeployPermit2().deployPermit2();
        assertEq(
            IPermit2(PERMIT2).DOMAIN_SEPARATOR(),
            PERMIT2_DOMAIN_SEPARATOR,
            "the etched Permit2 is not hashing under the out-of-band mainnet domain separator the deposit digest literal was derived for"
        );

        _allowlistToken();

        deal(TOKEN, ESCROW, AMOUNT);
        deal(TOKEN, DEPOSITOR, PERMIT_AMOUNT);
        vm.prank(DEPOSITOR);
        IERC20(TOKEN).approve(PERMIT2, type(uint256).max);
    }

    /// @dev The etched escrow starts with EMPTY storage, so it has no admin and no allowlisted
    /// token. Grant TOKEN_CONFIG_ROLE by poking AccessControl's `_roles` mapping and then
    /// configure the token through the contract's OWN public API, so the fee parameters come
    /// from the contract rather than from a hand-packed storage word. Both steps are verified
    /// through public getters, so a storage-layout change fails loudly instead of no-op'ing.
    function _allowlistToken() private {
        bytes32 role = s_escrow.TOKEN_CONFIG_ROLE();
        bytes32 roleDataSlot = keccak256(abi.encode(role, ROLES_SLOT));
        vm.store(ESCROW, keccak256(abi.encode(address(this), roleDataSlot)), bytes32(uint256(1)));
        assertTrue(
            s_escrow.hasRole(role, address(this)),
            "TOKEN_CONFIG_ROLE seeding failed: AccessControl's `_roles` mapping is no longer at storage slot 2 (re-run `forge inspect src/Escrow.sol:Escrow storageLayout`)"
        );

        s_escrow.allowTokenAndSetFeeConfig(IERC20(TOKEN), TOKEN_DECIMALS, FEE_PERCENTAGE, 0, MAX_FEE);
        assertEq(
            s_escrow.determineFee(SOURCE_AMOUNT, s_escrow.getTokenConfig(IERC20(TOKEN))),
            DEPOSIT_FEE_AMOUNT,
            "the pinned fee configuration no longer produces DEPOSIT_FEE_AMOUNT for SOURCE_AMOUNT, so DEPOSITED_ACTIVE_DEPOSIT_HASH must be re-derived out of band"
        );
    }

    /// @dev Seeds the stored ActiveDeposit hash from the out-of-band literal.
    function _seedActiveDeposit() private {
        vm.store(ESCROW, keccak256(abi.encode(DEPOSIT_ID, ACTIVE_DEPOSIT_HASHES_SLOT)), CANONICAL_ACTIVE_DEPOSIT_HASH);
        assertEq(
            s_escrow.getDepositHash(DEPOSIT_ID),
            CANONICAL_ACTIVE_DEPOSIT_HASH,
            "ActiveDeposit hash seeding failed: s_activeDepositHashes is no longer at storage slot 9 (re-run `forge inspect src/Escrow.sol:Escrow storageLayout`)"
        );
    }

    function _signLiteral(uint256 privateKey, bytes32 digestLiteral) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digestLiteral);
        return abi.encodePacked(r, s, v);
    }

    function _releaseWitness() private pure returns (IEscrow.ReleaseWitness memory) {
        return IEscrow.ReleaseWitness({
            depositId: DEPOSIT_ID,
            quoteHash: QUOTE_HASH,
            depositRequestHash: DEPOSIT_REQUEST_HASH,
            destinationHash: DESTINATION_HASH,
            depositor: DEPOSITOR,
            token: TOKEN,
            amount: AMOUNT,
            feeAmount: FEE_AMOUNT,
            reserver: RESERVER,
            releaser: RELEASER,
            settler: SETTLER
        });
    }

    function _refundWitness() private pure returns (IEscrow.RefundWitness memory) {
        return IEscrow.RefundWitness({
            depositId: DEPOSIT_ID,
            quoteHash: QUOTE_HASH,
            depositRequestHash: DEPOSIT_REQUEST_HASH,
            destinationHash: DESTINATION_HASH,
            depositor: DEPOSITOR,
            token: TOKEN,
            amount: AMOUNT,
            feeAmount: FEE_AMOUNT,
            reserver: RESERVER,
            releaser: RELEASER,
            settler: SETTLER
        });
    }

    /// @dev Turns a revert from the guarded call into a message that names the actual defect.
    function _reportDrift(string memory leg, string memory witnessName, bytes memory err) private {
        bytes4 selector = err.length >= 4 ? bytes4(err) : bytes4(0);

        if (selector == IEscrow.InvalidSignature.selector) {
            fail(
                string.concat(
                    "src/Escrow.sol's ",
                    leg,
                    " DIGEST ENCODE ORDER HAS DRIFTED from the canonical ",
                    witnessName,
                    " type string. The releaser signed the out-of-band EIP-712 digest literal derived from that type string and the contract recovered a different signer, so the abi.encode(...) value order in _",
                    leg,
                    "()'s struct hash (or ",
                    witnessName,
                    "'s typehash constant, or the EIP-712 domain) no longer matches the published type string. No test-side encoder is involved in this check. If this is shipped, EVERY releaser signature fails InvalidSignature and release AND refund revert forever - the escrow has no rescue function."
                )
            );
        } else if (selector == IEscrow.InvalidWitnessValues.selector) {
            fail(
                string.concat(
                    "src/Escrow.sol's ActiveDeposit reconstruction in _",
                    leg,
                    "() has drifted: the tuple it rebuilds from the ",
                    witnessName,
                    " no longer hashes to the out-of-band ActiveDeposit hash literal. Check the ActiveDeposit field order/membership in src/interfaces/IEscrow.sol and the reconstruction in src/Escrow.sol."
                )
            );
        } else {
            fail(string.concat(leg, " reverted unexpectedly with ", vm.toString(err)));
        }
    }

    /// CORE-2120: release() must accept a signature over the canonical release digest literal.
    function test_release_acceptsSignatureOverOutOfBandCanonicalDigest() public {
        _seedActiveDeposit();

        uint256 settlerBalanceBefore = IERC20(TOKEN).balanceOf(SETTLER);

        try s_escrow.release(
            IEscrow.ReleaseInput({
                releaseWitness: _releaseWitness(),
                releaseSignature: _signLiteral(RELEASER_PRIVATE_KEY, CANONICAL_RELEASE_DIGEST)
            })
        ) {
            assertEq(s_escrow.getDepositHash(DEPOSIT_ID), bytes32(0), "deposit not cleared by release");
            assertEq(
                IERC20(TOKEN).balanceOf(SETTLER),
                settlerBalanceBefore + AMOUNT - FEE_AMOUNT,
                "settler did not receive amount - feeAmount"
            );
        } catch (bytes memory err) {
            _reportDrift("release", "ReleaseWitness", err);
        }
    }

    /// CORE-2120: refund() must accept a signature over the canonical refund digest literal.
    /// Refund is the escape hatch, so a digest drift here is the worst case of all.
    function test_refund_acceptsSignatureOverOutOfBandCanonicalDigest() public {
        _seedActiveDeposit();

        uint256 depositorBalanceBefore = IERC20(TOKEN).balanceOf(DEPOSITOR);

        try s_escrow.refund(
            IEscrow.RefundInput({
                refundWitness: _refundWitness(),
                refundSignature: _signLiteral(RELEASER_PRIVATE_KEY, CANONICAL_REFUND_DIGEST)
            })
        ) {
            assertEq(s_escrow.getDepositHash(DEPOSIT_ID), bytes32(0), "deposit not cleared by refund");
            assertEq(
                IERC20(TOKEN).balanceOf(DEPOSITOR),
                depositorBalanceBefore + AMOUNT,
                "depositor was not made whole by the refund"
            );
        } catch (bytes memory err) {
            _reportDrift("refund", "RefundWitness", err);
        }
    }

    /// CORE-2120: deposit() must accept a DEPOSITOR signature over the canonical Permit2
    /// `PermitWitnessTransferFrom` digest literal — i.e. over the digest an offchain signer that
    /// follows the published DepositWitness type string produces.
    ///
    /// This is the leg the fork suites cannot cover: Permit2 takes the witness as an opaque
    /// bytes32, so a helper-signed fork test only proves contract-vs-helper agreement. Here the
    /// signature is over a literal computed outside the repo, so it proves contract-vs-type-string
    /// agreement. A consistent transposition of the DepositWitness value list in src/Escrow.sol
    /// and test/helpers/Signatures.sol leaves the rest of the suite green and fails HERE.
    function test_deposit_acceptsSignatureOverOutOfBandCanonicalPermit2Digest() public {
        vm.warp(DEPOSIT_TIMESTAMP);

        uint256 escrowBalanceBefore = IERC20(TOKEN).balanceOf(ESCROW);
        uint256 depositorBalanceBefore = IERC20(TOKEN).balanceOf(DEPOSITOR);

        try s_escrow.deposit(
            IEscrow.DepositInput({
                permit: ISignatureTransfer.PermitTransferFrom({
                    permitted: ISignatureTransfer.TokenPermissions({token: TOKEN, amount: PERMIT_AMOUNT}),
                    nonce: PERMIT_NONCE,
                    deadline: PERMIT_DEADLINE
                }),
                depositor: DEPOSITOR,
                depositWitness: IEscrow.DepositWitness({
                    depositRequestHash: DEPOSIT_REQUEST_HASH,
                    destination: DESTINATION,
                    reserver: RESERVER,
                    releaser: RELEASER
                }),
                depositSignature: _signLiteral(DEPOSITOR_PRIVATE_KEY, CANONICAL_DEPOSIT_DIGEST),
                reserveWitness: IEscrow.ReserveWitness({
                    depositId: CANONICAL_DEPOSIT_ID,
                    quoteHash: QUOTE_HASH,
                    settler: SETTLER,
                    sourceAmount: SOURCE_AMOUNT
                }),
                reserveSignature: _signLiteral(RESERVER_PRIVATE_KEY, CANONICAL_RESERVE_DIGEST)
            })
        ) returns (
            bytes32 depositId
        ) {
            assertEq(depositId, CANONICAL_DEPOSIT_ID, "deposit() returned a depositId other than the pinned one");
            // Pins the ActiveDeposit field order on the WRITE path, against a literal derived
            // out of band - unlike a rebuild-and-compare, which mirrors the contract.
            assertEq(
                s_escrow.getDepositHash(depositId),
                DEPOSITED_ACTIVE_DEPOSIT_HASH,
                "the ActiveDeposit tuple src/Escrow.sol stored does not hash to the out-of-band literal: its field order/membership, the destination hashing, or the fee it charged has drifted"
            );
            // The charge is the reserver-attested sourceAmount, never the permit ceiling.
            assertEq(
                IERC20(TOKEN).balanceOf(ESCROW),
                escrowBalanceBefore + SOURCE_AMOUNT,
                "escrow did not receive exactly sourceAmount"
            );
            assertEq(
                IERC20(TOKEN).balanceOf(DEPOSITOR),
                depositorBalanceBefore - SOURCE_AMOUNT,
                "depositor was not debited exactly sourceAmount"
            );
        } catch (bytes memory err) {
            _reportDepositDrift(err);
        }
    }

    /// @dev Turns a revert from the guarded deposit into a message that names the actual defect.
    function _reportDepositDrift(bytes memory err) private {
        bytes4 selector = err.length >= 4 ? bytes4(err) : bytes4(0);

        if (selector == SignatureVerification.InvalidSigner.selector) {
            fail(
                "src/Escrow.sol's DEPOSIT WITNESS DIGEST ENCODE ORDER HAS DRIFTED from the canonical DepositWitness type string. The depositor signed the out-of-band Permit2 PermitWitnessTransferFrom digest literal derived from that type string, and real Permit2 recovered a different signer - so the abi.encode(...) value order in _deposit()'s depositWitnessHash (or DEPOSIT_WITNESS_TYPE_HASH, or FULL_DEPOSIT_WITNESS_TYPE_STRING, or the `string destination` member no longer being hashed as keccak256(bytes(destination))) no longer matches the published type string. No test-side encoder is involved in this check, and the fork suites CANNOT catch this: Permit2 takes the witness as an opaque bytes32. If this is shipped, every depositor signature fails InvalidSigner and NO DEPOSIT CAN EVER SUCCEED."
            );
        } else if (selector == IEscrow.InvalidSignature.selector) {
            fail(
                "src/Escrow.sol's RESERVE WITNESS DIGEST ENCODE ORDER HAS DRIFTED from the canonical ReserveWitness type string: the reserver signed the out-of-band digest literal for (CANONICAL_DEPOSIT_ID, QUOTE_HASH, SETTLER, SOURCE_AMOUNT) and the contract recovered a different signer. Check the abi.encode(...) order in _deposit()'s reserveWitnessHash, RESERVE_WITNESS_TYPE_HASH, and the EIP-712 domain."
            );
        } else if (selector == IEscrow.DepositNotFound.selector) {
            fail(
                "deposit() computed a different depositId than CANONICAL_DEPOSIT_ID. Either keccak256(abi.encode(depositor, depositSignature, permit.nonce)) changed, or the signature bytes vm.sign produces for DEPOSITOR over CANONICAL_DEPOSIT_DIGEST changed. Re-derive CANONICAL_DEPOSIT_ID (and then CANONICAL_RESERVE_DIGEST and DEPOSITED_ACTIVE_DEPOSIT_HASH, which depend on it) OUT OF BAND."
            );
        } else {
            fail(string.concat("deposit reverted unexpectedly with ", vm.toString(err)));
        }
    }

    /// @dev Provenance of the etched Permit2: real mainnet code, not a stand-in. Live mainnet
    /// Permit2 (0x000000000022D473030F116dDEE9F6B43aC78BA3) has the same 9152-byte length and
    /// differs from this blob in exactly 34 bytes, all inside the `_CACHED_CHAIN_ID` /
    /// `_CACHED_DOMAIN_SEPARATOR` immutables — which the setUp assertion neutralises by running
    /// at chain id 1, where Permit2 rebuilds the separator. Re-verify with
    /// `cast code --rpc-url <mainnet> 0x000000000022D473030F116dDEE9F6B43aC78BA3`.
    function test_etchedPermit2IsRealPermit2() public view {
        assertEq(PERMIT2.code.length, PERMIT2_CODE_LENGTH, "etched Permit2 runtime code changed length");
        assertEq(
            keccak256(PERMIT2.code),
            PERMIT2_CODE_HASH,
            "etched Permit2 runtime code changed: lib/permit2's precompiled blob is no longer the bytecode this guard was pinned against - re-verify it against live mainnet Permit2 before updating this literal"
        );
    }

    // Deliberately NO `test_canonicalDigestLiteralsAllDiffer`. It compared the four `CANONICAL_*`
    // digest literals only with each other, which cannot fail in a way the suite does not already
    // catch: the copy/paste it was meant to guard against is caught by the leg that uses the
    // duplicated literal. Signing the release digest and passing it to refund() (or the reserve
    // digest and passing it to the deposit leg) makes the contract recover a different signer, the
    // call reverts, and `_reportDrift` / `_reportDepositDrift` fails with a message naming the leg.
    // Each of the four literals is exercised by exactly such a require-success leg above, so a
    // duplicate among them cannot survive - and an inequality check between four constants in this
    // file adds no detection, only the appearance of it.
}
