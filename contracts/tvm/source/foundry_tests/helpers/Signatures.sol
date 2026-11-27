// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test, console} from "forge-std/Test.sol";
import {Escrow} from "../../contracts/Escrow.sol";
import {IEscrow} from "../../contracts/interfaces/IEscrow.sol";
import {IPermit2} from "@alexroan/permit2-tron/contracts/interfaces/IPermit2.sol";
import {ISignatureTransfer} from "@alexroan/permit2-tron/contracts/interfaces/ISignatureTransfer.sol";

contract Signatures is Test {
    bytes32 private constant DEPOSIT_WITNESS_TYPE_HASH =
        keccak256("DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)");

    bytes32 internal constant DEFAULT_QUOTE_HASH = keccak256("quoteHash");
    // Shared CORE-2120 defaults. Live here (not in a derived test) so TestHelpers' release/refund
    // builders can rebuild exactly what the deposit fixture committed to.
    bytes32 internal constant DEFAULT_DEPOSIT_REQUEST_HASH = keccak256("default-deposit-request-hash");
    // Arbitrary byte string chosen to exercise length/encoding — NOT a canonical-form example.
    string internal constant DEFAULT_DESTINATION = "eip155:8453/erc20:0xaaaa@0xbbbb";
    bytes32 internal constant DEFAULT_DESTINATION_HASH = keccak256(bytes(DEFAULT_DESTINATION));

    function _constructDepositPermitWitness(
        address token,
        uint256 amount,
        address reserver,
        address releaser,
        uint256 nonce
    )
        internal
        view
        returns (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness)
    {
        permit = ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({token: token, amount: amount}),
                nonce: nonce,
                deadline: block.timestamp + 1 hours
            });

        witness = IEscrow.DepositWitness({
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destination: DEFAULT_DESTINATION,
            reserver: reserver,
            releaser: releaser
        });
    }

    function _constructDepositSignature(
        ISignatureTransfer.PermitTransferFrom memory permit,
        IEscrow.DepositWitness memory witness,
        IPermit2 permit2,
        address escrow,
        uint256 depositorPrivateKey
    ) internal view returns (bytes memory signature) {
        bytes32 domainSeparator = permit2.DOMAIN_SEPARATOR();
        // EIP-712 hashes a dynamic `string` member as keccak256(bytes(value)), never the raw string.
        bytes32 witnessHash = keccak256(
            abi.encode(
                DEPOSIT_WITNESS_TYPE_HASH,
                witness.depositRequestHash,
                keccak256(bytes(witness.destination)),
                witness.reserver,
                witness.releaser
            )
        );

        // Log encoding values when running with -vvv
        console.log("=== Deposit Signature Encoding Values ===");
        console.log("chainID:", block.chainid);
        console.log("permit2:", address(permit2));
        console.log("token:", permit.permitted.token);
        console.log("amount:", permit.permitted.amount);
        console.log("nonce:", permit.nonce);
        console.log("deadline:", permit.deadline);
        console.log("spender:", escrow);
        console.log("reserver:", witness.reserver);
        console.log("releaser:", witness.releaser);

        // Store permit values we need to avoid accessing permit struct later
        uint256 permitNonce = permit.nonce;
        uint256 permitDeadline = permit.deadline;
        ISignatureTransfer.TokenPermissions memory permitted = permit.permitted;

        bytes32 structHash;

        // Create type hash and token permissions hash in first block
        {
            // This must match FULL_DEPOSIT_WITNESS_TYPE_STRING in Escrow.sol
            string memory witnessTypeString =
                "DepositWitness witness)DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)TokenPermissions(address token,uint256 amount)";
            string memory permitStub =
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";
            bytes32 typeHash = keccak256(abi.encodePacked(permitStub, witnessTypeString));

            bytes32 TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
            bytes32 tokenPermissionsHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permitted));

            // Create the struct hash
            structHash =
                keccak256(abi.encode(typeHash, tokenPermissionsHash, escrow, permitNonce, permitDeadline, witnessHash));
        }

        // Create final EIP-712 digest and sign in second block
        {
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
            console.log("expectedDigest:");
            console.logBytes32(digest);
            console.log("=== End Deposit Signature Encoding ===");

            (uint8 v, bytes32 r, bytes32 s) = vm.sign(depositorPrivateKey, digest);
            signature = abi.encodePacked(r, s, v);
        }
    }

    function _constructReserveWitness(bytes32 depositId, bytes32 quoteHash, address settler, uint256 sourceAmount)
        internal
        pure
        returns (IEscrow.ReserveWitness memory witness)
    {
        witness = IEscrow.ReserveWitness({
            depositId: depositId, quoteHash: quoteHash, settler: settler, sourceAmount: sourceAmount
        });
    }

    function _constructReserveSignature(
        Escrow escrow,
        IEscrow.ReserveWitness memory witness,
        uint256 reserverPrivateKey
    ) internal view returns (bytes memory signature) {
        // Log encoding values when running with -vvv
        console.log("=== Reserve Signature Encoding Values ===");
        console.log("chainID:", block.chainid);
        console.log("escrow:", address(escrow));
        console.log("depositId:");
        console.logBytes32(witness.depositId);
        console.log("settler:", witness.settler);

        // Create EIP-712 signature with minimal witness data
        // The depositId cryptographically commits to all deposit details via the depositor's signature
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)"),
                witness.depositId,
                witness.quoteHash,
                witness.settler,
                witness.sourceAmount
            )
        );

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Escrow"),
                keccak256("3"),
                block.chainid,
                address(escrow)
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        console.log("expectedDigest:");
        console.logBytes32(digest);
        console.log("=== End Reserve Signature Encoding ===");

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(reserverPrivateKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _constructReleaseSignature(
        IEscrow.ReleaseWitness memory witness,
        address escrow,
        uint256 releaserPrivateKey
    ) internal view returns (bytes memory signature) {
        // Log encoding values when running with -vvv
        console.log("=== Release Signature Encoding Values ===");
        console.log("chainID:", block.chainid);
        console.log("escrow:", address(escrow));
        console.log("depositId:");
        console.logBytes32(witness.depositId);
        console.log("depositor:", witness.depositor);
        console.log("token:", witness.token);
        console.log("amount:", witness.amount);
        console.log("feeAmount:", witness.feeAmount);
        console.log("reserver:", witness.reserver);
        console.log("releaser:", witness.releaser);
        console.log("settler:", witness.settler);

        // Create EIP-712 domain separator
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Escrow"),
                keccak256("3"),
                block.chainid,
                address(escrow)
            )
        );

        // Create struct hash with full witness data
        // The contract will validate all these fields against the stored deposit hash
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "ReleaseWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)"
                ),
                witness.depositId,
                witness.quoteHash,
                witness.depositRequestHash,
                witness.destinationHash,
                witness.depositor,
                witness.token,
                witness.amount,
                witness.feeAmount,
                witness.reserver,
                witness.releaser,
                witness.settler
            )
        );

        // Create EIP-712 digest
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        console.log("expectedDigest:");
        console.logBytes32(digest);
        console.log("=== End Release Signature Encoding ===");

        // Sign the digest
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(releaserPrivateKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _constructRefundSignature(IEscrow.RefundWitness memory witness, address escrow, uint256 releaserPrivateKey)
        internal
        view
        returns (bytes memory signature)
    {
        // Log encoding values when running with -vvv
        console.log("=== Refund Signature Encoding Values ===");
        console.log("chainID:", block.chainid);
        console.log("escrow:", address(escrow));
        console.log("depositId:");
        console.logBytes32(witness.depositId);
        console.log("depositor:", witness.depositor);
        console.log("token:", witness.token);
        console.log("amount:", witness.amount);
        console.log("feeAmount:", witness.feeAmount);
        console.log("reserver:", witness.reserver);
        console.log("releaser:", witness.releaser);
        console.log("settler:", witness.settler);

        // Create EIP-712 domain separator
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Escrow"),
                keccak256("3"),
                block.chainid,
                address(escrow)
            )
        );

        // Create struct hash with full witness data
        // The contract will validate all these fields against the stored deposit hash
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "RefundWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)"
                ),
                witness.depositId,
                witness.quoteHash,
                witness.depositRequestHash,
                witness.destinationHash,
                witness.depositor,
                witness.token,
                witness.amount,
                witness.feeAmount,
                witness.reserver,
                witness.releaser,
                witness.settler
            )
        );

        // Create EIP-712 digest
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        console.log("expectedDigest:");
        console.logBytes32(digest);
        console.log("=== End Refund Signature Encoding ===");

        // Sign the digest
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(releaserPrivateKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function getPermitTransferSignature(
        ISignatureTransfer.PermitTransferFrom memory permit,
        uint256 privateKey,
        bytes32 domainSeparator
    ) internal view returns (bytes memory sig) {
        bytes32 tokenPermissionsTypeHash = keccak256("TokenPermissions(address token,uint256 amount)");
        bytes32 permitTransferFromTypeHash = keccak256(
            "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
        );
        bytes32 tokenPermissions = keccak256(abi.encode(tokenPermissionsTypeHash, permit.permitted));
        bytes32 msgHash = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator,
                keccak256(
                    abi.encode(
                        permitTransferFromTypeHash, tokenPermissions, address(this), permit.nonce, permit.deadline
                    )
                )
            )
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, msgHash);
        return bytes.concat(r, s, bytes1(v));
    }
}
