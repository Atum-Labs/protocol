# TVM on-chain specification

Selector, event and error registry for the Tron deployment. Escrow, FulfillmentProxy and TIP712 are
deployed on Shasta with no such registry until now, so a revert gave an integrator four bytes and
nowhere to resolve them.

The Solidity is shared with EVM, so the selectors match
[`../../evm/source/ONCHAIN_SPEC.md`](../../evm/source/ONCHAIN_SPEC.md). What differs is deployment,
not encoding. Deployed addresses are in [`../deployments-v4.json`](../deployments-v4.json).

Selectors below were derived with `cast sig` over `generated/abi/`, the same method the EVM document
uses. Regenerate the ABIs with `make generate-abi` before trusting them after a contract change.

> `generated/abi/Atum.json` is a stale V3 artifact with no source in `contracts/` and no entry in the
> Makefile's `ABI_SOURCES`. It is deliberately excluded here. Anything decoded against it is not a
> Tron deployment of this protocol.
>
> `generated/abi/IERC20.json` is the vendored OpenZeppelin token interface rather than a protocol
> contract, so its selectors and topics are omitted too. `Transfer(address,address,uint256)` is the
> most common topic on a settlement transaction and resolves through the token's own ABI, not this
> document.

## Error selectors

| Selector | Error | Raised when | Declared in |
| --- | --- | --- | --- |
| `0x0207dd3e` | `Permit2CannotBeZeroAddress()` | The Permit2 address in the constructor was zero | Escrow,IEscrow |
| `0x0f6ce477` | `TokenDecimalsMismatch(uint8,uint8)` | The configured decimals differ from the token contract | Escrow,ITokenConfig |
| `0x1503f5f8` | `DeadlineExpired(uint256,uint256)` | The authorization deadline has passed | FulfillmentProxy,IFulfillmentProxy |
| `0x16506d3c` | `TokenDecimalsExceedMaximum(uint8,uint8)` | The token declares more decimals than the fee maths supports | Escrow,ITokenConfig |
| `0x19ca5ebb` | `AccessControlEnforcedDefaultAdminDelay(uint48)` | An admin transfer was accepted before its delay elapsed | Escrow,FulfillmentProxy |
| `0x19dff492` | `DepositRequestHashCannotBeEmpty()` | The depositor-signed commitment was all zeros | Escrow,IEscrow |
| `0x1ea4356e` | `NonExactTransfer(uint256,uint256)` | The token moved a different amount than requested, which a fee-on-transfer token does | Escrow,IEscrow |
| `0x1f2a2005` | `ZeroAmount()` | The fulfillment amount was zero | FulfillmentProxy,IFulfillmentProxy |
| `0x27cdc301` | `FeePercentageCannotBeZeroWhenMaxFeeIsSet()` | A max fee was configured with a zero percentage, which would clamp every fee to zero | Escrow,ITokenConfig |
| `0x2832a249` | `DestinationCannotBeEmpty()` | The committed destination string was empty | Escrow,IEscrow |
| `0x28a9ec51` | `DepositCannotBeZeroAddress()` | The depositor was the zero address | Escrow,IEscrow |
| `0x3176eb12` | `DepositAmountCannotBeZero()` | The deposit amount was zero | Escrow,IEscrow |
| `0x33529975` | `NotReserved(bytes32)` | Release was called on a deposit that has no recipient set | Escrow,IEscrow |
| `0x36f18e62` | `ReserverCannotBeZeroAddress()` | The reserver role account was left at the zero address | Escrow,IEscrow |
| `0x3fc3c27a` | `AccessControlEnforcedDefaultAdminRules()` | An operation violated the OpenZeppelin default-admin rules | Escrow,FulfillmentProxy |
| `0x43e30ca8` | `DepositNotFound(bytes32)` | The deposit is not active: it never existed, it completed and its storage was cleared, or the supplied depositId does not match the reserve witness. See "One error, several conditions" | Escrow,IEscrow |
| `0x4762f18f` | `MaxFeeNotRepresentable(uint80,uint8)` | The max fee truncates to zero atoms at this token decimals | Escrow,ITokenConfig |
| `0x4be6321b` | `InvalidSignatureLength()` | A Permit2 signature was not 64 or 65 bytes | SignatureVerification |
| `0x5274afe7` | `SafeERC20FailedOperation(address)` | The token call reverted or returned false | Escrow,FulfillmentProxy |
| `0x533a2468` | `ChainIdExceedsTip712Mask(uint256)` | The chain id does not fit the TIP-712 domain mask | Escrow |
| `0x5e060202` | `UsdtTransferDidNotMove(uint256,uint256)` | A USDT transfer reported success but the balance did not change | Escrow,IEscrow |
| `0x5f5d3399` | `TokenCannotBeZeroAddress()` |  | Escrow,ITokenConfig |
| `0x6697b232` | `AccessControlBadConfirmation()` |  | Escrow,FulfillmentProxy |
| `0x6896e030` | `InvalidWitnessValues(bytes32,bytes32,bytes32)` |  | Escrow,IEscrow |
| `0x6dfcc650` | `SafeCastOverflowedUintDowncast(uint8,uint256)` |  | Escrow,FulfillmentProxy |
| `0x7170b34f` | `AlreadyFulfilled(bytes32)` |  | FulfillmentProxy,IFulfillmentProxy |
| `0x744674ae` | `DepositAlreadyExists(bytes32)` |  | Escrow,IEscrow |
| `0x7b59c1fd` | `QuoteHashCannotBeEmpty()` |  | Escrow,FulfillmentProxy,IEscrow,IFulfillmentProxy |
| `0x815e1d64` | `InvalidSigner()` |  | SignatureVerification |
| `0x8346757c` | `ReleaserCannotBeZeroAddress()` |  | Escrow,IEscrow |
| `0x858c0a0c` | `MinFeeNotRepresentable(uint80,uint8)` |  | Escrow,ITokenConfig |
| `0x8ae7025d` | `SettlerCannotBeZeroAddress()` |  | Escrow,IEscrow |
| `0x8baa579f` | `InvalidSignature()` | A TIP-712 reserver or releaser signature did not validate, or a Permit2 signature did not recover. Shared selector, see below | Escrow,IEscrow,SignatureVerification |
| `0x8dfc202b` | `ExpectedPause()` |  | Escrow,FulfillmentProxy |
| `0x94403b70` | `TokenNotAllowed(address)` |  | Escrow,ITokenConfig |
| `0x94cd330a` | `FeePercentageExceedsMaximum(uint88)` |  | Escrow,ITokenConfig |
| `0x97e0deb1` | `InvalidSourceAmount()` |  | Escrow,IEscrow |
| `0x98ca6b25` | `DestinationTooLong(uint256)` |  | Escrow,IEscrow |
| `0x9ba754d0` | `TokenAlreadyAllowed(address)` |  | Escrow,ITokenConfig |
| `0x9e9e79e9` | `NoFeesToWithdraw(address)` |  | Escrow,ITokenConfig |
| `0xb0669cbc` | `InvalidContractSignature()` |  | SignatureVerification |
| `0xb399ae3a` | `FeeExceedsDepositAmount(uint256,uint256)` |  | Escrow,ITokenConfig |
| `0xc0d95a7c` | `TokenDecimalsCannotBeZero()` |  | Escrow,ITokenConfig |
| `0xc22c8022` | `AccessControlInvalidDefaultAdmin(address)` |  | Escrow,FulfillmentProxy |
| `0xd8707052` | `RecipientCannotBeZeroAddress()` |  | Escrow,ITokenConfig |
| `0xd8f2c9ae` | `USDTCannotBeZeroAddress()` |  | Escrow,IEscrow |
| `0xd93c0665` | `EnforcedPause()` |  | Escrow,FulfillmentProxy |
| `0xe1ca0a42` | `EmptyFulfillmentBatch()` |  | FulfillmentProxy,IFulfillmentProxy |
| `0xe2517d3f` | `AccessControlUnauthorizedAccount(address,bytes32)` |  | Escrow,FulfillmentProxy |
| `0xe2918e9f` | `RecipientCannotBeSelf()` |  | Escrow,ITokenConfig |
| `0xed9a940e` | `MinFeeCannotBeGreaterThanMaxFee()` |  | Escrow,ITokenConfig |
| `0xfeba82c1` | `CouldNotDisallowToken(address)` |  | Escrow,ITokenConfig |

