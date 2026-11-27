// // SPDX-License-Identifier: MIT
// pragma solidity 0.8.27;

// import {Test, console, Vm, StdCheats} from "forge-std/Test.sol";
// import {IEscrow, Escrow} from "../../src/Escrow.sol";
// import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
// import {MockToken, MockToken8Decimals, MockToken6Decimals} from "../mock/MockToken.sol";
// import {IERC20, ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
// import {EnumerableMap} from "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
// import {IMintable} from "../mock/MockToken.sol";
// import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
// import {TestHelpers} from "../helpers/TestHelpers.sol";

// contract EscrowInvariantsHandler is Test, TestHelpers {
//     using EnumerableMap for EnumerableMap.Bytes32ToAddressMap;

//     struct InvariantStats {
//         uint256 totalDeposits;
//         uint256 totalReleases;
//         uint256 totalRefunds;
//         uint256 totalRandomlySentTokensToEscrow;
//         uint256 sumOfDepositAmounts;
//     }

//     struct Keys {
//         address reserver;
//         uint256 reserverPrivateKey;
//         address releaser;
//         uint256 releaserPrivateKey;
//     }

//     InvariantStats public s_invariantStats;
//     Escrow public s_escrow;
//     IPermit2 private s_permit2;

//     IEscrow.AllowlistedToken[] private s_allowlistedTokens;

//     mapping(bytes32 depositId => IEscrow.ActiveDeposit depositDetails) private s_activeDeposits;
//     mapping(bytes32 depositId => Keys keys) private s_keys;
//     bytes32[] private s_activeDepositIds;

//     mapping(address => uint256) private s_depositorNonces;

//     constructor() {
//         s_invariantStats = InvariantStats({
//             totalDeposits: 0,
//             totalReleases: 0,
//             totalRefunds: 0,
//             totalRandomlySentTokensToEscrow: 0,
//             sumOfDepositAmounts: 0
//         });
//     }

//     function setState(Escrow escrow, IPermit2 permit2, IEscrow.AllowlistedToken[] memory allowlistedTokens) external {
//         s_escrow = escrow;
//         s_permit2 = permit2;
//         // Clear existing array
//         delete s_allowlistedTokens;
//         // Copy each element from memory to storage
//         for (uint256 i = 0; i < allowlistedTokens.length; i++) {
//             s_allowlistedTokens.push(allowlistedTokens[i]);
//         }
//     }

//     function getSumOfEscrowBalances() external view returns (uint256) {
//         uint256 sum = 0;
//         for (uint256 i = 0; i < s_allowlistedTokens.length; i++) {
//             sum += s_allowlistedTokens[i].token.balanceOf(address(s_escrow));
//         }
//         return sum;
//     }

//     function depositMany(uint256 howMany) public {
//         howMany = bound(howMany, 1, 10);
//         IEscrow.DepositInput[] memory depositInputs = new IEscrow.DepositInput[](howMany);
//         // Secp256k1 curve order (n)
//         uint256 SECP256K1_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
//         for (uint256 i = 0; i < howMany; i++) {
//             address token = address(s_allowlistedTokens[vm.randomUint() % s_allowlistedTokens.length].token);
//             uint96 amount = uint96(vm.randomUint() % type(uint96).max);
//             if (amount == 0) {
//                 amount = 1;
//             }
//             uint256 reserverPrivateKey = vm.randomUint() % SECP256K1_ORDER;
//             uint256 releaserPrivateKey = vm.randomUint() % SECP256K1_ORDER;
//             address settler = vm.addr(vm.randomUint());
//             vm.assume(settler != address(0));
//             address reserver = vm.addr(reserverPrivateKey);
//             address releaser = vm.addr(releaserPrivateKey);
//             vm.assume(reserver.code.length == 0);
//             vm.assume(releaser.code.length == 0);
//             (address depositor, uint256 depositorPrivateKey) = makeAddrAndKey(string(vm.randomBytes(32)));
//             vm.assume(depositor.code.length == 0);
//             // Mint and approve
//             IMintable(token).mint(depositor, amount);
//             vm.startPrank(depositor);
//             IERC20(token).approve(address(s_permit2), type(uint256).max);
//             vm.stopPrank();
//             s_depositorNonces[depositor]++;
//             uint256 currentNonce = s_depositorNonces[depositor];
//             // Setup permit data and witness for this deposit
//             (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
//                 _constructDepositPermitWitness(token, amount, reserver, releaser, currentNonce);

