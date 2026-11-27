// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {Escrow} from "../src/Escrow.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {LocalPermit2} from "./helpers/LocalPermit2.sol";
import {TestHelpers} from "./helpers/TestHelpers.sol";

/// @notice CORE-3049: binds `conformance/direct-deposit-vectors.json` to the contract. The Go and
///         TypeScript encoders assert their output against that file; this test runs the same
///         scenario through the real `Escrow` and requires every value in the file to be what the
///         contract accepts, stores or emits, so a fixture edited to agree with an encoder, or an
///         encoder and fixture drifting together, fails here.
/// @dev The scenario is the known-answer one from Escrow.directDeposit.t.sol (chain id 31337,
///      nonce 7, amount 1000e18), reserved at a partial charge so the overpayment refund, the fee
///      and the `amount = sourceAmount` rewrite are all in the vector.
contract EscrowDirectDepositVectorsTest is Test, TestHelpers {
    string private constant FIXTURE_PATH = "../conformance/direct-deposit-vectors.json";

    address internal constant KA_ESCROW = 0x000000000000000000000000000000000000e5c0;
    address internal constant KA_OWNER = 0x00000000000000000000000000000000000A11cE;
    address internal constant KA_TOKEN = 0x00000000000000000000000000000000000070Ce;

    address internal reserver;
    uint256 internal reserverPrivateKey;
    address internal releaser;

    string internal json;
    Escrow internal escrow;

    function setUp() public {
        assertEq(block.chainid, 31337, "vectors are pinned for the default anvil chain id");
        json = vm.readFile(FIXTURE_PATH);

        IPermit2 permit2 = LocalPermit2.etch();
        (reserver, reserverPrivateKey) = makeAddrAndKey("reserver");
        (releaser,) = makeAddrAndKey("releaser");

        deployCodeTo("MockToken.sol:MockToken", abi.encode("Known Answer", "KA"), KA_TOKEN);
        deployCodeTo("Escrow.sol:Escrow", abi.encode(permit2, address(this)), KA_ESCROW);
        escrow = Escrow(KA_ESCROW);
        escrow.grantRole(escrow.TOKEN_CONFIG_ROLE(), address(this));
        escrow.allowToken(IERC20(KA_TOKEN), 18);
        escrow.setTokenFeeConfig(IERC20(KA_TOKEN), 20000, 0, 25000000);
        deal(KA_TOKEN, KA_OWNER, 1000e18);
    }

    function _witness() internal view returns (IEscrow.DepositWitness memory) {
        return IEscrow.DepositWitness({
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destination: DEFAULT_DESTINATION,
            reserver: reserver,
            releaser: releaser
        });
    }

    function _activeHash(bytes32 quoteHash, address settler, uint256 amount, uint256 feeAmount)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: KA_OWNER,
                    quoteHash: quoteHash,
                    depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                    destinationHash: DEFAULT_DESTINATION_HASH,
                    token: KA_TOKEN,
                    amount: amount,
                    feeAmount: feeAmount,
                    reserver: reserver,
                    releaser: releaser,
                    settler: settler
                })
            )
        );
    }

    function test_vectors_boundToContract() public {
        // ---- inputs: the fixture is the source, the test rebuilds the structs from it ----
        assertEq(vm.parseJsonUint(json, ".chainID"), block.chainid, "chainID");
        assertEq(vm.parseJsonAddress(json, ".escrow"), KA_ESCROW, "escrow");
        assertEq(vm.parseJsonAddress(json, ".owner"), KA_OWNER, "owner");
        assertEq(vm.parseJsonAddress(json, ".token"), KA_TOKEN, "token");
        assertEq(vm.parseJsonAddress(json, ".depositWitness.reserver"), reserver, "reserver");
        assertEq(vm.parseJsonAddress(json, ".depositWitness.releaser"), releaser, "releaser");
        assertEq(vm.parseJsonBytes32(json, ".depositWitness.depositRequestHash"), DEFAULT_DEPOSIT_REQUEST_HASH);
        assertEq(vm.parseJsonString(json, ".depositWitness.destination"), DEFAULT_DESTINATION);

        uint256 nonce = vm.parseJsonUint(json, ".nonce");
        uint256 amount = vm.parseJsonUint(json, ".amount");
        IEscrow.DirectDepositInput memory input =
            IEscrow.DirectDepositInput({token: KA_TOKEN, amount: amount, nonce: nonce, depositWitness: _witness()});

        // ---- directDeposit calldata, the id and the unreserved hash ----
        assertEq(
            abi.encodeCall(IEscrow.directDeposit, (input)),
            vm.parseJsonBytes(json, ".directDepositCalldata"),
            "directDeposit calldata"
        );
        assertEq(
            _depositWitnessStructHash(_witness()),
            vm.parseJsonBytes32(json, ".depositWitnessHash"),
            "deposit witness struct hash"
        );
        assertEq(
            _directDepositId(KA_ESCROW, KA_OWNER, KA_TOKEN, nonce, _witness(), amount),
            vm.parseJsonBytes32(json, ".depositId"),
            "test helper vs fixture id"
        );

        vm.startPrank(KA_OWNER);
        IERC20(KA_TOKEN).approve(KA_ESCROW, amount);
        bytes32 depositId = escrow.directDeposit(input);
        vm.stopPrank();
        assertEq(depositId, vm.parseJsonBytes32(json, ".depositId"), "contract id vs fixture");
        assertEq(
            escrow.getDepositHash(depositId),
            vm.parseJsonBytes32(json, ".unreservedDepositHash"),
            "unreserved hash stored by the contract"
        );
        assertEq(
            _activeHash(bytes32(0), address(0), amount, 0),
            vm.parseJsonBytes32(json, ".unreservedDepositHash"),
            "unreserved tuple rebuilt from the spec"
        );

        // ---- the funding batch: [approve(escrow, 0), approve(escrow, amount), directDeposit] ----
        assertEq(vm.parseJsonAddress(json, ".fundingBatch[0].to"), KA_TOKEN);
        assertEq(vm.parseJsonAddress(json, ".fundingBatch[1].to"), KA_TOKEN);
        assertEq(vm.parseJsonAddress(json, ".fundingBatch[2].to"), KA_ESCROW);
        assertEq(
            vm.parseJsonBytes(json, ".fundingBatch[0].data"),
            abi.encodeWithSelector(IERC20.approve.selector, KA_ESCROW, 0),
            "approve reset"
        );
        assertEq(
            vm.parseJsonBytes(json, ".fundingBatch[1].data"),
            abi.encodeWithSelector(IERC20.approve.selector, KA_ESCROW, amount),
            "approve amount"
        );
        assertEq(
            vm.parseJsonBytes(json, ".fundingBatch[2].data"),
            vm.parseJsonBytes(json, ".directDepositCalldata"),
            "batch carries the directDeposit calldata"
        );

        // ---- reserve() at a partial charge ----
        address settler = vm.parseJsonAddress(json, ".reserve.settler");
        bytes32 quoteHash = vm.parseJsonBytes32(json, ".reserve.quoteHash");
        uint256 sourceAmount = vm.parseJsonUint(json, ".reserve.sourceAmount");
        assertLt(sourceAmount, amount, "the vector must exercise the overpayment path");

        IEscrow.ReserveWitness memory reserveWitness =
            _constructReserveWitness(depositId, quoteHash, settler, sourceAmount);
        bytes memory signature = _constructReserveSignature(escrow, reserveWitness, reserverPrivateKey);
        assertEq(signature, vm.parseJsonBytes(json, ".reserve.reserveSignature"), "reserver signature");

        IEscrow.ReserveInput memory reserveInput = IEscrow.ReserveInput({
            depositor: KA_OWNER,
            token: KA_TOKEN,
            amount: amount,
            depositWitness: _witness(),
            reserveWitness: reserveWitness,
            reserveSignature: signature
        });
        bytes memory reserveCalldata = abi.encodeCall(IEscrow.reserve, (reserveInput));
        assertEq(reserveCalldata, vm.parseJsonBytes(json, ".reserve.reserveCalldata"), "reserve calldata");
        assertEq(bytes4(reserveCalldata), bytes4(0xb4b6913b), "reserve selector");

        vm.recordLogs();
        escrow.reserve(reserveInput);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 feeAmount = vm.parseJsonUint(json, ".reserve.feeAmount");
        assertEq(
            escrow.getDepositHash(depositId),
            vm.parseJsonBytes32(json, ".reserve.reservedDepositHash"),
            "reserved hash stored by the contract"
        );
        assertEq(
            _activeHash(quoteHash, settler, sourceAmount, feeAmount),
            vm.parseJsonBytes32(json, ".reserve.reservedDepositHash"),
            "reserved tuple rebuilt from the spec"
        );

        // ---- the DepositReserved log, byte for byte ----
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != KA_ESCROW || logs[i].topics[0] != IEscrow.DepositReserved.selector) continue;
            found = true;
            bytes32[] memory topics = vm.parseJsonBytes32Array(json, ".reserve.depositReservedLog.topics");
            assertEq(logs[i].topics.length, topics.length, "log topic count");
            for (uint256 t = 0; t < topics.length; t++) {
                assertEq(logs[i].topics[t], topics[t], "log topic");
            }
            assertEq(logs[i].data, vm.parseJsonBytes(json, ".reserve.depositReservedLog.data"), "log data");
            assertEq(logs[i].data, abi.encode(quoteHash, settler, sourceAmount, feeAmount), "log data layout");
        }
        assertTrue(found, "DepositReserved emitted");
    }
}