## One error, several conditions

A selector names the error, not the reason. These are raised for more than one condition, so a caller
that treats the selector as the diagnosis will draw the wrong conclusion.

### `DepositNotFound(bytes32)` — `0x43e30ca8`

Three unrelated conditions, at `contracts/Escrow.sol:213`, `:346` and `:448`:

1. The deposit never existed.
2. The deposit completed — released or refunded — and `_activeDepositHashes` was cleared.
3. `deposit` was called and the supplied `depositId` does not match the reserve witness.

The revert carries the `depositId`, so you know *which* deposit. You do not know which of the three.

**Do not conclude the payment never landed.** To separate (1) from (2), look for a settlement of that
`depositId` in the logs, and note that how you look depends on how it settled:

| Settled via | Event | Filterable by depositId |
| --- | --- | --- |
| `release` / `refund` | `Released` / `Refunded` | Yes, `depositId` is indexed |
| `releaseMany` / `refundMany` | `ReleasedMany` / `RefundedMany` | **No.** The witness array is deliberately non-indexed, so you must decode the event data and search it |

A batch-settled deposit produces no `Released` or `Refunded` log at all. Filtering only on those and
finding nothing is therefore *not* evidence the deposit never landed, and re-submitting on that basis
is a second payment. Condition (3) is on the deposit path, where no settlement log can exist either
way — tell it apart by which function reverted.

