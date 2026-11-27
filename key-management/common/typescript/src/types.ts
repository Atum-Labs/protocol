import type { PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { TransactionRequest } from 'ethers';

/** Chain-primitive type pack. Each chain supplies its own concrete shapes via a sub-interface. */
export interface ChainPrimitives {
  Identity: unknown;
  Message: unknown;
  Signature: unknown;
  UnsignedTx: unknown;
  SignedTx: unknown;
}

export interface EvmIdentity {
  /** lowercase 0x-prefixed address, resolved at initialize(). */
  readonly address: string;
}

export interface SolanaIdentity {
  readonly publicKey: PublicKey;
  /** base58 string of publicKey. */
  readonly address: string;
}

export interface StellarIdentity {
  /** `G...` account strkey of the signing key. */
  readonly address: string;
  /** The raw 32-byte ed25519 public key behind `address`. */
  readonly publicKey: Uint8Array;
}

export interface TronIdentity {
  /** base58 address (T…), resolved at initialize(). */
  readonly address: string;
}

/** Fields our code reads on a TronWeb transaction object; open index signature for the rest. */
export interface TronWebTx {
  visible?: boolean;
  txID: string;
  raw_data: {
    contract: Array<Record<string, unknown>>;
    ref_block_bytes: string;
    ref_block_hash: string;
    expiration: number;
    fee_limit?: number;
    timestamp: number;
    [k: string]: unknown;
  };
  raw_data_hex: string;
  signature?: string[];
  [k: string]: unknown;
}

export interface EvmPrimitives extends ChainPrimitives {
  Identity: EvmIdentity;
  Message: string | Uint8Array;
  Signature: string;
  UnsignedTx: TransactionRequest;
  SignedTx: string;
}

export interface SolanaPrimitives extends ChainPrimitives {
  Identity: SolanaIdentity;
  Message: Uint8Array;
  Signature: Uint8Array;
  UnsignedTx: VersionedTransaction;
  SignedTx: VersionedTransaction;
}

/**
 * The members of a Stellar SDK `Transaction` that signers use. Structural on purpose: km-core's
 * public types must not import `@stellar/stellar-sdk` (an optional peer), because consumers that
 * bundle these `.d.ts` files cannot inline the SDK's declarations. A real `Transaction` satisfies it.
 */
export interface StellarTransactionLike {
  /** Source account `G...` strkey (fee payer and default signer). */
  readonly source: string;
  /** SHA-256 of the signature payload (binds the network passphrase). */
  hash(): Uint8Array;
  /** Attach a signature: `publicKey` is the `G...` strkey, `signature` is base64. */
  addSignature(publicKey: string, signature: string): void;
}

export interface StellarPrimitives extends ChainPrimitives {
  Identity: StellarIdentity;
  Message: Uint8Array;
  /** 64-byte Ed25519 signature. */
  Signature: Uint8Array;
  /** A built (and, for Soroban, simulated and assembled) transaction with no signature yet. */
  UnsignedTx: StellarTransactionLike;
  /** Same object, mutated to carry the signature in `signatures`. */
  SignedTx: StellarTransactionLike;
}

export interface TronPrimitives extends ChainPrimitives {
  Identity: TronIdentity;
  Message: string;
  Signature: string;
  UnsignedTx: TronWebTx;
  SignedTx: TronWebTx;
}

export type ChainKind = 'evm' | 'solana' | 'stellar' | 'tron';

/** EIP-712 typed-data argument triple accepted by `signTypedData`. */
export interface TypedDataDomain {
  name?: string;
  version?: string;
  chainId?: number | bigint | string;
  verifyingContract?: string;
  salt?: string | Uint8Array;
}
export type TypedDataTypes = Record<string, Array<{ name: string; type: string }>>;

/**
 * The core signer contract. Every provider implements this for each chain it supports.
 * Exactly one of `signTransaction` / `sendTransaction` must be present.
 */
export interface Signer<T extends ChainPrimitives> {
  readonly identity: T['Identity'];

  initialize?(): Promise<void>;

  signMessage(msg: T['Message']): Promise<T['Signature']>;

  signTransaction?(tx: T['UnsignedTx']): Promise<T['SignedTx']>;

  sendTransaction?(tx: T['UnsignedTx']): Promise<{ txHash: string }>;

  /** Sign over `keccak256(preimage)`; returns a recoverable 65-byte secp256k1 signature. */
  signPreimage?(preimage: Uint8Array): Promise<string>;

  /** EIP-712 typed-data signing, routed through `signPreimage` (keccak256 server-side). */
  signTypedData?(
    domain: TypedDataDomain,
    types: TypedDataTypes,
    message: Record<string, unknown>,
  ): Promise<string>;
}

export type EvmSigner = Signer<EvmPrimitives>;
export type SolanaSigner = Signer<SolanaPrimitives>;
export type StellarSigner = Signer<StellarPrimitives>;
export type TronSigner = Signer<TronPrimitives>;