//             // Generate deposit signature
//             bytes memory depositSignature =
//                 _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

//             // Generate expected deposit ID
//             bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

//             // Construct reserve witness
//             IEscrow.ReserveWitness memory reserveWitness =
//                 _constructReserveWitness(expectedDepositId, depositor, token, amount, reserver, releaser, settler);

//             // Generate reserve signature
//             bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

//             // Build the deposit input
//             depositInputs[i] = IEscrow.DepositInput({
//                 permit: permit,
//                 depositor: depositor,
//                 depositWitness: depositWitness,
//                 depositSignature: depositSignature,
//                 reserveWitness: reserveWitness,
//                 reserveSignature: reserveSignature
//             });

//             s_activeDepositIds.push(expectedDepositId);
//             s_activeDeposits[expectedDepositId] = IEscrow.ActiveDeposit({
//                 depositor: depositor,
//                 token: token,
//                 amount: amount,
//                 reserver: reserver,
//                 releaser: releaser,
//                 settler: settler
//             });
//             s_keys[expectedDepositId] = Keys({
//                 reserver: reserver,
//                 reserverPrivateKey: reserverPrivateKey,
//                 releaser: releaser,
//                 releaserPrivateKey: releaserPrivateKey
//             });
//             s_invariantStats.totalDeposits++;
//             s_invariantStats.sumOfDepositAmounts += amount;
//         }
//         s_escrow.depositMany(depositInputs);
//     }

//     function deposit(
//         uint8 allowlistedTokenIndex,
//         uint96 amount,
//         uint256 reserverPrivateKey,
//         uint256 releaserPrivateKey,
//         address settler
//     ) public {
//         vm.assume(amount > 0);
//         vm.assume(settler != address(0));

//         // Secp256k1 curve order (n)
//         uint256 SECP256K1_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

//         // Bound private keys to valid ECDSA range [1, n-1]
//         reserverPrivateKey = bound(reserverPrivateKey, 1, SECP256K1_ORDER - 1);
//         releaserPrivateKey = bound(releaserPrivateKey, 1, SECP256K1_ORDER - 1);

//         address token = address(s_allowlistedTokens[allowlistedTokenIndex % s_allowlistedTokens.length].token);

//         bytes32 depositId;
//         IEscrow.ActiveDeposit memory activeDeposit;
//         address reserver = vm.addr(reserverPrivateKey);
//         address releaser = vm.addr(releaserPrivateKey);

//         vm.assume(reserver.code.length == 0);
//         vm.assume(releaser.code.length == 0);

//         // Scoped block to manage stack depth
//         (address depositor, uint256 depositorPrivateKey) = makeAddrAndKey(string(vm.randomBytes(32)));

//         // Mint and approve
//         IMintable(token).mint(depositor, amount);
//         vm.startPrank(depositor);
//         IERC20(token).approve(address(s_permit2), type(uint256).max);
//         vm.stopPrank();

//         s_depositorNonces[depositor]++;
//         uint256 currentNonce = s_depositorNonces[depositor];

//         // Setup permit data, transfer details, and witness
//         (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
//             _constructDepositPermitWitness(token, amount, reserver, releaser, currentNonce);

//         // Generate signature
//         bytes memory depositSignature =
//             _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

//         // Generate deposit ID
//         depositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

//         IEscrow.ReserveWitness memory reserveWitness =
//             _constructReserveWitness(depositId, depositor, token, amount, reserver, releaser, settler);
//         bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

//         IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
//             permit: permit,
//             depositor: depositor,
//             depositWitness: depositWitness,
//             depositSignature: depositSignature,
//             reserveWitness: reserveWitness,
//             reserveSignature: reserveSignature
//         });
//         vm.prank(settler);
//         s_escrow.deposit(depositInput);

//         activeDeposit = IEscrow.ActiveDeposit({
//             depositor: depositor, token: token, amount: amount, reserver: reserver, releaser: releaser, settler: settler
//         });