### `InvalidSignature()` — `0x8baa579f`

One error name raised from two places, not a collision between two errors: the TIP-712 check in
`Escrow` and Permit2's `SignatureVerification`. Disambiguate by which leg reverted, not by the bytes.

Permit2 can also reject with `InvalidSigner()` or `InvalidContractSignature()`. Both are in
`SignatureVerification` and so appear in the table above, alongside `InvalidSignatureLength()`.

## Permit2 errors absent from our ABI

Reachable through the deposit path and **not** in `generated/abi/`, so they decode to nothing unless
an integrator adds Permit2's ABI. `InvalidNonce` in particular is a routine production failure — it
means the permit nonce was already spent.

| Selector | Error | Raised when |
| --- | --- | --- |
| `0x756688fe` | `InvalidNonce()` | The permit nonce was already spent |
| `0xcd21db4f` | `SignatureExpired(uint256)` | The permit deadline has passed |
| `0x3728b83d` | `InvalidAmount(uint256)` | The requested amount exceeds what the permit authorized |

## Function selectors

| Selector | Function | Contract |
| --- | --- | --- |
| `0x01ffc9a7` | `supportsInterface(bytes4)` | Escrow |
| `0x022d63fb` | `defaultAdminDelayIncreaseWait()` | Escrow |
| `0x024ece89` | `getAllowedTokens()` | Escrow |
| `0x0aa6220b` | `rollbackDefaultAdminDelay()` | Escrow |
| `0x165b3f36` | `refundMany(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes)[])` | Escrow |
| `0x248a9ca3` | `getRoleAdmin(bytes32)` | Escrow |
| `0x269b634d` | `releaseMany(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes)[])` | Escrow |
| `0x2f1ca9b2` | `clearTokenFeeConfig(address)` | Escrow |
| `0x2f2ff15d` | `grantRole(bytes32,address)` | Escrow |
| `0x3644e515` | `DOMAIN_SEPARATOR()` | Escrow |
| `0x36568abe` | `renounceRole(bytes32,address)` | Escrow |
| `0x3f4ba83a` | `unpause()` | Escrow |
| `0x41daeb24` | `getFeeRevenue(address)` | Escrow |
| `0x534201f4` | `i_usdt()` | Escrow |
| `0x549ef0d1` | `allowToken(address,uint8)` | Escrow |
| `0x5c975abb` | `paused()` | Escrow |
| `0x634e93da` | `beginDefaultAdminTransfer(address)` | Escrow |
| `0x63d478ca` | `depositMany((((address,uint256),uint256,uint256),address,(bytes32,string,address,address),bytes,(bytes32,bytes32,address,uint256),bytes)[])` | Escrow |
| `0x649a5ec7` | `changeDefaultAdminDelay(uint48)` | Escrow |
| `0x663558a7` | `getDepositHash(bytes32)` | Escrow |
| `0x7445e85c` | `SETTLER_ROLE()` | FulfillmentProxy |
| `0x75154601` | `withdrawFeeRevenue(address,address)` | Escrow |
| `0x76573485` | `setSettlerAllowlistEnforced(bool)` | FulfillmentProxy |
| `0x7905fbfa` | `strictFulfill((bytes32,address,address,uint256),uint256)` | FulfillmentProxy |
| `0x7aa0f50d` | `setTokenFeeConfig(address,uint88,uint80,uint80)` | Escrow |
| `0x8456cb59` | `pause()` | Escrow |
| `0x84ef8ffc` | `defaultAdmin()` | Escrow |
| `0x8b90d672` | `determineFee(uint256,(uint88,uint80,uint80,uint8))` | Escrow |
| `0x8da5cb5b` | `owner()` | Escrow |
| `0x8fdf27e9` | `allowTokenAndSetFeeConfig(address,uint8,uint88,uint80,uint80)` | Escrow |
| `0x91d14854` | `hasRole(bytes32,address)` | Escrow |
| `0x9bd384a7` | `i_permit2()` | Escrow |
| `0xa1109d85` | `TOKEN_CONFIG_ROLE()` | Escrow |
| `0xa1eda53c` | `pendingDefaultAdminDelay()` | Escrow |
| `0xa217fddf` | `DEFAULT_ADMIN_ROLE()` | Escrow |
| `0xcb67e3b1` | `getTokenConfig(address)` | Escrow |
| `0xcc8463c8` | `defaultAdminDelay()` | Escrow |
| `0xcefc1429` | `acceptDefaultAdminTransfer()` | Escrow |
| `0xcf6eefb7` | `pendingDefaultAdmin()` | Escrow |
| `0xd547741f` | `revokeRole(bytes32,address)` | Escrow |
| `0xd602b9fd` | `cancelDefaultAdminTransfer()` | Escrow |
| `0xd83efe46` | `s_settlerAllowlistEnforced()` | FulfillmentProxy |
| `0xda00124e` | `fulfillMany((bytes32,address,address,uint256)[])` | FulfillmentProxy |
| `0xdf851fad` | `release(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes))` | Escrow |
| `0xe63ab1e9` | `PAUSER_ROLE()` | Escrow |
| `0xe79767af` | `disallowToken(address)` | Escrow |
| `0xeeb69408` | `refund(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes))` | Escrow |
| `0xf0630329` | `fulfill((bytes32,address,address,uint256))` | FulfillmentProxy |
| `0xf0a3a97c` | `TREASURER_ROLE()` | Escrow |
| `0xf2eb65e0` | `deposit((((address,uint256),uint256,uint256),address,(bytes32,string,address,address),bytes,(bytes32,bytes32,address,uint256),bytes))` | Escrow |
| `0xf9eaee0d` | `isTokenAllowed(address)` | Escrow |

