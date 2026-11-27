// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../contracts/Escrow.sol";
import {TIP712} from "../contracts/TIP712.sol";
import {IEscrow} from "../contracts/interfaces/IEscrow.sol";
import {IPermit2} from "@alexroan/permit2-tron/contracts/interfaces/IPermit2.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {MockToken6DecimalsTransferReturnsFalse} from "./mock/MockToken.sol";

/// @notice Pins the settlement struct-hash ENCODE ORDER to literals no code in this repo produced.
///
/// WHY THIS FILE EXISTS. `quoteHash`, `depositRequestHash` and `destinationHash` are three adjacent
/// `bytes32` in both the settlement witnesses and the stored `ActiveDeposit` tuple. Transposing two of
/// them:
///   - compiles silently,
///   - moves no function selector and no event topic0 (the ABI type sequence is unchanged),
///   - and passes every test whose oracle shares the mistake.
/// That last point is not hypothetical here. Before this file existed, transposing
/// `depositRequestHash` and `destinationHash` in BOTH `Escrow.sol`'s `abi.encode` blocks AND
/// `foundry_tests/helpers/Signatures.sol` left the deposit-flow suite green at 70/70 — because
/// `Signatures.sol` is the oracle those tests check against, so both sides agreed while disagreeing
/// with the canonical type string. Shipped, every releaser signature would fail `InvalidSignature`,
/// so release AND refund would revert forever, and this escrow has no rescue function.
///
/// `make check-abi` cannot catch it either: it only runs `generate-abi` and fails if the output is
/// dirty, which is a "did you regenerate" check rather than a correctness check.
///
/// HOW THE GUARD WORKS. The struct hashes below were derived OUT OF BAND from the canonical type
/// strings, using an independent keccak-256 (not this package, not `Signatures.sol`, not any helper in
/// this repo). The test signs `keccak256(0x1901 ‖ escrow.DOMAIN_SEPARATOR() ‖ PINNED_STRUCT_HASH)` and
/// requires the contract to ACCEPT it. If `Escrow.sol`'s own `abi.encode` order drifts from the
/// canonical order, the contract computes a different struct hash, signature recovery yields a
/// different address, and the call reverts — so no test-side encoding participates in the assertion.
///
/// The stored `ActiveDeposit` hash is seeded from an out-of-band literal too, which pins the storage
/// tuple's field order independently of the witness encode order.
///
/// DO NOT repoint any literal in this file to make a failing test pass. Re-derive it out of band from
/// the canonical type string. Repointing converts an independent oracle into a self-fulfilling one and
/// reintroduces exactly the hazard documented above.
contract EscrowCanonicalDigestTest is Test {
    // Releaser key and its address. The address is baked into the pinned struct hashes, so setUp
    // asserts they still agree — a forge change to vm.addr would otherwise silently invalidate them.
    uint256 private constant RELEASER_PK = 0x000000000000000000000000000000000000000000000000000000000000b0b1;
    address private constant RELEASER = 0xeBaa10Eb0985A3f6F5e70E2DdB56E45ef3c16d4c;

    // Witness members the pinned hashes were derived from.
    bytes32 private constant DEPOSIT_ID =
        bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
    bytes32 private constant QUOTE_HASH =
        bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
    bytes32 private constant DEPOSIT_REQUEST_HASH =
        bytes32(uint256(0x3333333333333333333333333333333333333333333333333333333333333333));
    bytes32 private constant DESTINATION_HASH =
        bytes32(uint256(0x4444444444444444444444444444444444444444444444444444444444444444));
    address private constant DEPOSITOR = 0x000000000000000000000000000000000000d101;
    address private constant TOKEN = 0x000000000000000000000000000000000000d102;
    uint256 private constant AMOUNT = 1000;
    uint256 private constant FEE_AMOUNT = 7;
    address private constant RESERVER = 0x000000000000000000000000000000000000D103;
    address private constant SETTLER = 0x000000000000000000000000000000000000d105;

    /// keccak256(abi.encode(RELEASE_WITNESS_TYPE_HASH, <the 11 members above, in canonical order>))
    bytes32 private constant RELEASE_STRUCT_HASH = 0xbedd7be1a08fe470db5dd0f83a6a444e6130f282ffc2d02e187b4f107947f725;
    /// keccak256(abi.encode(REFUND_WITNESS_TYPE_HASH, <same 11 members>))
    bytes32 private constant REFUND_STRUCT_HASH = 0xfe3facd98053486c9bfa62e8523eea858e4432ca44db44915c0f9fdca88a9353;
    /// keccak256(abi.encode(ActiveDeposit)) for the same values, in declaration order.
    bytes32 private constant ACTIVE_DEPOSIT_HASH = 0xcc9206e59165de3ab685c5c49e81ce92065c8f435ebbefe82f65ffbd7da0dbd7;

    // Counterfactuals: the SAME members with `depositRequestHash` and `destinationHash` transposed,
    // also derived out of band. These are the values a transposed contract would produce.
    bytes32 private constant RELEASE_STRUCT_HASH_TRANSPOSED =
        0x38e07a22ff816bc4840531b299a4b64385d49b0c40490ead45cf7e26981e18e3;
    bytes32 private constant ACTIVE_DEPOSIT_HASH_TRANSPOSED =
        0x769a0d4a13763f0e486852ce85454e5512bb6d54a036b1bf135aa841f273780a;

    /// Storage slot of `s_activeDepositHashes` (confirmed with `forge inspect Escrow storageLayout`).
    uint256 private constant ACTIVE_DEPOSIT_HASHES_SLOT = 7;

    Escrow private s_escrow;

    function setUp() public {
        // TVM's constructor takes a USDT address that EVM's does not; any non-zero address satisfies
        // the zero-check and USDT plays no part in the signature path under test.
        s_escrow = new Escrow(IPermit2(vm.envAddress("PERMIT2_ADDRESS")), IERC20(TOKEN), address(this));

        // The pinned hashes bake in the releaser address; fail loudly rather than mysteriously if the
        // key-to-address mapping ever changes.
        assertEq(vm.addr(RELEASER_PK), RELEASER, "RELEASER does not match vm.addr(RELEASER_PK)");

        // Seed the stored ActiveDeposit hash from the out-of-band literal, then verify through the
        // public getter so a storage-layout change fails here instead of surfacing as a confusing
        // InvalidWitnessValues later.
        vm.store(address(s_escrow), keccak256(abi.encode(DEPOSIT_ID, ACTIVE_DEPOSIT_HASHES_SLOT)), ACTIVE_DEPOSIT_HASH);
        assertEq(
            s_escrow.getDepositHash(DEPOSIT_ID),
            ACTIVE_DEPOSIT_HASH,
            "seeding failed - re-run 'forge inspect Escrow storageLayout' and check the slot"
        );
    }

    function _releaseWitness() private pure returns (IEscrow.ReleaseWitness memory w) {
        w = IEscrow.ReleaseWitness({
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

    function _refundWitness() private pure returns (IEscrow.RefundWitness memory w) {
        w = IEscrow.RefundWitness({
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

    /// Sign the pinned struct hash under the contract's OWN domain separator. Only the struct hash is
    /// pinned; the domain is taken from the contract, so this test isolates the encode order — which is
    /// what drifts — rather than re-testing EIP-712 domain construction.
    function _signPinned(bytes32 pinnedStructHash) private view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", s_escrow.DOMAIN_SEPARATOR(), pinnedStructHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RELEASER_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    /// The token transfer is irrelevant to the signature check and would need a funded escrow, so it is
    /// mocked out. The assertion is that the contract ACCEPTED the signature over the pinned struct
    /// hash, which it can only do if its own encode order is canonical.
    /// @dev Puts a USDT-FAITHFUL token at the pinned TOKEN address.
    ///
    /// This used to be `vm.mockCall(TOKEN, bytes(""), abi.encode(true))` — a blanket mock making
    /// EVERY call to TOKEN return `true`, `balanceOf` included. So the payout in these tests moved
    /// nothing, `balanceOf` answered the same value before and after, and no assertion looked. The
    /// tests were pinning the struct-hash encode order, which they still do, but the settlement they
    /// drove was a no-op. `Escrow._usdtTransfer`'s balance-delta check is what surfaced that.
    ///
    /// TOKEN is also the address passed as the constructor's `usdt`, so these payouts take the USDT
    /// branch. `MockToken6DecimalsTransferReturnsFalse` is the honest stand-in for it: `transfer`
    /// moves the balance via `super.transfer` and then returns FALSE, which is exactly what Tron
    /// USDT does. That makes these tests exercise the quirk rather than paper over it.
    function _mockTransfers() private {
        MockToken6DecimalsTransferReturnsFalse usdt = new MockToken6DecimalsTransferReturnsFalse("Tether USD", "USDT");
        vm.etch(TOKEN, address(usdt).code);
        // Fund the escrow so a payout can actually be observed to move.
        deal(TOKEN, address(s_escrow), 1_000_000);
    }

    function test_releaseAcceptsSignatureOverPinnedCanonicalStructHash() public {
        _mockTransfers();
        IEscrow.ReleaseInput memory input = IEscrow.ReleaseInput({
            releaseWitness: _releaseWitness(), releaseSignature: _signPinned(RELEASE_STRUCT_HASH)
        });
        // Reverting here means Escrow.sol's release struct-hash encode order has DRIFTED from
        // "ReleaseWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32
        // destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address
        // reserver,address releaser,address settler)". Do NOT repoint RELEASE_STRUCT_HASH.
        s_escrow.release(input);
        assertEq(s_escrow.getDepositHash(DEPOSIT_ID), bytes32(0), "release did not clear the deposit");
    }

    function test_refundAcceptsSignatureOverPinnedCanonicalStructHash() public {
        _mockTransfers();
        IEscrow.RefundInput memory input =
            IEscrow.RefundInput({refundWitness: _refundWitness(), refundSignature: _signPinned(REFUND_STRUCT_HASH)});
        // Reverting here means Escrow.sol's refund struct-hash encode order has DRIFTED. Do NOT repoint.
        s_escrow.refund(input);
        assertEq(s_escrow.getDepositHash(DEPOSIT_ID), bytes32(0), "refund did not clear the deposit");
    }

    /// The stored-tuple field order is pinned independently of the witness encode order: setUp seeded
    /// the out-of-band ActiveDeposit hash, so a reordered ActiveDeposit declaration makes the
    /// reconstruction disagree with storage and the settlement reverts InvalidWitnessValues.
    function test_activeDepositTupleOrderIsPinnedByStorage() public {
        _mockTransfers();
        IEscrow.ReleaseInput memory input = IEscrow.ReleaseInput({
            releaseWitness: _releaseWitness(), releaseSignature: _signPinned(RELEASE_STRUCT_HASH)
        });
        s_escrow.release(input);
        assertEq(s_escrow.getDepositHash(DEPOSIT_ID), bytes32(0), "ActiveDeposit tuple order drifted from storage");
    }

    /// Proves the anchors discriminate. If a counterfactual equalled its anchor, the tests above could
    /// pass against a contract that made exactly that transposition.
    function test_counterfactualsDifferFromTheAnchors() public pure {
        assertTrue(
            RELEASE_STRUCT_HASH != RELEASE_STRUCT_HASH_TRANSPOSED,
            "transposed release struct hash equals the anchor - the anchor cannot detect that mistake"
        );
        assertTrue(
            ACTIVE_DEPOSIT_HASH != ACTIVE_DEPOSIT_HASH_TRANSPOSED,
            "transposed ActiveDeposit hash equals the anchor - the anchor cannot detect that mistake"
        );
    }

    /// TVM-specific: the contract masks the chain id (`block.chainid & 0xffffffff`, TIP712.sol) where
    /// EVM uses the raw value, and `Signatures.sol` builds its domain with the RAW chainid. That is
    /// latent today only because every Tron chain id is <= 2^32, so the mask is a no-op — but the two
    /// would diverge on any chain id above that. Pin the contract's masked behaviour so the divergence
    /// is caught here rather than in production.
    function test_domainSeparatorUsesTheMaskedChainId() public {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Escrow"),
                keccak256("3"),
                block.chainid & 0xffffffff,
                address(s_escrow)
            )
        );
        assertEq(
            s_escrow.DOMAIN_SEPARATOR(),
            expected,
            "DOMAIN_SEPARATOR does not match the TIP-712 masked-chainId construction in TIP712.sol"
        );
    }

    /// @notice The 32-bit mask is the only thing separating one Tron network's domain from another's.
    /// @dev name, version and verifyingContract are identical across deployments at the same CREATE2
    /// address, so two chains whose ids differ only ABOVE bit 32 would produce a byte-identical
    /// domain separator — and a release or refund signature from one would replay verbatim on the
    /// other. The mask is invisible in the digest, so nothing downstream could flag it.
    function test_everyTronChainIdInUseFitsTheMask() public pure {
        // mainnet, Nile, Shasta. If a future network's id exceeds this, the constructor guard below
        // stops the deployment rather than letting two networks silently share a domain.
        assertLe(uint256(0x2b6653dc), uint256(type(uint32).max), "Tron mainnet id must fit the mask");
        assertLe(uint256(0xcd8690dc), uint256(type(uint32).max), "Nile id must fit the mask");
        assertLe(uint256(0x94a9059e), uint256(type(uint32).max), "Shasta id must fit the mask");
    }

    function test_deployRevertsOnAChainIdWiderThanTheMask() public {
        // One bit above the mask: the smallest id that would alias onto chain id 0.
        uint256 tooWide = uint256(type(uint32).max) + 1;
        vm.chainId(tooWide);
        vm.expectRevert(abi.encodeWithSelector(TIP712.ChainIdExceedsTip712Mask.selector, tooWide));
        new Escrow(IPermit2(vm.envAddress("PERMIT2_ADDRESS")), IERC20(TOKEN), address(this));
    }
}