//         // Update state outside of scoped block
//         s_activeDepositIds.push(depositId);
//         s_activeDeposits[depositId] = activeDeposit;
//         s_keys[depositId] = Keys({
//             reserver: reserver,
//             reserverPrivateKey: reserverPrivateKey,
//             releaser: releaser,
//             releaserPrivateKey: releaserPrivateKey
//         });
//         s_invariantStats.totalDeposits++;
//         s_invariantStats.sumOfDepositAmounts += amount;
//     }

//     function releaseMany(uint256 howMany) public {
//         if (s_activeDepositIds.length == 0) {
//             depositMany(howMany);
//             return;
//         }

//         bound(howMany, 1, 10);

//         if (howMany > s_activeDepositIds.length) {
//             howMany = s_activeDepositIds.length;
//         }

//         IEscrow.ReleaseInput[] memory releaseInputs = new IEscrow.ReleaseInput[](howMany);
//         for (uint256 i = 0; i < howMany; i++) {
//             // We hage to use this index because we're removing the element from the array at the end of each loop iteration.
//             uint256 index = s_activeDepositIds.length - 1;
//             bytes32 depositId = s_activeDepositIds[index];
//             IEscrow.ActiveDeposit memory activeDeposit = s_activeDeposits[depositId];
//             IEscrow.ReleaseWitness memory releaseWitness = IEscrow.ReleaseWitness({
//                 depositId: depositId,
//                 depositor: activeDeposit.depositor,
//                 token: activeDeposit.token,
//                 amount: activeDeposit.amount,
//                 reserver: activeDeposit.reserver,
//                 releaser: activeDeposit.releaser,
//                 settler: activeDeposit.settler
//             });
//             bytes memory releaseSignature =
//                 _constructReleaseSignature(releaseWitness, address(s_escrow), s_keys[depositId].releaserPrivateKey);
//             releaseInputs[i] =
//                 IEscrow.ReleaseInput({releaseWitness: releaseWitness, releaseSignature: releaseSignature});
//             s_invariantStats.totalReleases++;
//             s_invariantStats.sumOfDepositAmounts -= activeDeposit.amount;
//             _removeDepositIdAtIndex(index);
//             delete s_activeDeposits[depositId];
//         }
//         s_escrow.releaseMany(releaseInputs);
//     }

//     function release(uint256 depositIndex, uint256 one, uint256 two, address three) public {
//         if (s_activeDepositIds.length == 0) {
//             // split depositIndex, use first 8 bits as allowlistedTokenIndex, use last 24 bits as depositIndex
//             // Then call deposit with the allowlistedTokenIndex and the depositIndex
//             uint8 allowlistedTokenIndex = uint8(depositIndex >> 24);
//             uint96 amount = uint96(depositIndex & 0x00000000000000000000000000000000000000000000000000000000000000FF);
//             deposit(allowlistedTokenIndex, amount, one, two, three);
//             return;
//         }

//         // Use mod of depositIndex to get the index of the depositId
//         uint256 index = depositIndex % s_activeDepositIds.length;
//         bytes32 depositId = s_activeDepositIds[index];
//         IEscrow.ActiveDeposit memory activeDeposit = s_activeDeposits[depositId];

//         IEscrow.ReleaseWitness memory releaseWitness = IEscrow.ReleaseWitness(
//             depositId,
//             activeDeposit.depositor,
//             activeDeposit.token,
//             activeDeposit.amount,
//             activeDeposit.reserver,
//             activeDeposit.releaser,
//             activeDeposit.settler
//         );

//         s_invariantStats.sumOfDepositAmounts -= activeDeposit.amount;
//         releaseDeposit(s_escrow, releaseWitness, s_keys[depositId].releaserPrivateKey);
//         _removeDepositIdAtIndex(index);
//         delete s_activeDeposits[depositId];
//         s_invariantStats.totalReleases++;
//     }

//     function refundMany(uint256 howMany) public {
//         if (s_activeDepositIds.length == 0) {
//             depositMany(howMany);
//             return;
//         }

//         bound(howMany, 1, 10);

//         if (howMany > s_activeDepositIds.length) {
//             howMany = s_activeDepositIds.length;
//         }

