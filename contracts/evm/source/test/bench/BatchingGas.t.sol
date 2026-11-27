// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test, console, stdStorage, StdStorage} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Escrow} from "../../src/Escrow.sol";
import {FulfillmentProxy} from "../../src/FulfillmentProxy.sol";
import {IFulfillmentProxy} from "../../src/interfaces/IFulfillmentProxy.sol";
import {IEscrow} from "../../src/interfaces/IEscrow.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
import {DeployCoreContracts} from "../../script/deploy/DeployCoreContracts.s.sol";
import {LocalPermit2} from "../helpers/LocalPermit2.sol";
import {TestHelpers} from "../helpers/TestHelpers.sol";
import {MockToken} from "../mock/MockToken.sol";

/// @notice What batching saves: N separate transactions against one batch of N, per entry point.
///
/// The `*Many` benchmarks in Escrow.depositFlow.t.sol and FulfillmentProxy.t.sol cannot answer that.
/// They call `vm.snapshotGasLastCall` without isolation, which records execution inside one long
/// test transaction: the 21,000 intrinsic gas and the calldata of each transaction are left out,
/// and those are the costs batching amortises. They also run every size in one test function, so
/// later sizes reuse warm storage (fulfillMany_3 snapshots cheaper than fulfillMany_2).
///
/// Here every call is its own transaction (`--isolate`). Within a size, the single-item and batch
/// runs start from the same state, and release and refund revert their setup deposits at the end
/// of the size, so no size runs on top of an earlier one. The numbers match anvil
/// receipts to the gas. Without `--isolate` the suite skips itself rather than record wrong numbers.
///
/// The state is shaped like production, because warm slots shared between items are exactly what a
/// batch amortises and a bench that shares them by accident overstates the saving:
/// - every deposit is signed by its own payer with a random 256-bit Permit2 nonce, as payment-gw
///   signs them. `deposit_onePayer` / `refund_onePayer` keep one payer (still random nonces), the
///   upper end of the range;
/// - the escrow already holds the token and has booked fee revenue, the settler and fulfill
///   recipients already hold the token, so no size pays a one-off zero-to-nonzero write.
///
/// `fulfill` prices plain `fulfill` against `fulfillMany`. The settler sends `strictFulfill`, which
/// has no batch form, so `strictFulfill` is measured as singles only and `fulfillMany` is not a
/// saving production can take.
///
///   make bench-batching       # mock token; writes snapshots/BatchingGasBench.json (CI checks it)
///   FORK_CONFIG=<test/fork/*.json with "escrow" set to the deployed v4 escrow> FORK_BLOCK=<block> \
///     BENCH_FULFILLMENT_PROXY=0xA8F40Ed7437BCB6bF264832369e8364b80B06c83 make bench-batching
///                             # deployed v4 escrow + proxy against the real token; logs only
///
/// Every run logs `BENCH,<op>,<n>,<sum of n single txs>,<one batch of n>` (`n/a` where there is no
/// batch form). BENCH_CALLDATA=true also logs `CALLDATA,<op>,<n>,<single|batch>,<hex>` so the
/// rollup L1 data fee can be priced off the real calldata.
contract BatchingGasBench is Test, TestHelpers {
    using SafeERC20 for IERC20;
    using stdStorage for StdStorage;

    string internal constant GROUP = "BatchingGasBench";

    Escrow internal s_escrow;
    IERC20 internal s_token;
    IPermit2 internal s_permit2;
    bool internal isForkMode;
    uint8 internal tokenDecimals;
    uint256 internal DEPOSIT_AMOUNT;

    address internal depositor;
    uint256 internal depositorPrivateKey;
    address internal reserver;
    uint256 internal reserverPrivateKey;
    address internal releaser;
    uint256 internal releaserPrivateKey;
    address internal settler = makeAddr("settler");

    /// @dev Same two modes as Escrow.depositFlow.t.sol: a hermetic deploy with a mock token, or
    /// FORK_CONFIG pointing at a deployed escrow and a real token (see test/fork/*.json).
    function setUp() public {
        string memory forkConfig = vm.envOr("FORK_CONFIG", string(""));
        if (bytes(forkConfig).length > 0) {
            isForkMode = true;
            string memory json = vm.readFile(forkConfig);
            // Pin FORK_BLOCK to make a fork run reproducible; unset, it forks the chain head.
            uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
            if (forkBlock == 0) vm.createSelectFork(vm.parseJsonString(json, ".rpc_url"));
            else vm.createSelectFork(vm.parseJsonString(json, ".rpc_url"), forkBlock);
            s_escrow = Escrow(vm.parseJsonAddress(json, ".escrow"));
            s_token = IERC20(vm.parseJsonAddress(json, ".token_address"));
            tokenDecimals = uint8(vm.parseJsonUint(json, ".token_decimals"));
            s_permit2 = s_escrow.i_permit2();

            address tokenConfigRole = makeAddr("tokenConfig");
            vm.startPrank(s_escrow.defaultAdmin());
            s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), tokenConfigRole);
            vm.stopPrank();
            uint88 feePercentage = uint88(vm.parseJsonUint(json, ".fee_percentage"));
            uint80 minFee = uint80(vm.parseJsonUint(json, ".min_fee"));
            uint80 maxFee = uint80(vm.parseJsonUint(json, ".max_fee"));
            vm.startPrank(tokenConfigRole);
            if (s_escrow.isTokenAllowed(s_token)) {
                s_escrow.setTokenFeeConfig(s_token, feePercentage, minFee, maxFee);
            } else {
                s_escrow.allowTokenAndSetFeeConfig(s_token, tokenDecimals, feePercentage, minFee, maxFee);
            }
            vm.stopPrank();
        } else {
            tokenDecimals = 18;
            s_permit2 = LocalPermit2.etch();
            s_token = IERC20(address(new MockToken("Test Token", "TEST")));
            (s_escrow,) = new DeployCoreContracts().run();
            s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), address(this));
            s_escrow.allowToken(s_token, 18);
            s_escrow.setTokenFeeConfig(s_token, 20000, 0, 25000000);
            // A live escrow already holds the token and has booked fee revenue. Without this, every
            // deposit size pays a zero-to-nonzero write on the escrow's balance and every release
            // size one on s_tokenFeeRevenue (17,100 each), which no production call pays.
            deal(address(s_token), address(s_escrow), 1);
            stdstore.target(address(s_escrow));
            stdstore.sig("getFeeRevenue(address)");
            stdstore.with_key(address(s_token));
            stdstore.checked_write(uint256(1));
        }
        DEPOSIT_AMOUNT = 1000 * (10 ** tokenDecimals);

        (depositor, depositorPrivateKey) = makeAddrAndKey("depositor");
        (reserver, reserverPrivateKey) = makeAddrAndKey("reserver");
        (releaser, releaserPrivateKey) = makeAddrAndKey("releaser");
        deal(address(s_token), depositor, DEPOSIT_AMOUNT * 1000);
        // A working settler already holds the token, so its first release is not a zero-to-nonzero write.
        deal(address(s_token), settler, 1);
        vm.prank(depositor);
        s_token.forceApprove(address(s_permit2), type(uint256).max);
    }

    function _depositWitness(address token, uint256 amount, address _reserver, address _releaser, uint256 nonce)
        internal
        view
        returns (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness)
    {
        return _constructDepositPermitWitness(
            token, amount, _reserver, _releaser, nonce, DEFAULT_DEPOSIT_REQUEST_HASH, DEFAULT_DESTINATION
        );
    }

    function _reserveWitness(bytes32 depositId, address _settler)
        internal
        view
        returns (IEscrow.ReserveWitness memory)
    {
        return _constructReserveWitness(depositId, DEFAULT_QUOTE_HASH, _settler, DEPOSIT_AMOUNT);
    }

    function _releaseWitness(bytes32 depositId, address _depositor, uint256 feeAmount)
        internal
        view
        returns (IEscrow.ReleaseWitness memory)
    {
        return IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: _depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });
    }

    function _refundWitness(bytes32 depositId, address _depositor, uint256 feeAmount)
        internal
        view
        returns (IEscrow.RefundWitness memory)
    {
        return IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: _depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });
    }

    function _sizes() internal pure returns (uint256[] memory s) {
        s = new uint256[](8);
        s[0] = 1;
        s[1] = 2;
        s[2] = 3;
        s[3] = 5;
        s[4] = 10;
        s[5] = 20;
        s[6] = 50;
        s[7] = 100;
    }

    /// @dev Skip unless each top-level call is its own transaction. Under `--isolate` a state-changing
    /// call pays the 21,000 intrinsic gas; in a plain `forge test` this one costs a few thousand.
    /// (View calls are not isolated, so the probe has to write.)
    function _requireIsolated() internal {
        // forceApprove, not approve: Ethereum USDT returns nothing, and a bool-decoding approve reverts.
        s_token.forceApprove(address(0xdead), 0);
        if (vm.lastCallGas().gasTotalUsed < 21_000) {
            console.log("BatchingGasBench needs --isolate; skipping");
            vm.skip(true);
        }
    }

    function _gas() internal view returns (uint256) {
        return vm.lastCallGas().gasTotalUsed;
    }

    function _record(string memory op, uint256 n, uint256 singles, uint256 batch) internal {
        console.log(
            string.concat("BENCH,", op, ",", vm.toString(n), ",", vm.toString(singles), ",", vm.toString(batch))
        );
        // Snapshots are only meaningful for the hermetic run; a fork's numbers move with the chain.
        if (!isForkMode) {
            string memory key = string.concat(op, "_", vm.toString(n));
            vm.snapshotValue(GROUP, string.concat(key, "_singles"), singles);
            vm.snapshotValue(GROUP, string.concat(key, "_batch"), batch);
        }
    }

    function _recordSingles(string memory op, uint256 n, uint256 singles) internal {
        console.log(string.concat("BENCH,", op, ",", vm.toString(n), ",", vm.toString(singles), ",n/a"));
        if (!isForkMode) vm.snapshotValue(GROUP, string.concat(op, "_", vm.toString(n), "_singles"), singles);
    }

    function _calldata(string memory op, uint256 n, bytes memory single, bytes memory batch) internal view {
        if (!vm.envOr("BENCH_CALLDATA", false)) return;
        string memory head = string.concat("CALLDATA,", op, ",", vm.toString(n), ",");
        console.log(string.concat(head, "single,", vm.toString(single)));
        console.log(string.concat(head, "batch,", vm.toString(batch)));
    }

    // ---------------------------------------------------------------- fulfill

    function test_bench_fulfill() public {
        _requireIsolated();

        FulfillmentProxy fp;
        IERC20 t;
        if (isForkMode) {
            fp = FulfillmentProxy(vm.envAddress("BENCH_FULFILLMENT_PROXY"));
            t = s_token;
            deal(address(t), address(this), 1e9 * (10 ** tokenDecimals));
            // strictFulfill checks SETTLER_ROLE once the allowlist is enforced; act as a granted settler.
            bytes32 settlerRole = fp.SETTLER_ROLE();
            vm.prank(fp.defaultAdmin());
            fp.grantRole(settlerRole, address(this));
        } else {
            fp = new FulfillmentProxy(address(this));
            MockToken m = new MockToken("Bench", "BNCH");
            m.mint(address(this), type(uint128).max);
            t = IERC20(address(m));
        }
        t.forceApprove(address(fp), type(uint256).max);

        // Distinct recipients that already hold a balance: merchants, not fresh EOAs.
        for (uint256 j; j < 100; j++) {
            deal(address(t), _recipient(j), 1);
        }

        uint256[] memory sizes = _sizes();
        for (uint256 i; i < sizes.length; i++) {
            uint256 n = sizes[i];
            IFulfillmentProxy.Fulfillment[] memory items = new IFulfillmentProxy.Fulfillment[](n);
            for (uint256 j; j < n; j++) {
                items[j] = IFulfillmentProxy.Fulfillment({
                    quoteHash: keccak256(abi.encode("q", j)),
                    to: _recipient(j),
                    token: address(t),
                    amount: (10 ** tokenDecimals) * (j + 1)
                });
            }

            uint256 snap = vm.snapshotState();
            uint256 singles;
            for (uint256 j; j < n; j++) {
                fp.fulfill(items[j]);
                singles += _gas();
            }
            vm.revertToState(snap);

            fp.fulfillMany(items);
            uint256 batch = _gas();
            vm.revertToState(snap);

            // What the settler actually sends. There is no strictFulfillMany to compare it with.
            uint256 strictSingles;
            for (uint256 j; j < n; j++) {
                fp.strictFulfill(items[j], block.timestamp + 1 hours);
                strictSingles += _gas();
            }
            vm.revertToState(snap);

            _record("fulfill", n, singles, batch);
            _recordSingles("strictFulfill", n, strictSingles);
            _calldata(
                "fulfill",
                n,
                abi.encodeCall(IFulfillmentProxy.fulfill, (items[0])),
                abi.encodeCall(IFulfillmentProxy.fulfillMany, (items))
            );
        }
    }

    function _recipient(uint256 j) internal pure returns (address) {
        return address(uint160(0xBEEF0000 + j));
    }

    // ---------------------------------------------------------------- escrow helpers

    /// @dev Production signs each payment with a uniformly random 256-bit nonce, so items never share a
    /// Permit2 bitmap word. With `distinctPayers` every item also has its own funded, approved payer;
    /// without it they share `depositor`. Payers keep a balance after depositing, as most do.
    function _depositInputs(uint256 n, uint256 nonceBase, bool distinctPayers)
        internal
        returns (IEscrow.DepositInput[] memory inputs, bytes32[] memory ids, address[] memory payers)
    {
        inputs = new IEscrow.DepositInput[](n);
        ids = new bytes32[](n);
        payers = new address[](n);
        for (uint256 j; j < n; j++) {
            (address payer, uint256 payerKey) = (depositor, depositorPrivateKey);
            if (distinctPayers) {
                (payer, payerKey) = makeAddrAndKey(string.concat("depositor-", vm.toString(nonceBase + j)));
                deal(address(s_token), payer, 2 * DEPOSIT_AMOUNT);
                vm.prank(payer);
                s_token.forceApprove(address(s_permit2), type(uint256).max);
            }
            payers[j] = payer;
            uint256 nonce = uint256(keccak256(abi.encode(nonceBase, j)));
            (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory dw) =
                _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, nonce);
            bytes memory dsig = _constructDepositSignature(permit, dw, s_permit2, address(s_escrow), payerKey);
            ids[j] = expectedDepositId(permit, payer, dw, dsig);
            IEscrow.ReserveWitness memory rw = _reserveWitness(ids[j], settler);
            bytes memory rsig = _constructReserveSignature(s_escrow, rw, reserverPrivateKey);
            inputs[j] = IEscrow.DepositInput({
                permit: permit,
                depositor: payer,
                depositWitness: dw,
                depositSignature: dsig,
                reserveWitness: rw,
                reserveSignature: rsig
            });
        }
    }

    // ---------------------------------------------------------------- deposit

    function test_bench_deposit() public {
        _benchDeposit("deposit", 10_000, true);
    }

    function test_bench_deposit_onePayer() public {
        _benchDeposit("deposit_onePayer", 40_000, false);
    }

    function _benchDeposit(string memory op, uint256 seed, bool distinctPayers) internal {
        _requireIsolated();
        uint256[] memory sizes = _sizes();
        for (uint256 i; i < sizes.length; i++) {
            uint256 n = sizes[i];
            (IEscrow.DepositInput[] memory inputs,,) = _depositInputs(n, seed + i * 1000, distinctPayers);

            uint256 snap = vm.snapshotState();
            uint256 singles;
            for (uint256 j; j < n; j++) {
                s_escrow.deposit(inputs[j]);
                singles += _gas();
            }
            vm.revertToState(snap);

            s_escrow.depositMany(inputs);
            uint256 batch = _gas();
            vm.revertToState(snap);

            _record(op, n, singles, batch);
            _calldata(
                op, n, abi.encodeCall(IEscrow.deposit, (inputs[0])), abi.encodeCall(IEscrow.depositMany, (inputs))
            );
        }
    }

    // ---------------------------------------------------------------- release

    function test_bench_release() public {
        _requireIsolated();
        uint256 fee = s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig(s_token));
        uint256[] memory sizes = _sizes();
        uint256 startBalance = s_token.balanceOf(address(s_escrow));
        for (uint256 i; i < sizes.length; i++) {
            uint256 n = sizes[i];
            assertEq(s_token.balanceOf(address(s_escrow)), startBalance, "a size must start from a clean escrow");
            // The setup deposits are part of this size's state, so take the clean snapshot before them
            // and return to it at the end of the size; otherwise the next size runs on top of them.
            uint256 clean = vm.snapshotState();
            (IEscrow.DepositInput[] memory dins, bytes32[] memory ids, address[] memory payers) =
                _depositInputs(n, 20_000 + i * 1000, true);
            s_escrow.depositMany(dins);

            IEscrow.ReleaseInput[] memory inputs = new IEscrow.ReleaseInput[](n);
            for (uint256 j; j < n; j++) {
                IEscrow.ReleaseWitness memory w = _releaseWitness(ids[j], payers[j], fee);
                inputs[j] = IEscrow.ReleaseInput({
                    releaseWitness: w,
                    releaseSignature: _constructReleaseSignature(w, address(s_escrow), releaserPrivateKey)
                });
            }

            uint256 snap = vm.snapshotState();
            uint256 singles;
            for (uint256 j; j < n; j++) {
                s_escrow.release(inputs[j]);
                singles += _gas();
            }
            vm.revertToState(snap);

            s_escrow.releaseMany(inputs);
            uint256 batch = _gas();
            vm.revertToState(clean);

            _record("release", n, singles, batch);
            _calldata(
                "release",
                n,
                abi.encodeCall(IEscrow.release, (inputs[0])),
                abi.encodeCall(IEscrow.releaseMany, (inputs))
            );
        }
    }

    // ---------------------------------------------------------------- refund

    function test_bench_refund() public {
        _benchRefund("refund", 30_000, true);
    }

    function test_bench_refund_onePayer() public {
        _benchRefund("refund_onePayer", 50_000, false);
    }

    function _benchRefund(string memory op, uint256 seed, bool distinctPayers) internal {
        _requireIsolated();
        uint256 fee = s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig(s_token));
        uint256[] memory sizes = _sizes();
        uint256 startBalance = s_token.balanceOf(address(s_escrow));
        for (uint256 i; i < sizes.length; i++) {
            uint256 n = sizes[i];
            assertEq(s_token.balanceOf(address(s_escrow)), startBalance, "a size must start from a clean escrow");
            // See test_bench_release: the setup deposits belong to this size only.
            uint256 clean = vm.snapshotState();
            (IEscrow.DepositInput[] memory dins, bytes32[] memory ids, address[] memory payers) =
                _depositInputs(n, seed + i * 1000, distinctPayers);
            s_escrow.depositMany(dins);

            IEscrow.RefundInput[] memory inputs = new IEscrow.RefundInput[](n);
            for (uint256 j; j < n; j++) {
                IEscrow.RefundWitness memory w = _refundWitness(ids[j], payers[j], fee);
                inputs[j] = IEscrow.RefundInput({
                    refundWitness: w,
                    refundSignature: _constructRefundSignature(w, address(s_escrow), releaserPrivateKey)
                });
            }

            uint256 snap = vm.snapshotState();
            uint256 singles;
            for (uint256 j; j < n; j++) {
                s_escrow.refund(inputs[j]);
                singles += _gas();
            }
            vm.revertToState(snap);

            s_escrow.refundMany(inputs);
            uint256 batch = _gas();
            vm.revertToState(clean);

            _record(op, n, singles, batch);
            _calldata(op, n, abi.encodeCall(IEscrow.refund, (inputs[0])), abi.encodeCall(IEscrow.refundMany, (inputs)));
        }
    }
}
