/** Deterministic ids and ledger keys. Pure functions: no network, no keys. */
import { Address, StrKey, hash, xdr } from '@stellar/stellar-sdk';

export type ContractKind = 'escrow' | 'fulfillment-proxy';

const WASM_MAGIC = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/** SHA-256 through the SDK's `hash`, the same primitive Stellar derives network and contract ids with. */
export function sha256(data: Uint8Array): Buffer {
  return Buffer.from(hash(Buffer.from(data)));
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

/** Reject anything that is not a wasm module before it costs a transaction fee. */
export function assertWasm(bytes: Uint8Array, label: string): void {
  if (bytes.length < WASM_MAGIC.length || !WASM_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new Error(`${label}: not a WebAssembly module (bad magic bytes)`);
  }
}

/**
 * Salt for the deterministic contract id. Same deployer + kind + tag on the same network always
 * yields the same address, which is what makes a re-run find the existing instance instead of
 * deploying a second one. A new version of a contract is a new `--salt-tag`.
 */
export function deploySalt(kind: ContractKind, saltTag: string): Buffer {
  return sha256(Buffer.from(`atum/stellar/${kind}/${saltTag}`, 'utf8'));
}

/** contract id = sha256(HashIdPreimage::ContractId{network_id, FromAddress{deployer, salt}}) */
export function deriveContractId(
  networkPassphrase: string,
  deployer: string,
  salt: Uint8Array,
): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(networkPassphrase, 'utf8')),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: new Address(deployer).toScAddress(),
          salt: Buffer.from(salt),
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

export function contractCodeKey(wasmHash: Uint8Array): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHash) }));
}

export function contractInstanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

/**
 * The ledger key of `holder`'s balance inside a Stellar Asset Contract: a persistent entry in the
 * token contract's own data, keyed by the `Balance(Address)` variant of the contract's data-key enum,
 * which is a two-element vec of the symbol `Balance` and the holder. The escrow's keep-alive does not
 * touch it. Only a Stellar Asset Contract is known to use this layout; a custom token has its own.
 */
export function tokenBalanceKey(token: string, holder: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(token).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Balance'), new Address(holder).toScVal()]),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

export function stateArchivalConfigKey(): xdr.LedgerKey {
  return xdr.LedgerKey.configSetting(
    new xdr.LedgerKeyConfigSetting({
      configSettingId: xdr.ConfigSettingId.configSettingStateArchival,
    }),
  );
}
