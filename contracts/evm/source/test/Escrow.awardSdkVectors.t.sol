// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {Escrow} from "../src/Escrow.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {LocalPermit2} from "./helpers/LocalPermit2.sol";
import {MockToken6Decimals} from "./mock/MockToken.sol";

/// @notice A reserver wallet that accepts its owner's signature over the digest, asked by the escrow only.
contract OwnerSignedWallet is IERC1271 {
    address private immutable ESCROW;
    address private immutable OWNER;

    constructor(address escrow, address owner) {
        ESCROW = escrow;
        OWNER = owner;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        if (msg.sender != ESCROW) return 0xffffffff;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != OWNER) return 0xffffffff;
        return IERC1271.isValidSignature.selector;
    }
}

/// @notice Runs the EVM awards in `award-sdk-vectors.json`, built by the TypeScript SDK, through the
///         real escrow and Permit2: the SDK's deposit and reserve signatures, submitted unchanged,
///         clear `deposit()` with the payment id the SDK derived, and a witness the reserver did
///         not sign reverts.
contract EscrowAwardSdkVectorsTest is Test {
    string private constant FIXTURE_PATH =
        "../../../schemas/declarations/PaymentRequest/v1/conformance/award-sdk-vectors.json";
    string private constant EVM_NETWORK = "eip155:1";

    address internal constant ESCROW = 0xE5e5E5E5e5e5E5E5E5E5e5E5e5e5e5E5e5e5e5e5;
    address internal constant TOKEN = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    struct Row {
        string name;
        IEscrow.DepositInput input;
        // The settler named by the fixture's tampered reserve.
        address otherSettler;
    }

    string internal json;
    Row[] internal rows;

    function setUp() public {
        // The fixture's Permit2 and escrow domains are mainnet's.
        vm.chainId(1);
        json = vm.readFile(FIXTURE_PATH);

        IPermit2 permit2 = LocalPermit2.etch();
        vm.etch(TOKEN, address(new MockToken6Decimals("USD Coin", "USDC")).code);
        deployCodeTo("Escrow.sol:Escrow", abi.encode(permit2, address(this)), ESCROW);
        Escrow escrow = Escrow(ESCROW);
        escrow.grantRole(escrow.TOKEN_CONFIG_ROLE(), address(this));
        escrow.allowToken(IERC20(TOKEN), 6);

        for (uint256 i = 0; vm.keyExistsJson(json, _key(i, "")); i++) {
            if (
                keccak256(bytes(vm.parseJsonString(json, _key(i, ".reserve.expected.network"))))
                    != keccak256(bytes(EVM_NETWORK))
            ) {
                continue;
            }
            _loadRow(i);
        }
    }

    function _key(uint256 i, string memory path) internal pure returns (string memory) {
        return string.concat(".vectors[", vm.toString(i), "]", path);
    }

    function _loadRow(uint256 i) internal {
        string memory name = vm.parseJsonString(json, _key(i, ".name"));
        assertEq(vm.parseJsonAddress(json, _key(i, ".reserve.expected.escrowContract")), ESCROW, name);

        // The deposit: the depositor's Permit2 signature and the typed data it signed.
        string memory deposit = _key(i, ".award.sender_auth.signed_messages[0]");
        string memory permit = vm.parseJsonString(json, string.concat(deposit, ".message_prehash"));
        assertEq(vm.parseJsonAddress(permit, ".message.spender"), ESCROW, name);
        assertEq(vm.parseJsonAddress(permit, ".message.permitted.token"), TOKEN, name);

        IEscrow.DepositInput memory input;
        input.permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({
                token: TOKEN, amount: vm.parseJsonUint(permit, ".message.permitted.amount")
            }),
            nonce: vm.parseJsonUint(permit, ".message.nonce"),
            deadline: vm.parseJsonUint(permit, ".message.deadline")
        });
        input.depositor = vm.parseJsonAddress(json, _key(i, ".quoteRequest.source.account"));
        input.depositWitness = IEscrow.DepositWitness({
            depositRequestHash: vm.parseJsonBytes32(permit, ".message.witness.depositRequestHash"),
            destination: vm.parseJsonString(permit, ".message.witness.destination"),
            reserver: vm.parseJsonAddress(permit, ".message.witness.reserver"),
            releaser: vm.parseJsonAddress(permit, ".message.witness.releaser")
        });
        input.depositSignature = vm.parseJsonBytes(json, string.concat(deposit, ".signature"));

        // The reserve: the witness a settler submits for the award it won, and the SDK's signature.
        string memory expected = _key(i, ".reserve.expected");
        input.reserveWitness = IEscrow.ReserveWitness({
            depositId: vm.parseJsonBytes32(json, _key(i, ".paymentId")),
            quoteHash: vm.parseJsonBytes32(json, string.concat(expected, ".quoteHash")),
            settler: vm.parseJsonAddress(json, string.concat(expected, ".settler")),
            sourceAmount: vm.parseJsonUint(json, string.concat(expected, ".sourceAmount"))
        });
        input.reserveSignature = vm.parseJsonBytes(json, _key(i, ".award.reserve_auth.signature"));
        assertEq(input.depositWitness.reserver, vm.parseJsonAddress(json, string.concat(expected, ".reserver")), name);

        string memory tampered = vm.parseJsonString(json, _key(i, ".tampered[0].reserve_auth.message_prehash"));
        assertEq(vm.parseJsonString(json, _key(i, ".tampered[0].field")), "settler", name);
        address otherSettler = vm.parseJsonAddress(tampered, ".message.settler");
        assertTrue(otherSettler != input.reserveWitness.settler, name);

        if (vm.keyExistsJson(json, _key(i, ".contractReserverOwner"))) {
            address owner = vm.parseJsonAddress(json, _key(i, ".contractReserverOwner"));
            vm.etch(input.depositWitness.reserver, address(new OwnerSignedWallet(ESCROW, owner)).code);
        }

        rows.push(Row({name: name, input: input, otherSettler: otherSettler}));
    }

    /// @dev Funds the depositor's Permit2 allowance and moves to before the permit deadline.
    function _fund(IEscrow.DepositInput memory input) internal {
        deal(TOKEN, input.depositor, input.permit.permitted.amount);
        vm.prank(input.depositor);
        IERC20(TOKEN).approve(LocalPermit2.CANONICAL_PERMIT2, type(uint256).max);
        vm.warp(input.permit.deadline - 1);
    }

    function test_sdkAward_rowsCoverEveryEvmRoute() public view {
        assertEq(rows.length, 3, "depositor, selector and contract-selector rows");
        bool contractReserver;
        for (uint256 r = 0; r < rows.length; r++) {
            if (rows[r].input.depositWitness.reserver.code.length != 0) contractReserver = true;
        }
        assertTrue(contractReserver, "one row reserves through an ERC-1271 wallet");
    }

    function test_sdkAward_depositClears() public {
        for (uint256 r = 0; r < rows.length; r++) {
            IEscrow.DepositInput memory input = rows[r].input;
            uint256 snapshot = vm.snapshotState();
            _fund(input);

            bytes32 depositId = Escrow(ESCROW).deposit(input);

            assertEq(depositId, input.reserveWitness.depositId, rows[r].name);
            assertTrue(Escrow(ESCROW).getDepositHash(depositId) != bytes32(0), rows[r].name);
            assertEq(IERC20(TOKEN).balanceOf(ESCROW), input.reserveWitness.sourceAmount, rows[r].name);
            vm.revertToState(snapshot);
        }
    }

    function test_sdkAward_settlerChanged_revertsInvalidSignature() public {
        for (uint256 r = 0; r < rows.length; r++) {
            IEscrow.DepositInput memory input = rows[r].input;
            _fund(input);
            input.reserveWitness.settler = rows[r].otherSettler;

            vm.expectRevert(IEscrow.InvalidSignature.selector);
            Escrow(ESCROW).deposit(input);
        }
    }

    function test_sdkAward_sourceAmountChanged_revertsInvalidSignature() public {
        for (uint256 r = 0; r < rows.length; r++) {
            IEscrow.DepositInput memory input = rows[r].input;
            _fund(input);
            input.reserveWitness.sourceAmount -= 1;

            vm.expectRevert(IEscrow.InvalidSignature.selector);
            Escrow(ESCROW).deposit(input);
        }
    }
}