## Event topics

| topic0 | Event | Contract |
| --- | --- | --- |
| `0x2b1fa2edafe6f7b9e97c1a9e0c3660e645beb2dcaa2d45bdbf9beaf5472e1ec5` | `DefaultAdminDelayChangeCanceled()` | Escrow |
| `0xf1038c18cf84a56e432fdbfaf746924b7ea511dfe03a6506a0ceba4888788d9b` | `DefaultAdminDelayChangeScheduled(uint48,uint48)` | Escrow |
| `0x8886ebfc4259abdbc16601dd8fb5678e54878f47b3c34836cfc51154a9605109` | `DefaultAdminTransferCanceled()` | Escrow |
| `0x3377dc44241e779dd06afab5b788a35ca5f3b778836e2990bdb26a2a4b2e5ed6` | `DefaultAdminTransferScheduled(address,uint48)` | Escrow |
| `0xdd71cfeda84126f075a6e6c4e6aacadc514806a79f1bccb0619818b7736eefc5` | `DepositCommitments(bytes32,bytes32,bytes32)` | Escrow |
| `0x00d99cb530e2d4ecb11da22fd966de4bd68000fdbc6b822f902163642404000e` | `Deposited(bytes32,bytes32,address,address,address,uint256,uint256,address,address)` | Escrow |
| `0x837f538e17106ab6df4c0f8a1de4e8127c1dc86827e956daebf9942a0406e2d0` | `DepositedMany(bytes32[],(bytes32,string,address,address)[],(bytes32,bytes32,address,uint256)[],uint256[])` | Escrow |
| `0x76ac859941c37173539323f59a86de5409d3350f8f407088f35d10e79557fc99` | `FeeRevenueWithdrawn(address,address,uint256)` | Escrow |
| `0x6344d803114225f61bd0be81b7f0810daff32f11666c3e6e0f51e50a8c7450f2` | `Fulfilled(bytes32,address,address,address,uint256,uint256)` | FulfillmentProxy |
| `0xa55853fe36e243bbd57e73a1582a883508e206be6fce5a8f07e29cb0808959b5` | `FulfilledMany((bytes32,address,address,uint256)[],address,uint256)` | FulfillmentProxy |
| `0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258` | `Paused(address)` | Escrow |
| `0x2e0668a62a5f556368dca9c7113e20f2852c05155548243804bf714ce72b25a6` | `Refunded(bytes32,address,address,uint256)` | Escrow |
| `0x949fa5cc9abe2cf38fdd057482e67cc01d31361a8981e80cc0ac93396ecfa801` | `RefundedMany((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address)[])` | Escrow |
| `0x703d1f677dc7a240b8578621df4ac5a0d8323e943fcc50ce0ffd9dcc8f6974cc` | `Released(bytes32,address,address,uint256,uint256)` | Escrow |
| `0x63ae99db9a784d0cfddbfc24a172533fca09ed92f286131b04742dbceac30016` | `ReleasedMany((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address)[])` | Escrow |
| `0xbd79b86ffe0ab8e8776151514217cd7cacd52c909f66475c3af44e129f0b00ff` | `RoleAdminChanged(bytes32,bytes32,bytes32)` | Escrow |
| `0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d` | `RoleGranted(bytes32,address,address)` | Escrow |
| `0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b` | `RoleRevoked(bytes32,address,address)` | Escrow |
| `0x86330013ac079c8cb36d0e3bc6a0faa3f21f62de7570ea02aa265464cfc43854` | `SettlerAllowlistEnforcementSet(bool)` | FulfillmentProxy |
| `0xe3a2f60d67f76ac1de94f074db7146923e99f6cb205066d3c1a23749677f3305` | `TokenAllowed(address,uint8)` | Escrow |
| `0xeaa9136602e3b70a4e689b5b6f55bda25ca62b917d839c0ff87f5902387f77b9` | `TokenDisallowed(address)` | Escrow |
| `0x475663cd3704d5c0c391c5f6b3f338694109b06b355a629e72ec57d40241b441` | `TokenFeesCleared(address)` | Escrow |
| `0xc6f10594e7d46a9a199c763fc19b5da209bf35ac4aa1360c386f881d3c4b03c5` | `TokenFeesUpdated(address,uint88,uint80,uint80)` | Escrow |
| `0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa` | `Unpaused(address)` | Escrow |

## Divergence from EVM

- **Addresses are independent.** A Tron address is base58 over a 21-byte payload, so the same
  bytecode has a different address string. Never reuse an EVM address here.
- **TIP-712, not EIP-712.** The struct hashes match, but the domain separator binds a Tron chain id,
  so a signature is not portable between the two chains.
- **Energy and bandwidth replace gas.** A revert still consumes the caller's energy.

## Before trusting a selector against a live deployment

This document is generated from the source at HEAD. The contract at the address in
`deployments-v4.json` was built from whatever commit was deployed, which may be older. Confirm the
deployed version before concluding that a selector you cannot decode is unknown rather than simply
newer or older than the chain.
