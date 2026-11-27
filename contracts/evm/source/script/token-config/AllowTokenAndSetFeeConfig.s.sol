// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Escrow} from "../../src/Escrow.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> TOKEN_ADDRESS=<TOKEN_ADDRESS> TOKEN_DECIMALS=<TOKEN_DECIMALS> FEE_PERCENTAGE=<FEE_PERCENTAGE> MIN_FEE=<MIN_FEE> MAX_FEE=<MAX_FEE> forge script script/token-config/AllowTokenAndSetFeeConfig.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <TOKEN_CONFIG_ROLE_ADDRESS>
//
// Fee values are scaled by 10^6:
//   FEE_PERCENTAGE: e.g., 20000 = 0.02%
//   MIN_FEE: e.g., 1000000 = $1
//   MAX_FEE: the protocol fee cap. CURRENT POLICY IS 250000000 = $250.
//
// MAX_FEE has no default -- whatever you export is written on-chain -- and this comment is the
// only guidance in the repo, so it is the control surface for a deployment. This value MUST equal
// the fee cap veri-fill signs release and refund witnesses with. A mismatch reverts
// InvalidWitnessValues on BOTH paths for any deposit above the cap threshold, so it is neither
// releasable nor refundable and there is no rescue function. Below the threshold neither cap binds
// and the two agree, which is why a mismatch can go unnoticed for a long time.
//
// 6-DECIMAL TOKENS ONLY. determineFee scales this by the token's decimals
// (maxFee6Decimals * 10^tokenDecimals / 1e6) while the offchain signer applies the raw value flat,
// so they agree at 6 decimals and diverge wildly elsewhere. Do NOT pass this cap for an
// 18-decimal token.

contract AllowTokenAndSetFeeConfig is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        Escrow escrow = Escrow(contractAddress);

        address tokenAddress = vm.envAddress("TOKEN_ADDRESS");
        uint8 tokenDecimals = uint8(vm.envUint("TOKEN_DECIMALS"));
        uint88 feePercentage = uint88(vm.envUint("FEE_PERCENTAGE"));
        uint80 minFee = uint80(vm.envUint("MIN_FEE"));
        uint80 maxFee = uint80(vm.envUint("MAX_FEE"));

        console.log("Allowing token and setting fee config:", tokenAddress);
        console.log("Token decimals:", tokenDecimals);
        console.log("Fee percentage (6 decimals):", feePercentage);
        console.log("Min fee (6 decimals):", minFee);
        console.log("Max fee (6 decimals):", maxFee);

        escrow.allowTokenAndSetFeeConfig(IERC20(tokenAddress), tokenDecimals, feePercentage, minFee, maxFee);

        console.log("Token allowed and fee config set successfully");

        vm.stopBroadcast();
    }
}