//         IEscrow.RefundInput[] memory refundInputs = new IEscrow.RefundInput[](howMany);
//         for (uint256 i = 0; i < howMany; i++) {
//             // We hage to use this index because we're removing the element from the array at the end of each loop iteration.
//             uint256 index = s_activeDepositIds.length - 1;
//             bytes32 depositId = s_activeDepositIds[index];
//             IEscrow.ActiveDeposit memory activeDeposit = s_activeDeposits[depositId];
//             IEscrow.RefundWitness memory refundWitness = IEscrow.RefundWitness({
//                 depositId: depositId,
//                 depositor: activeDeposit.depositor,
//                 token: activeDeposit.token,
//                 amount: activeDeposit.amount,
//                 reserver: activeDeposit.reserver,
//                 releaser: activeDeposit.releaser,
//                 settler: activeDeposit.settler
//             });
//             bytes memory refundSignature =
//                 _constructRefundSignature(refundWitness, address(s_escrow), s_keys[depositId].releaserPrivateKey);
//             refundInputs[i] = IEscrow.RefundInput({refundWitness: refundWitness, refundSignature: refundSignature});
//             s_invariantStats.totalRefunds++;
//             s_invariantStats.sumOfDepositAmounts -= activeDeposit.amount;
//             _removeDepositIdAtIndex(index);
//             delete s_activeDeposits[depositId];
//         }
//         s_escrow.refundMany(refundInputs);
//     }

//     function refund(uint256 depositIndex, uint256 one, uint256 two, address three) public {
//         if (s_activeDepositIds.length == 0) {
//             // split depositIndex, use first 8 bits as allowlistedTokenIndex, use last 24 bits as depositIndex
//             // Then call deposit with the allowlistedTokenIndex and the depositIndex
//             uint8 allowlistedTokenIndex = uint8(depositIndex >> 24);
//             uint96 amount = uint96(depositIndex & 0x00000000000000000000000000000000000000000000000000000000000000FF);
//             deposit(allowlistedTokenIndex, amount, one, two, three);
//             return;
//         }

//         // Use mod of depositIndex to get the index of the depositId
//         uint256 index = depositIndex % s_activeDepositIds.length;

//         // If index is even, redirect to release to mimic production behavior more closely
//         if (index % 2 == 0) {
//             release(depositIndex, one, two, three);
//             return;
//         }

//         bytes32 depositId = s_activeDepositIds[index];
//         IEscrow.ActiveDeposit memory activeDeposit = s_activeDeposits[depositId];
//         address depositor = activeDeposit.depositor;

//         IEscrow.RefundWitness memory refundWitness = IEscrow.RefundWitness(
//             depositId,
//             depositor,
//             activeDeposit.token,
//             activeDeposit.amount,
//             activeDeposit.reserver,
//             activeDeposit.releaser,
//             activeDeposit.settler
//         );

//         s_invariantStats.sumOfDepositAmounts -= activeDeposit.amount;
//         refundDeposit(s_escrow, refundWitness, s_keys[depositId].releaserPrivateKey);
//         _removeDepositIdAtIndex(index);
//         delete s_activeDeposits[depositId];
//         s_invariantStats.totalRefunds++;
//     }

//     function randomlySendTokensToEscrow(uint256 tokenIndex, uint256 amount) public {
//         tokenIndex = bound(tokenIndex, 0, s_allowlistedTokens.length - 1);
//         amount = bound(amount, 1, type(uint32).max);
//         IMintable(address(s_allowlistedTokens[tokenIndex].token)).mint(address(s_escrow), amount);
//         s_invariantStats.totalRandomlySentTokensToEscrow++;
//     }

//     function _removeDepositIdAtIndex(uint256 index) internal {
//         uint256 lastIndex = s_activeDepositIds.length - 1;
//         if (index != lastIndex) {
//             s_activeDepositIds[index] = s_activeDepositIds[lastIndex];
//         }
//         s_activeDepositIds.pop();
//     }

//     function printInvariantStats() public view {
//         console.log("totalDeposits", s_invariantStats.totalDeposits);
//         console.log("totalReleases", s_invariantStats.totalReleases);
//         console.log("totalRefunds", s_invariantStats.totalRefunds);
//         console.log("totalRandomTokenTransfersToEscrow", s_invariantStats.totalRandomlySentTokensToEscrow);
//     }
// }
