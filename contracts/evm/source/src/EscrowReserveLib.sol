// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IEscrow} from "./interfaces/IEscrow.sol";
import {ITokenConfig} from "./interfaces/ITokenConfig.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title EscrowReserveLib
/// @notice `Escrow.reserve()`, as an external library the escrow delegatecalls (CORE-3048), and the
///         fee formula both deposit paths share.
/// @dev Here and not in `Escrow` for one reason only: EIP-170. The repo's optimizer profile
///      inlines every private helper, and with `reserve()` in the contract body `Escrow` is over the
///      limit. The ABI encoder and decoder for `ReserveInput` are the expensive part, which is why
///      the escrow hands over its RAW CALLDATA (`msg.data[4:]`) and this library decodes it:
///      passing the struct through would cost the escrow a second encoder. The live figures and
///      margin are in ONCHAIN_SPEC.md, "Contract size and the reserve library".
///
///      Runs under delegatecall, so `address(this)`, `block.chainid`, storage and the emitted
///      event are the escrow's; the escrow passes its storage mappings in. The reserve witness
///      typehash mirrors `Escrow`'s private one and test/EncodingExamples.verify.t.sol ties both
///      copies to their source.
library EscrowReserveLib {
    using SignatureChecker for address;
    using SafeERC20 for IERC20;

    // keccak256("ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)")
    bytes32 internal constant RESERVE_WITNESS_TYPE_HASH =
        0x231586e09714868d376f25b00c3a8dc8e307d350b64e22fbeb6578bb7bc6fd87;

    /// @notice The protocol fee on `amount` under `tokenConfig`; `Escrow.determineFee` documents the
    ///         algorithm. One copy of the formula for both deposit paths: `Escrow.determineFee`
    ///         returns this, and `reserve` calls it directly because it runs under delegatecall.
    function fee(uint256 amount, ITokenConfig.TokenConfig memory tokenConfig)
        internal
        pure
        returns (uint256 feeAmount)
    {
        // If no amount, return 0
        if (amount == 0) {
            return 0;
        }

        // Calculate percentage fee using ceiling division (rounds up in protocol's favor)
        // Formula: ⌈(a × b) / c⌉ = (a × b + c - 1) / c
        if (tokenConfig.feePercentage6Decimals > 0) {
            feeAmount = (amount * tokenConfig.feePercentage6Decimals + 100_000_000 - 1) / 100_000_000;
        }

        // Minimum fee protection: scale minFee from 10^6 to token decimals
        if (tokenConfig.minFee6Decimals > 0) {
            uint256 minFee =
                (uint256(tokenConfig.minFee6Decimals) * (10 ** uint256(tokenConfig.tokenDecimals))) / 1_000_000;
            if (feeAmount < minFee) {
                feeAmount = minFee;
            }
        }

        // Cap the fee amount at the maximum fee amount (if configured)
        if (tokenConfig.maxFee6Decimals > 0) {
            uint256 maxFee =
                (uint256(tokenConfig.maxFee6Decimals) * (10 ** uint256(tokenConfig.tokenDecimals))) / 1_000_000;
            if (feeAmount > maxFee) {
                feeAmount = maxFee;
            }
        }

        // Ensure fee never exceeds deposit amount
        if (feeAmount >= amount) {
            revert ITokenConfig.FeeExceedsDepositAmount(amount, feeAmount);
        }
    }

    /// @notice Sets settler and quote on an unreserved direct deposit and charges the winning quote:
    ///         stores the charged amount and its fee and refunds the rest. See `IEscrow.reserve`.
    /// @param hashes The escrow's active-deposit hash mapping
    /// @param configs The escrow's current token config mapping, used only for the live allowlist check
    /// @param depositFeeConfigs Fee terms snapshotted at direct deposit, consumed on successful reserve
    /// @param data The ABI encoding of the `ReserveInput` argument, i.e. the escrow's calldata
    ///        after the selector
    /// @param domainSeparator The escrow's EIP-712 domain separator, for the reserver signature
    function reserve(
        mapping(bytes32 => bytes32) storage hashes,
        mapping(IERC20 => ITokenConfig.TokenConfig) storage configs,
        mapping(bytes32 => ITokenConfig.TokenConfig) storage depositFeeConfigs,
        bytes calldata data,
        bytes32 domainSeparator
    ) external {
        IEscrow.ReserveInput memory input = abi.decode(data, (IEscrow.ReserveInput));
        bytes32 depositId = input.reserveWitness.depositId;
        bytes32 activeDepositHash = hashes[depositId];
        require(activeDepositHash != bytes32(0), IEscrow.DepositNotFound(depositId));

        bytes32 destinationHash = keccak256(bytes(input.depositWitness.destination));
        // The unreserved tuple, as `directDeposit` stored it. A deposit that is already reserved
        // hashes differently (quoteHash and settler set) and fails here like any wrong tuple. The
        // match is also all the binding the id needs: only `directDeposit` stores a tuple with a
        // zero quoteHash (`deposit()` rejects one), and it stores it under the id derived from
        // these same members, so the id is not re-derived here.
        IEscrow.ActiveDeposit memory activeDeposit = IEscrow.ActiveDeposit({
            depositor: input.depositor,
            quoteHash: bytes32(0),
            depositRequestHash: input.depositWitness.depositRequestHash,
            destinationHash: destinationHash,
            token: input.token,
            amount: input.amount,
            feeAmount: 0,
            reserver: input.depositWitness.reserver,
            releaser: input.depositWitness.releaser,
            settler: address(0)
        });
        bytes32 passedHash = keccak256(abi.encode(activeDeposit));
        require(activeDepositHash == passedHash, IEscrow.InvalidWitnessValues(depositId, activeDepositHash, passedHash));

        // The reserve-witness checks of the Permit2 path
        require(input.reserveWitness.settler != address(0), IEscrow.SettlerCannotBeZeroAddress());
        require(input.reserveWitness.quoteHash != bytes32(0), IEscrow.QuoteHashCannotBeEmpty());
        // The deposit is the payer's maximum; the winning quote charges at most that
        uint256 sourceAmount = input.reserveWitness.sourceAmount;
        require(sourceAmount != 0 && sourceAmount <= input.amount, IEscrow.InvalidSourceAmount());

        // The reserver signature, verified as `deposit()` verifies it
        bytes32 reserveWitnessHash = keccak256(
            abi.encode(
                RESERVE_WITNESS_TYPE_HASH,
                input.reserveWitness.depositId,
                input.reserveWitness.quoteHash,
                input.reserveWitness.settler,
                input.reserveWitness.sourceAmount
            )
        );
        require(
            input.depositWitness.reserver
                .isValidSignatureNow(
                    MessageHashUtils.toTypedDataHash(domainSeparator, reserveWitnessHash), input.reserveSignature
                ),
            IEscrow.InvalidSignature()
        );

        // Allowlisting remains a live admission check, but fee terms were fixed at deposit.
        require(configs[IERC20(input.token)].tokenDecimals != 0, ITokenConfig.TokenNotAllowed(IERC20(input.token)));
        ITokenConfig.TokenConfig memory tokenConfig = depositFeeConfigs[depositId];
        activeDeposit.feeAmount = fee(sourceAmount, tokenConfig);

        activeDeposit.amount = sourceAmount;
        activeDeposit.quoteHash = input.reserveWitness.quoteHash;
        activeDeposit.settler = input.reserveWitness.settler;
        hashes[depositId] = keccak256(abi.encode(activeDeposit));
        delete depositFeeConfigs[depositId];
        emit IEscrow.DepositReserved(
            depositId,
            input.reserveWitness.quoteHash,
            input.reserveWitness.settler,
            activeDeposit.amount,
            activeDeposit.feeAmount
        );

        // The overpayment goes back to the depositor last, after every state write: the transfer
        // hands control to the token
        if (sourceAmount < input.amount) {
            IERC20(input.token).safeTransfer(input.depositor, input.amount - sourceAmount);
        }
    }

    /// @notice Returns an unreserved deposit to its owner and clears its fee snapshot before transfer.
    /// @dev Runs under delegatecall, preserving the escrow's caller, storage and event address.
    function refundUnreserved(
        mapping(bytes32 => bytes32) storage hashes,
        mapping(bytes32 => ITokenConfig.TokenConfig) storage depositFeeConfigs,
        bytes calldata data
    ) external {
        IEscrow.RefundUnreservedInput memory input = abi.decode(data, (IEscrow.RefundUnreservedInput));
        bytes32 storedHash = hashes[input.depositId];
        require(storedHash != bytes32(0), IEscrow.DepositNotFound(input.depositId));
        IEscrow.ActiveDeposit memory activeDeposit = IEscrow.ActiveDeposit({
            depositor: msg.sender,
            quoteHash: bytes32(0),
            depositRequestHash: input.depositRequestHash,
            destinationHash: input.destinationHash,
            token: input.token,
            amount: input.amount,
            feeAmount: 0,
            reserver: input.reserver,
            releaser: input.releaser,
            settler: address(0)
        });
        bytes32 passedHash = keccak256(abi.encode(activeDeposit));
        require(storedHash == passedHash, IEscrow.InvalidWitnessValues(input.depositId, storedHash, passedHash));
        delete hashes[input.depositId];
        delete depositFeeConfigs[input.depositId];
        IERC20(input.token).safeTransfer(msg.sender, input.amount);
        emit IEscrow.Refunded(input.depositId, msg.sender, input.token, input.amount);
    }
}
