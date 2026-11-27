// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test, console} from "forge-std/Test.sol";
import {Escrow} from "../../src/Escrow.sol";
import {IEscrow} from "../../src/interfaces/IEscrow.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
import {Signatures} from "./Signatures.sol";

contract TestHelpers is Test, Signatures {
    function releaseDeposit(Escrow escrow, IEscrow.ReleaseWitness memory witness, uint256 releaserPrivateKey)
        internal
        returns (IEscrow.ReleaseWitness memory, bytes memory signature)
    {
        signature = _constructReleaseSignature(witness, address(escrow), releaserPrivateKey);
        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: signature});
        escrow.release(releaseInput);
        vm.snapshotGasLastCall("release_success");
        return (witness, signature);
    }

    /// @notice Release a deposit (simplified version)
    /// @param escrow The escrow contract
    /// @param depositId The deposit ID
    /// @param releaserPrivateKey The releaser's private key
    function releaseDeposit(
        Escrow escrow,
        bytes32 depositId,
        address depositor,
        address token,
        uint256 amount,
        uint256 feeAmount,
        address reserver,
        address releaser,
        address settler,
        uint256 releaserPrivateKey
    ) internal {
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: token,
            amount: amount,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });
        releaseDeposit(escrow, witness, releaserPrivateKey);
    }

    function refundDeposit(Escrow escrow, IEscrow.RefundWitness memory witness, uint256 releaserPrivateKey)
        internal
        returns (IEscrow.RefundWitness memory, bytes memory signature)
    {
        signature = _constructRefundSignature(witness, address(escrow), releaserPrivateKey);
        IEscrow.RefundInput memory refundInput =
            IEscrow.RefundInput({refundWitness: witness, refundSignature: signature});
        escrow.refund(refundInput);
        vm.snapshotGasLastCall("refund_success");
        return (witness, signature);
    }

    /// @notice Refund a deposit (simplified version)
    /// @param escrow The escrow contract
    /// @param depositId The deposit ID
    /// @param releaserPrivateKey The releaser's private key
    function refundDeposit(
        Escrow escrow,
        bytes32 depositId,
        address depositor,
        address token,
        uint256 amount,
        uint256 feeAmount,
        address reserver,
        address releaser,
        address settler,
        uint256 releaserPrivateKey
    ) internal {
        IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: token,
            amount: amount,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });
        refundDeposit(escrow, witness, releaserPrivateKey);
    }

    /// @notice Check if a deposit was completed (storage cleared)
    /// @param escrow The escrow contract
    /// @param depositId The deposit ID to check
    /// @return completed True if the deposit was completed (released or refunded)
    function isDepositCompleted(Escrow escrow, bytes32 depositId) internal view returns (bool completed) {
        bytes32 depositHash = escrow.getDepositHash(depositId);
        return depositHash == bytes32(0);
    }

    function expectedDepositId(
        ISignatureTransfer.PermitTransferFrom memory permit,
        address depositor,
        IEscrow.DepositWitness memory,
        bytes memory signature
    ) internal pure returns (bytes32 depositId) {
        console.log("=== Expected Deposit ID ===");
        console.log("depositor:", depositor);
        console.log("signature:");
        console.logBytes(signature);
        console.log("nonce:", permit.nonce);
        depositId = keccak256(abi.encode(depositor, signature, permit.nonce));
        console.log("depositId:");
        console.logBytes32(depositId);
        console.log("=== End Expected Deposit ID ===");
        return depositId;
    }
}
