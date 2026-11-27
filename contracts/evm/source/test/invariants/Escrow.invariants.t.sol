// // SPDX-License-Identifier: MIT
// pragma solidity 0.8.27;

// import {Test, console, Vm} from "forge-std/Test.sol";
// import {EscrowInvariantsHandler} from "./Escrow.handler.t.sol";
// import {IEscrow, Escrow} from "../../src/Escrow.sol";
// import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
// import {MockToken, MockToken8Decimals, MockToken6Decimals} from "../mock/MockToken.sol";
// import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// contract EscrowInvariantsTest is Test {
//     EscrowInvariantsHandler public s_handler;
//     Escrow public s_escrow;
//     IPermit2 public s_permit2;

//     MockToken private s_token18Decimals;
//     MockToken8Decimals private s_token8Decimals;
//     MockToken6Decimals private s_token6Decimals;

//     function setUp() public {
//         // Fork Ethereum mainnet
//         // We're doing this to test the live Permit2 contract on mainnet
//         string memory rpcUrl = vm.envString("ETH_MAINNET_RPC");
//         vm.createSelectFork(rpcUrl);

//         // Use existing Permit2 deployment on ethereum mainnet
//         address permit2Address = vm.envAddress("PERMIT2_ADDRESS");
//         s_permit2 = IPermit2(permit2Address);

//         // Deploy our contracts
//         s_token18Decimals = new MockToken("Test Token 18 Decimals", "TEST18");
//         s_token8Decimals = new MockToken8Decimals("Test Token 8 Decimals", "TEST8");
//         s_token6Decimals = new MockToken6Decimals("Test Token 6 Decimals", "TEST6");

//         IEscrow.AllowlistedToken[] memory allowlistedTokens = new IEscrow.AllowlistedToken[](3);
//         allowlistedTokens[0] = IEscrow.AllowlistedToken({token: s_token18Decimals, decimals: 18});
//         allowlistedTokens[1] = IEscrow.AllowlistedToken({token: s_token8Decimals, decimals: 8});
//         allowlistedTokens[2] = IEscrow.AllowlistedToken({token: s_token6Decimals, decimals: 6});

//         s_handler = new EscrowInvariantsHandler();

//         Ownable(address(allowlistedTokens[0].token)).transferOwnership(address(s_handler));
//         Ownable(address(allowlistedTokens[1].token)).transferOwnership(address(s_handler));
//         Ownable(address(allowlistedTokens[2].token)).transferOwnership(address(s_handler));

//         s_escrow = new Escrow(s_permit2, address(s_handler), allowlistedTokens);
//         s_handler.setState(s_escrow, s_permit2, allowlistedTokens);

//         bytes4[] memory selectors = new bytes4[](7);
//         selectors[0] = EscrowInvariantsHandler.deposit.selector;
//         selectors[1] = EscrowInvariantsHandler.depositMany.selector;
//         selectors[2] = EscrowInvariantsHandler.release.selector;
//         selectors[3] = EscrowInvariantsHandler.releaseMany.selector;
//         selectors[4] = EscrowInvariantsHandler.refund.selector;
//         selectors[5] = EscrowInvariantsHandler.refundMany.selector;
//         selectors[6] = EscrowInvariantsHandler.randomlySendTokensToEscrow.selector;

//         targetSelector(FuzzSelector({addr: address(s_handler), selectors: selectors}));
//         targetContract(address(s_handler));
//         excludeContract(address(s_escrow));
//         excludeContract(address(s_permit2));
//         excludeContract(address(s_token18Decimals));
//         excludeContract(address(s_token8Decimals));
//         excludeContract(address(s_token6Decimals));
//     }

//     function invariant_balance_greater_or_equal_to_sum_of_deposits() public view {
//         (,,, uint256 sumOfDepositAmounts,) = s_handler.s_invariantStats();
//         uint256 sumOfEscrowBalances = s_handler.getSumOfEscrowBalances();
//         assertGe(sumOfEscrowBalances, sumOfDepositAmounts);
//         s_handler.printInvariantStats();
//     }
// }
