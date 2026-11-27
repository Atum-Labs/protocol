// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IPermit2, ISignatureTransfer} from "permit2/src/interfaces/IPermit2.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEscrow} from "./interfaces/IEscrow.sol";
import {EscrowReserveLib} from "./EscrowReserveLib.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ITokenConfig} from "./interfaces/ITokenConfig.sol";

contract Escrow is IEscrow, ITokenConfig, EIP712, AccessControlDefaultAdminRules, Pausable {
    using SafeERC20 for IERC20;
    using SignatureChecker for address;

    // Roles
    // Pauser role can pause and unpause the contract
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    // Treasurer role can withdraw fees from the contract
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");
    // Token config role can configure token fees
    bytes32 public constant TOKEN_CONFIG_ROLE = keccak256("TOKEN_CONFIG_ROLE");

    // EIP-712 Witnesses
    // Full type string for Permit2 deposit witness
    string private constant FULL_DEPOSIT_WITNESS_TYPE_STRING =
        "DepositWitness witness)DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)TokenPermissions(address token,uint256 amount)";
    // Type string hash for EIP-712 deposit witness
    // keccak256("DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)");
    bytes32 private constant DEPOSIT_WITNESS_TYPE_HASH =
        0x49bfb2c307c3a42001389497e5f5b9dc592052768c1f3cdf09aac3c58ec582b9;
    // Length cap on the committed destination, in bytes. This is a CALLDATA BOUND, not a format
    // check: the ratified grammar is a protocol-level agreement and this contract imposes none of it
    // on the string (see the note above IEscrow.DepositWitness), so a destination that violates the
    // grammar is accepted here and only fails later, as a hash mismatch at settlement, if the
    // producer and the consumer spelled it differently. Every destination a deposit fixture in this
    // repo signs is an eip155 CAIP-19 asset, an "@", and a hex account, and the widest of them is
    // 104 bytes; the canonical Solana example (a base58 CAIP-19 asset plus a base58 account, pinned
    // in test/Destination.canonicalExamples.t.sol) is exactly 135. 256 leaves headroom for a longer
    // chain id or a wider account encoding without allowing unbounded calldata. No non-eip155
    // destination has been exercised against the contract itself; do not read this bound as
    // evidence that one has.
    // (Plain comments, not natspec: solc parses an "@" inside a doc block as a tag.)
    uint256 private constant MAX_DESTINATION_BYTES = 256;
    // Type string for EIP-712 reserve witness
    // keccak256("ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)");
    bytes32 private constant RESERVE_WITNESS_TYPE_HASH =
        0x231586e09714868d376f25b00c3a8dc8e307d350b64e22fbeb6578bb7bc6fd87;
    // Domain tag of the direct deposit id derivation. Permit2-path ids are
    // keccak256(abi.encode(address, bytes, uint256)), so a direct id can never collide with one:
    // the first word of the preimage is this constant versus a left-padded address.
    // keccak256("Escrow:directDeposit:v1")
    bytes32 private constant DIRECT_DEPOSIT_DOMAIN_TAG =
        0x1068ed79299dece4fd0180347a11cf387785d59a06e33eaa740cd341b3134c97;
    // Type string for EIP-712 release witness
    // keccak256("ReleaseWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)");
    bytes32 private constant RELEASE_WITNESS_TYPE_HASH =
        0x7b53386f16fef70a2a3ea71bda140486e6167753168b12a94b218b94de37fe7b;
    // Type string for EIP-712 refund witness
    // keccak256("RefundWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)");
    bytes32 private constant REFUND_WITNESS_TYPE_HASH =
        0x3b5d88b2664086649c47fb1bddafbc2c1f05c6be52fb1c1f11c53db3c608772d;

    // Maximum supported token decimals to prevent overflow in fee calculations
    // Tokens with >30 decimals and large supplies could overflow uint256 during fee calculation
    uint8 private constant MAX_TOKEN_DECIMALS = 30;

    // Permit2 contract
    IPermit2 public immutable i_permit2;

    // Allowlist for tokens that are allowed to be used for deposits
    mapping(IERC20 token => TokenConfig tokenConfig) private s_tokenConfigs;
    IERC20[] private s_allowlistedTokens;

    // Total fees collected for each token
    mapping(IERC20 token => uint256 feeRevenue) private s_tokenFeeRevenue;

    /// @dev Mapping of depositId to keccak256 hash of ActiveDeposit struct
    /// @dev This replaces direct storage of ActiveDeposit structs for gas optimization
    /// @dev Hash validation ensures data integrity while reducing storage costs
    mapping(bytes32 depositId => bytes32 activeDepositHash) private s_activeDepositHashes;

    /// @dev Per-owner unordered nonce bitmap for `directDeposit`, the shape of Permit2's
    /// `nonceBitmap`: word = nonce >> 8, bit = nonce & 0xff. A set bit is never cleared, so a direct
    /// deposit id can never be re-funded after release or refund (the active-hash check alone cannot
    /// see a completed deposit, see `_storeActiveDeposit`). A caller whose nonces are uniformly
    /// distributed over 256 bits lands every deposit in its own word: one never-cleared slot per
    /// deposit, the same storage a per-purchase record would write.
    mapping(address owner => mapping(uint256 wordPos => uint256 bitmap)) private s_directNonceBitmap;

    /// @dev Fee terms fixed at funding, retained only while a direct deposit is unreserved.
    mapping(bytes32 depositId => TokenConfig tokenConfig) private s_directDepositFeeConfigs;

    /**
     * @notice Deploys the Escrow contract with Permit2 integration and role-based access control.
     * @param permit2 The Permit2 contract address (immutable after deployment)
     * @param defaultAdmin The initial default admin address (typically the deployer)
     * @dev The initial admin transfer delay is set to 1 second for deployment convenience.
     *      This delay only governs DEFAULT_ADMIN_ROLE transfers and delay changes — it does
     *      NOT affect grantRole/revokeRole calls, which are immediate for any admin.
     *      The low delay allows the deployer to quickly:
     *      1. Transfer DEFAULT_ADMIN_ROLE to a multisig (the only step gated by this delay)
     *
     *      Granting operational roles (PAUSER_ROLE, TREASURER_ROLE, TOKEN_CONFIG_ROLE) is
     *      immediate and can happen before or after the transfer.
     *
     *      After the multisig accepts admin, it SHOULD increase the delay by calling
     *      `changeDefaultAdminDelay(newDelay)` with an appropriate value (e.g., 2 days).
     *      The delay change is also scheduled, providing additional protection.
     */
    constructor(IPermit2 permit2, address defaultAdmin)
        EIP712("Escrow", "3") // EIP-712 domain for Escrow contract
        AccessControlDefaultAdminRules(1, defaultAdmin)
    {
        require(address(permit2) != address(0), Permit2CannotBeZeroAddress());
        i_permit2 = permit2;
    }

    ////////////////////////
    /// ESCROW FUNCTIONS ///
    ////////////////////////

    /// @inheritdoc IEscrow
    function deposit(DepositInput calldata depositInput) external whenNotPaused returns (bytes32 depositId) {
        TokenConfig memory tokenConfig = s_tokenConfigs[IERC20(depositInput.permit.permitted.token)];
        // Check that the token is allowlisted
        require(tokenConfig.tokenDecimals != 0, TokenNotAllowed(IERC20(depositInput.permit.permitted.token)));
        uint256 feeAmount = determineFee(depositInput.reserveWitness.sourceAmount, tokenConfig);
        depositId = _deposit(depositInput, feeAmount);
        // `DepositCommitments` carries the two ActiveDeposit members `Deposited` deliberately does
        // not (its topic0 is kept stable), so a log-only consumer can rebuild a Release/RefundWitness
        // — refund is the escape hatch and this escrow has no rescue function.
        //
        // Emitted HERE and not in the shared `_deposit`, so `depositMany()` does not emit it: that
        // path already carries BOTH COMMITMENTS in `DepositedMany`'s `DepositWitness[]`, and a
        // per-item emit would pay LOG gas x N to duplicate them. (`DepositedMany` is still short of
        // `depositor` and `token`, which a batch consumer reads from the item's ERC-20 `Transfer`
        // log; this event carries neither, so emitting it there would not close that.) The
        // asymmetry is deliberate — see the `DepositCommitments` natspec in IEscrow.
        //
        // `keccak256(bytes(destination))` is recomputed rather than plumbed out of `_deposit`:
        // hashing <=256 bytes costs ~80 gas, whereas an extra `_deposit` return value would put a
        // word on the stack of the batch loop too, for a value only this path uses.
        _emitDepositLogs(
            depositId,
            depositInput.depositor,
            depositInput.permit.permitted.token,
            depositInput.reserveWitness.sourceAmount,
            feeAmount,
            depositInput.reserveWitness.quoteHash,
            depositInput.reserveWitness.settler,
            depositInput.depositWitness,
            keccak256(bytes(depositInput.depositWitness.destination))
        );
    }

    /// @inheritdoc IEscrow
    function directDeposit(DirectDepositInput calldata input) external whenNotPaused returns (bytes32 depositId) {
        IERC20 token = IERC20(input.token);
        TokenConfig memory tokenConfig = s_tokenConfigs[token];
        require(tokenConfig.tokenDecimals != 0, TokenNotAllowed(token));
        // The witness checks the Permit2 path applies, same helper, same order. Not optional: a
        // deposit stored with a zero releaser could never be released or refunded.
        _requireDepositWitness(input.depositWitness);
        require(input.amount > 0, DepositAmountCannotBeZero());
        // Hashed once, after the length bound above, for the id, the stored tuple and the log
        bytes32 destinationHash = keccak256(bytes(input.depositWitness.destination));
        _useDirectNonce(msg.sender, input.nonce);

        // There is no depositor signature to hash, so the id binds every member the signature
        // would have covered. Every member is a static type; see the derivation in IEscrow.
        depositId = _directDepositId(
            msg.sender,
            input.token,
            input.nonce,
            _depositWitnessHash(input.depositWitness, destinationHash),
            input.amount
        );
        s_directDepositFeeConfigs[depositId] = tokenConfig;

        // Stored unreserved: `reserve()` fills quoteHash and settler and charges the quote
        _storeActiveDeposit(
            depositId,
            ActiveDeposit({
                depositor: msg.sender,
                quoteHash: bytes32(0),
                depositRequestHash: input.depositWitness.depositRequestHash,
                destinationHash: destinationHash,
                token: input.token,
                amount: input.amount,
                // No fee until `reserve()` fixes the charged amount
                feeAmount: 0,
                reserver: input.depositWitness.reserver,
                releaser: input.depositWitness.releaser,
                settler: address(0)
            })
        );

        // The owner approved `amount` in the same batch. Pulled last, after every state write,
        // and measured like the Permit2 pull so a short or inflated delivery is not credited.
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), input.amount);
        _requireExactTransfer(token, balanceBefore, input.amount);

        // Same two logs as `deposit()`, with the caller as depositor and zeros for the reserve
        // members and the fee. The logs do not distinguish the two paths; a consumer that needs to
        // must inspect the call's own input (one of the batch's calls on Tempo), or a trace when
        // the caller is a contract.
        _emitDepositLogs(
            depositId,
            msg.sender,
            input.token,
            input.amount,
            0,
            bytes32(0),
            address(0),
            input.depositWitness,
            destinationHash
        );
    }

    /// @inheritdoc IEscrow
    /// @dev The body lives in `EscrowReserveLib` (delegatecall) for size, see the note there. The
    ///      argument is left unnamed on purpose: the library decodes the raw calldata itself, and
    ///      naming it here would make the escrow decode it a second time.
    function reserve(ReserveInput calldata) external whenNotPaused {
        EscrowReserveLib.reserve(
            s_activeDepositHashes, s_tokenConfigs, s_directDepositFeeConfigs, msg.data[4:], _domainSeparatorV4()
        );
    }

    /// @dev The direct deposit id; see the derivation documented on `IEscrow.directDeposit`.
    function _directDepositId(address owner, address token, uint256 nonce, bytes32 depositWitnessHash, uint256 amount)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                DIRECT_DEPOSIT_DOMAIN_TAG, block.chainid, address(this), owner, token, nonce, depositWitnessHash, amount
            )
        );
    }

    /// @dev The two logs every single-item deposit emits, from either path. Not called from
    ///      `depositMany()`, see the comment at the `deposit()` call site.
    function _emitDepositLogs(
        bytes32 depositId,
        address depositor,
        address token,
        uint256 amount,
        uint256 feeAmount,
        bytes32 quoteHash,
        address settler,
        DepositWitness calldata depositWitness,
        bytes32 destinationHash
    ) private {
        emit Deposited(
            depositId,
            quoteHash,
            depositor,
            settler,
            token,
            amount,
            feeAmount,
            depositWitness.reserver,
            depositWitness.releaser
        );
        emit DepositCommitments(depositId, depositWitness.depositRequestHash, destinationHash);
    }

    /// @inheritdoc IEscrow
    /// @dev To optimize for gas, the offchain caller should order the deposits by token.
    /// This makes the most effective use of the storage cache in the loop.
    function depositMany(DepositInput[] calldata depositInputs)
        external
        whenNotPaused
        returns (bytes32[] memory depositIds)
    {
        depositIds = new bytes32[](depositInputs.length);
        DepositWitness[] memory depositWitnesses = new DepositWitness[](depositInputs.length);
        ReserveWitness[] memory reserveWitnesses = new ReserveWitness[](depositInputs.length);
        uint256[] memory feeAmounts = new uint256[](depositInputs.length);

        // Optimization: cache the latest token and token config
        IERC20 currentToken;
        TokenConfig memory currentConfig;
        for (uint256 i; i < depositInputs.length; i++) {
            IERC20 token = IERC20(depositInputs[i].permit.permitted.token);

            // Only read from storage if the token has changed
            // i == 0 ensures first token always triggers allowlist check regardless of its address
            if (i == 0 || token != currentToken) {
                currentToken = token;
                currentConfig = s_tokenConfigs[token];
                require(currentConfig.tokenDecimals != 0, TokenNotAllowed(token));
            }

            uint256 feeAmount = determineFee(depositInputs[i].reserveWitness.sourceAmount, currentConfig);
            depositIds[i] = _deposit(depositInputs[i], feeAmount);
            feeAmounts[i] = feeAmount;
            depositWitnesses[i] = depositInputs[i].depositWitness;
            reserveWitnesses[i] = depositInputs[i].reserveWitness;
        }
        emit DepositedMany(depositIds, depositWitnesses, reserveWitnesses, feeAmounts);
    }

    function _deposit(DepositInput calldata depositInput, uint256 feeAmount) private returns (bytes32 depositId) {
        // Check that the depositor is not the zero address
        require(depositInput.depositor != address(0), DepositCannotBeZeroAddress());
        _requireDepositWitness(depositInput.depositWitness);
        _requireReserveWitness(depositInput.reserveWitness);
        // Check that the amount is not zero
        require(depositInput.permit.permitted.amount > 0, DepositAmountCannotBeZero());
        // The winning source amount is the charge; the permit amount is only an authorization ceiling
        require(
            depositInput.reserveWitness.sourceAmount > 0
                && depositInput.reserveWitness.sourceAmount <= depositInput.permit.permitted.amount,
            InvalidSourceAmount()
        );
        // Generate a deposit ID from the depositor, signature, and permit nonce
        // This prevents griefing attacks where a malicious actor could front-run with another user's signature
        depositId =
            keccak256(abi.encode(depositInput.depositor, depositInput.depositSignature, depositInput.permit.nonce));
        // Check that the deposit ID matches the reserve witness deposit ID
        require(
            depositId == depositInput.reserveWitness.depositId, DepositNotFound(depositInput.reserveWitness.depositId)
        );

        bytes32 destinationHash = keccak256(bytes(depositInput.depositWitness.destination));
        // Every member is sourced explicitly by name; where each comes from:
        //   reserveWitness  -> quoteHash, settler, and sourceAmount (stored as `amount`)
        //   depositWitness  -> depositRequestHash, destination (stored hashed), reserver, releaser
        //   permit          -> token
        //   depositInput    -> depositor;  and feeAmount is passed in by the caller
        _storeActiveDeposit(
            depositId,
            ActiveDeposit({
                depositor: depositInput.depositor,
                quoteHash: depositInput.reserveWitness.quoteHash,
                depositRequestHash: depositInput.depositWitness.depositRequestHash,
                // Only the hash is stored: the plaintext destination is unbounded-width, and the
                // release/refund witnesses must be able to rebuild this tuple from fixed-width fields.
                destinationHash: destinationHash,
                token: depositInput.permit.permitted.token,
                amount: depositInput.reserveWitness.sourceAmount,
                feeAmount: feeAmount,
                reserver: depositInput.depositWitness.reserver,
                releaser: depositInput.depositWitness.releaser,
                settler: depositInput.reserveWitness.settler
            })
        );

        // We verify the reserve signature before the deposit signature so that the external call to permit2 happens last
        _verifyReserveSignature(
            depositInput.depositWitness.reserver, depositInput.reserveWitness, depositInput.reserveSignature
        );

        // Deposit signature verification block (permit2 transfer)
        {
            IERC20 depositToken = IERC20(depositInput.permit.permitted.token);
            // Snapshotted PER CALL, not once around the depositMany loop: two items of the same
            // token in one batch must each be checked against their own delta.
            uint256 balanceBefore = depositToken.balanceOf(address(this));
            // Execute permit2 transfer WITH witness validation
            i_permit2.permitWitnessTransferFrom(
                depositInput.permit,
                ISignatureTransfer.SignatureTransferDetails({
                    to: address(this), requestedAmount: depositInput.reserveWitness.sourceAmount
                }),
                depositInput.depositor,
                _depositWitnessHash(depositInput.depositWitness, destinationHash),
                FULL_DEPOSIT_WITNESS_TYPE_STRING,
                depositInput.depositSignature
            );
            _requireExactTransfer(depositToken, balanceBefore, depositInput.reserveWitness.sourceAmount);
        }
    }

    ///////////////////////////////
    /// PERMIT2 DEPOSIT HELPERS ///
    ///////////////////////////////

    /// @dev The reserve-witness checks of the Permit2 path: settler, quoteHash. The direct path's
    ///      twin is in `EscrowReserveLib.reserve`.
    function _requireReserveWitness(ReserveWitness calldata reserveWitness) private pure {
        // Check that the settler is not the zero address
        require(reserveWitness.settler != address(0), SettlerCannotBeZeroAddress());
        // Check that the offchain quote hash is not empty
        require(reserveWitness.quoteHash != bytes32(0), QuoteHashCannotBeEmpty());
    }

    /// @dev Verify the reserver signature using EIP-712 with minimal witness data. The depositId
    ///      cryptographically commits to all deposit details via the depositor's signature. The
    ///      direct path's twin is in `EscrowReserveLib.reserve`.
    function _verifyReserveSignature(
        address reserver,
        ReserveWitness calldata reserveWitness,
        bytes calldata reserveSignature
    ) private view {
        bytes32 reserveWitnessHash = keccak256(
            abi.encode(
                RESERVE_WITNESS_TYPE_HASH,
                reserveWitness.depositId,
                reserveWitness.quoteHash,
                reserveWitness.settler,
                reserveWitness.sourceAmount
            )
        );
        // Check that recovered address is the reserver from the original deposit witness
        require(
            reserver.isValidSignatureNow(_hashTypedDataV4(reserveWitnessHash), reserveSignature), InvalidSignature()
        );
    }

    /// @dev Measure what the escrow actually receives, rather than trusting the requested amount.
    ///      Shared with `directDeposit()`, despite the banner above. Every deposit shares one pooled
    ///      balance and the stored ActiveDeposit is credited with the pulled amount (sourceAmount
    ///      on `deposit()`, amount on `directDeposit()`), so a token that delivers less than it is asked for (fee-on-transfer,
    ///      which USDT can switch on at any time via its owner-settable fee) would have the
    ///      shortfall silently covered by other depositors' funds until a later release or refund
    ///      hits an empty pool and reverts. Refund is the escape hatch and there is no rescue
    ///      function, so those funds would be stranded.
    ///
    ///      Equality, not `>=`: `>=` would still accept a transfer hook that INFLATES the balance,
    ///      leaving dust in the pool that no witness can account for. A balance that DECREASES
    ///      across the transfer (a re-entrant token draining the escrow mid-call) underflows here
    ///      and reverts with a panic rather than this error -- still a revert, still no credit.
    function _requireExactTransfer(IERC20 token, uint256 balanceBefore, uint256 expected) private view {
        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        require(received == expected, NonExactTransfer(expected, received));
    }

    //////////////////////////////
    /// DIRECT DEPOSIT HELPERS ///
    //////////////////////////////

    /// @dev Flips the nonce's bit and reverts if it was already set (Permit2's `_useUnorderedNonce`,
    ///      keyed by the direct-deposit caller).
    function _useDirectNonce(address owner, uint256 nonce) private {
        // forge-lint: disable-next-line(incorrect-shift)
        uint256 bit = 1 << (nonce & 0xff);
        uint256 flipped = s_directNonceBitmap[owner][nonce >> 8] ^= bit;
        require(flipped & bit != 0, NonceAlreadyUsed(nonce));
    }

    /////////////////////////////////////////////////
    /// SHARED DEPOSIT HELPERS (Permit2 + direct) ///
    /////////////////////////////////////////////////

    /// @dev The deposit-witness checks both deposit paths apply, in this order: reserver, releaser,
    ///      depositRequestHash, destination bounds.
    function _requireDepositWitness(DepositWitness calldata depositWitness) private pure {
        // Check that the reserver is not the zero address
        require(depositWitness.reserver != address(0), ReserverCannotBeZeroAddress());
        // Check that the releaser is not the zero address
        require(depositWitness.releaser != address(0), ReleaserCannotBeZeroAddress());
        // Check that the depositor's commitment to the offchain deposit request is not empty.
        // Deposit paths only: this makes a zero depositRequestHash unstorable, after which the
        // release/refund hash-equality check binds the field without a repeat guard.
        require(depositWitness.depositRequestHash != bytes32(0), DepositRequestHashCannotBeEmpty());
        // Check that the committed destination is non-empty and within the size cap.
        // Enforced in-contract because ingress validation is bypassable by calling the escrow directly.
        uint256 destinationLength = bytes(depositWitness.destination).length;
        require(destinationLength != 0, DestinationCannotBeEmpty());
        require(destinationLength <= MAX_DESTINATION_BYTES, DestinationTooLong(destinationLength));
    }

    /// @dev Rejects a still-active duplicate, then stores the ActiveDeposit hash.
    function _storeActiveDeposit(bytes32 depositId, ActiveDeposit memory activeDeposit) private {
        // Rejects a still-ACTIVE duplicate only. It cannot see a COMPLETED one: `release`,
        // `refund` and `refundUnreserved` all `delete s_activeDepositHashes[depositId]`, so a finished deposit reads
        // back as zero and passes this check -- which is what IEscrow.sol's DepositNotFound
        // already documents ("either never existed or already completed (storage cleared)").
        //
        // Re-use of a COMPLETED depositId is prevented elsewhere, by a never-cleared nonce bitmap: on the
        // Permit2 path depositId is keccak256(depositor, depositSignature, permit.nonce) and the
        // permitWitnessTransferFrom consumes that nonce, so replaying the id necessarily replays a
        // spent nonce and Permit2 reverts first; on the direct path `_useDirectNonce` plays the
        // same role with the escrow's own bitmap.
        //
        // Stated explicitly because the two guards are easy to conflate (Cantina F3,
        // Jayfromthe13th): removing the nonce dependency in the belief that THIS check already
        // covers completed deposits would silently reopen completed-id re-use.
        require(s_activeDepositHashes[depositId] == bytes32(0), DepositAlreadyExists(depositId));
        s_activeDepositHashes[depositId] = keccak256(abi.encode(activeDeposit));
    }

    /// @dev EIP-712 struct hash of the DepositWitness. EIP-712 hashes a dynamic `string` member as
    ///      keccak256(bytes(value)); passing the raw string emits offset+len+data and matches no signer.
    ///      `destinationHash` is that hash, computed once by the caller.
    function _depositWitnessHash(DepositWitness calldata depositWitness, bytes32 destinationHash)
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                DEPOSIT_WITNESS_TYPE_HASH,
                depositWitness.depositRequestHash,
                destinationHash,
                depositWitness.reserver,
                depositWitness.releaser
            )
        );
    }

    /// @inheritdoc IEscrow
    function release(ReleaseInput calldata releaseInput) external whenNotPaused {
        _release(releaseInput);
        emit Released(
            releaseInput.releaseWitness.depositId,
            releaseInput.releaseWitness.settler,
            releaseInput.releaseWitness.token,
            releaseInput.releaseWitness.amount,
            releaseInput.releaseWitness.feeAmount
        );
    }

    /// @inheritdoc IEscrow
    function releaseMany(ReleaseInput[] calldata releaseInputs) external whenNotPaused {
        ReleaseWitness[] memory releaseWitnesses = new ReleaseWitness[](releaseInputs.length);
        for (uint256 i; i < releaseInputs.length; i++) {
            _release(releaseInputs[i]);
            releaseWitnesses[i] = releaseInputs[i].releaseWitness;
        }
        emit ReleasedMany(releaseWitnesses);
    }

    /// 1. Validate settler is set (non-zero)
    /// 2. Reconstruct ActiveDeposit from witness data (including settler)
    /// 3. Compute hash and compare against stored hash
    /// 4. Clear storage (delete hash) before token transfer
    /// 5. Verify EIP-712 signature includes all witness fields
    /// Storage clearing provides replay protection - subsequent calls fail.
    function _release(ReleaseInput calldata releaseInput) private {
        // Check if settler is set (cannot release without settler). First, so an unreserved direct
        // deposit, whose faithful witness carries zeros for both, is refused for the actual reason
        require(releaseInput.releaseWitness.settler != address(0), NotReserved(releaseInput.releaseWitness.depositId));
        // Check that the offchain quote hash is not empty
        require(releaseInput.releaseWitness.quoteHash != bytes32(0), QuoteHashCannotBeEmpty());

        // Reconstruct ActiveDeposit from witness (must include settler), check it against the
        // stored hash, clear the slot and verify the releaser signature
        _consumeActiveDeposit(
            RELEASE_WITNESS_TYPE_HASH,
            releaseInput.releaseWitness.depositId,
            ActiveDeposit({
                depositor: releaseInput.releaseWitness.depositor,
                quoteHash: releaseInput.releaseWitness.quoteHash,
                depositRequestHash: releaseInput.releaseWitness.depositRequestHash,
                destinationHash: releaseInput.releaseWitness.destinationHash,
                token: releaseInput.releaseWitness.token,
                amount: releaseInput.releaseWitness.amount,
                feeAmount: releaseInput.releaseWitness.feeAmount,
                reserver: releaseInput.releaseWitness.reserver,
                releaser: releaseInput.releaseWitness.releaser,
                settler: releaseInput.releaseWitness.settler // Must match the stored deposit (set by deposit() or reserve())
            }),
            releaseInput.releaseSignature
        );

        // Add fees to total fees collected for token.
        // Checks-Effects-Interactions: this effect is booked BEFORE the outbound transfer below, so
        // a token that hands control to an untrusted callee mid-transfer cannot observe or act on a
        // state where the deposit has been paid out but the fee has not yet been accrued.
        s_tokenFeeRevenue[IERC20(releaseInput.releaseWitness.token)] += releaseInput.releaseWitness.feeAmount;

        // Transfer remaining tokens to settler
        IERC20(releaseInput.releaseWitness.token)
            .safeTransfer(
                releaseInput.releaseWitness.settler,
                releaseInput.releaseWitness.amount - releaseInput.releaseWitness.feeAmount
            );
    }

    /// @inheritdoc IEscrow
    function refund(RefundInput calldata refundInput) external whenNotPaused {
        _refund(refundInput);
        emit Refunded(
            refundInput.refundWitness.depositId,
            refundInput.refundWitness.depositor,
            refundInput.refundWitness.token,
            refundInput.refundWitness.amount
        );
    }

    /// @inheritdoc IEscrow
    function refundMany(RefundInput[] calldata refundInputs) external whenNotPaused {
        RefundWitness[] memory refundWitnesses = new RefundWitness[](refundInputs.length);
        for (uint256 i; i < refundInputs.length; i++) {
            _refund(refundInputs[i]);
            refundWitnesses[i] = refundInputs[i].refundWitness;
        }
        emit RefundedMany(refundWitnesses);
    }

    /// @inheritdoc IEscrow
    function refundUnreserved(RefundUnreservedInput calldata) external whenNotPaused {
        // Delegate the body to the existing linked library to stay below EIP-170.
        EscrowReserveLib.refundUnreserved(s_activeDepositHashes, s_directDepositFeeConfigs, msg.data[4:]);
    }

    /// @dev The stored hash must exist and equal the hash of `passed`, and the slot is cleared
    ///      BEFORE the caller's outbound transfer (reentrancy, and replay: a second call finds no
    ///      hash).
    function _clearActiveDeposit(bytes32 depositId, ActiveDeposit memory passed) private {
        // Check if deposit exists
        bytes32 activeDepositHash = s_activeDepositHashes[depositId];
        require(activeDepositHash != bytes32(0), DepositNotFound(depositId));

        // Validate witness data matches stored deposit (including settler)
        bytes32 passedHash = keccak256(abi.encode(passed));
        require(activeDepositHash == passedHash, InvalidWitnessValues(depositId, activeDepositHash, passedHash));

        // Clear storage before transfer (prevents reentrancy)
        delete s_activeDepositHashes[depositId];
    }

    /// @dev The settlement steps release and refund share, for a tuple the caller rebuilt from its
    ///      witness: `_clearActiveDeposit`, then the releaser's EIP-712 signature over the full
    ///      witness is verified. The witness struct hash is `typeHash` followed by the eleven
    ///      witness members in their declared order, which both ReleaseWitness and RefundWitness
    ///      share.
    function _consumeActiveDeposit(
        bytes32 typeHash,
        bytes32 depositId,
        ActiveDeposit memory passed,
        bytes calldata releaserSignature
    ) private {
        _clearActiveDeposit(depositId, passed);

        // Verify releaser signature using EIP-712 with full witness data
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
                depositId,
                passed.quoteHash,
                passed.depositRequestHash,
                passed.destinationHash,
                passed.depositor,
                passed.token,
                passed.amount,
                passed.feeAmount,
                passed.reserver,
                passed.releaser,
                passed.settler
            )
        );
        // Check that recovered address is the releaser
        require(
            passed.releaser.isValidSignatureNow(_hashTypedDataV4(structHash), releaserSignature), InvalidSignature()
        );
    }

    /// @dev Hash validation workflow:
    /// 1. Reconstruct ActiveDeposit from witness data
    /// 2. Compute hash and compare against stored hash
    /// 3. Clear storage (delete hash) before token transfer
    /// 4. Verify EIP-712 signature includes all witness fields
    /// 5. Transfer tokens back to original depositor
    /// Storage clearing provides replay protection - subsequent calls fail.
    function _refund(RefundInput calldata refundInput) private {
        // Check that the offchain quote hash is not empty. An unreserved direct deposit has none,
        // so the releaser cannot refund it; only its depositor can, with `refundUnreserved`
        require(refundInput.refundWitness.quoteHash != bytes32(0), QuoteHashCannotBeEmpty());
        // Reconstruct ActiveDeposit from witness, check it against the stored hash, clear the slot
        // and verify the releaser signature
        _consumeActiveDeposit(
            REFUND_WITNESS_TYPE_HASH,
            refundInput.refundWitness.depositId,
            ActiveDeposit({
                depositor: refundInput.refundWitness.depositor,
                quoteHash: refundInput.refundWitness.quoteHash,
                depositRequestHash: refundInput.refundWitness.depositRequestHash,
                destinationHash: refundInput.refundWitness.destinationHash,
                token: refundInput.refundWitness.token,
                amount: refundInput.refundWitness.amount,
                feeAmount: refundInput.refundWitness.feeAmount,
                reserver: refundInput.refundWitness.reserver,
                releaser: refundInput.refundWitness.releaser,
                settler: refundInput.refundWitness.settler // Must match the stored deposit (set by deposit() or reserve())
            }),
            refundInput.refundSignature
        );

        // Transfer tokens back to depositor
        IERC20(refundInput.refundWitness.token)
            .safeTransfer(refundInput.refundWitness.depositor, refundInput.refundWitness.amount);
    }

    /// @inheritdoc ITokenConfig
    /// @notice Calculates the protocol fee for a deposit based on token configuration
    /// @dev Fee calculation uses ceiling division to round in protocol's favor while maintaining precision.
    ///
    /// ## Algorithm Steps:
    /// 1. **Percentage Calculation**: Compute `⌈(amount × feePercentage) / 100_000_000⌉`
    ///    - Uses ceiling division: `(a * b + c - 1) / c` to round up
    ///    - Ensures protocol never loses fees due to rounding
    ///    - Single formula works for all token decimals (no scaling needed)
    ///
    /// 2. **Minimum Fee**: If `minFee6Decimals > 0` and calculated fee is below minimum, use minimum
    ///
    /// 3. **Maximum Fee**: If `maxFee6Decimals > 0` and calculated fee exceeds maximum, cap at maximum
    ///
    /// 4. **Safety Check**: Reverts if fee exceeds deposit amount (can happen with misconfigured high minFee on small deposits)
    ///
    /// ## Example (0.02% fee, $250 max, $100 USDC deposit):
    /// ```
    /// tokenDecimals = 6, feePercentage6Decimals = 20_000, maxFee6Decimals = 250_000_000
    /// feeAmount = ⌈(100e6 × 20_000) / 100_000_000⌉ = ⌈20_000⌉ = 20_000 = $0.02 ✓
    /// ```
    ///
    /// ## Overflow Safety:
    /// The multiplication `amount * feePercentage6Decimals` is safe for tokens with:
    /// - Decimals ≤ 30
    /// - Total supply < 10^60
    ///
    /// These constraints are enforced during token allowlisting. For reference:
    /// - uint256 max ≈ 1.15 × 10^77
    /// - Worst realistic case: 10^60 amount × 10^8 fee = 10^68 (safe)
    ///
    /// Tokens with >30 decimals or extreme supplies (>10^60) are NOT supported and will cause overflow.
    ///
    /// @param amount The deposit amount in the token's native decimals
    /// @param tokenConfig Token configuration containing fee parameters and decimals
    /// @return feeAmount The calculated fee in the token's native decimals (rounded up in protocol's favor)
    function determineFee(uint256 amount, TokenConfig memory tokenConfig) public pure returns (uint256 feeAmount) {
        return EscrowReserveLib.fee(amount, tokenConfig);
    }

    /// @inheritdoc IEscrow
    function getDepositHash(bytes32 depositId) external view returns (bytes32) {
        return s_activeDepositHashes[depositId];
    }

    /// @inheritdoc ITokenConfig
    function isTokenAllowed(IERC20 token) external view returns (bool isAllowed) {
        return _isTokenAllowed(token);
    }

    function _isTokenAllowed(IERC20 token) private view returns (bool isAllowed) {
        return s_tokenConfigs[token].tokenDecimals != 0;
    }

    /// @inheritdoc ITokenConfig
    function getDirectDepositFeeConfig(bytes32 depositId) external view returns (TokenConfig memory tokenConfig) {
        return s_directDepositFeeConfigs[depositId];
    }

    /// @inheritdoc ITokenConfig
    function getTokenConfig(IERC20 token) external view returns (TokenConfig memory tokenConfig) {
        return s_tokenConfigs[token];
    }

    /// @inheritdoc ITokenConfig
    function getAllowedTokens() external view returns (IERC20[] memory allowedTokens) {
        allowedTokens = s_allowlistedTokens;
    }

    /// @inheritdoc ITokenConfig
    function getFeeRevenue(IERC20 token) external view returns (uint256 revenue) {
        return s_tokenFeeRevenue[token];
    }

    // ADMIN FUNCTIONS (role-gated)

    /// @inheritdoc ITokenConfig
    function allowToken(IERC20 token, uint8 decimals) external onlyRole(TOKEN_CONFIG_ROLE) {
        _allowToken(token, decimals);
    }

    function _allowToken(IERC20 token, uint8 decimals) private {
        require(address(token) != address(0), TokenCannotBeZeroAddress());
        require(decimals != 0, TokenDecimalsCannotBeZero());
        require(decimals <= MAX_TOKEN_DECIMALS, TokenDecimalsExceedMaximum(decimals, MAX_TOKEN_DECIMALS));
        require(!_isTokenAllowed(token), TokenAlreadyAllowed(token));

        // Verify decimals against on-chain value if the token exposes decimals()
        (bool success, bytes memory returnData) = address(token).staticcall(abi.encodeWithSignature("decimals()"));
        if (success && returnData.length >= 32) {
            uint8 actualDecimals = abi.decode(returnData, (uint8));
            require(decimals == actualDecimals, TokenDecimalsMismatch(decimals, actualDecimals));
        }

        // Initialize with zero fees (fees configured separately via setTokenFeeConfig)
        s_tokenConfigs[token] =
            TokenConfig({feePercentage6Decimals: 0, maxFee6Decimals: 0, minFee6Decimals: 0, tokenDecimals: decimals});
        s_allowlistedTokens.push(token);

        emit TokenAllowed(token, decimals);
    }

    /// @inheritdoc ITokenConfig
    function setTokenFeeConfig(IERC20 token, uint88 feePercentage, uint80 minFee, uint80 maxFee)
        external
        onlyRole(TOKEN_CONFIG_ROLE)
    {
        _setTokenFeeConfig(token, feePercentage, minFee, maxFee);
    }

    function _setTokenFeeConfig(IERC20 token, uint88 feePercentage, uint80 minFee, uint80 maxFee) private {
        require(_isTokenAllowed(token), TokenNotAllowed(token));

        TokenConfig storage config = s_tokenConfigs[token];
        uint8 tokenDecimals = config.tokenDecimals;

        // Validate fee percentage does not exceed 100%
        // 100% = 100_000_000 in 6-decimal precision (100 * 10^6)
        if (feePercentage > 100_000_000) {
            revert FeePercentageExceedsMaximum(feePercentage);
        }

        // Validate fee bounds
        if (minFee > 0 && maxFee > 0) {
            require(minFee <= maxFee, MinFeeCannotBeGreaterThanMaxFee());
        }
        if (maxFee > 0 && feePercentage == 0) {
            revert FeePercentageCannotBeZeroWhenMaxFeeIsSet();
        }

        // Validate that minFee is representable in the token's decimals
        // This prevents silent rounding to zero for low-decimal tokens
        if (minFee > 0) {
            uint256 minFeeInTokenDecimals = (uint256(minFee) * (10 ** uint256(tokenDecimals))) / 1_000_000;
            if (minFeeInTokenDecimals == 0) {
                revert MinFeeNotRepresentable(minFee, tokenDecimals);
            }
        }

        // Validate that maxFee is representable in the token's decimals
        if (maxFee > 0) {
            uint256 maxFeeInTokenDecimals = (uint256(maxFee) * (10 ** uint256(tokenDecimals))) / 1_000_000;
            if (maxFeeInTokenDecimals == 0) {
                revert MaxFeeNotRepresentable(maxFee, tokenDecimals);
            }
        }

        // Update fee parameters (preserve decimals)
        config.feePercentage6Decimals = feePercentage;
        config.minFee6Decimals = minFee;
        config.maxFee6Decimals = maxFee;

        emit TokenFeesUpdated(token, feePercentage, minFee, maxFee);
    }

    /// @inheritdoc ITokenConfig
    function allowTokenAndSetFeeConfig(IERC20 token, uint8 decimals, uint88 feePercentage, uint80 minFee, uint80 maxFee)
        external
        onlyRole(TOKEN_CONFIG_ROLE)
    {
        _allowToken(token, decimals);
        _setTokenFeeConfig(token, feePercentage, minFee, maxFee);
    }

    /// @inheritdoc ITokenConfig
    function clearTokenFeeConfig(IERC20 token) external onlyRole(TOKEN_CONFIG_ROLE) {
        require(_isTokenAllowed(token), TokenNotAllowed(token));

        // Clear all fee parameters (preserve decimals)
        TokenConfig storage config = s_tokenConfigs[token];
        config.feePercentage6Decimals = 0;
        config.minFee6Decimals = 0;
        config.maxFee6Decimals = 0;

        emit TokenFeesCleared(token);
    }

    /// @inheritdoc ITokenConfig
    function disallowToken(IERC20 token) external onlyRole(TOKEN_CONFIG_ROLE) {
        require(_isTokenAllowed(token), CouldNotDisallowToken(token));

        delete s_tokenConfigs[token];

        // Find the index of the token in the allowlisted tokens array
        uint256 index = 0;
        uint256 arrayLength = s_allowlistedTokens.length;
        for (uint256 i; i < arrayLength; i++) {
            if (s_allowlistedTokens[i] == token) {
                index = i;
                break;
            }
        }

        // Swap the token with the last element and pop the last element
        s_allowlistedTokens[index] = s_allowlistedTokens[arrayLength - 1];
        s_allowlistedTokens.pop();
        emit TokenDisallowed(token);
    }

    /// @inheritdoc ITokenConfig
    function withdrawFeeRevenue(IERC20 token, address recipient) external onlyRole(TREASURER_ROLE) {
        require(recipient != address(0), RecipientCannotBeZeroAddress());
        require(recipient != address(this), RecipientCannotBeSelf());

        uint256 feeRevenue = s_tokenFeeRevenue[token];
        require(feeRevenue > 0, NoFeesToWithdraw(token));

        s_tokenFeeRevenue[token] = 0;
        token.safeTransfer(recipient, feeRevenue);
        emit FeeRevenueWithdrawn(token, recipient, feeRevenue);
    }

    ////////////////////////
    /// PAUSE FUNCTIONS ///
    ////////////////////////

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
