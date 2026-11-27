// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

// The 6-decimal double deploy:local uses for USDC and USDT. tronbox compiles only contracts/, so
// this brings in the Foundry suite's copy of the EVM tree's TestToken rather than a third copy.
import {TestToken} from "../../foundry_tests/mock/TestToken.sol";
