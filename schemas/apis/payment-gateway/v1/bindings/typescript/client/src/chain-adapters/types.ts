/**
 * Chain defaults returned by the payment gateway /v1/defaults endpoint.
 */
export interface ChainDefaults {
  escrowContract: string;
  quoteSelector: string;
  fulfillmentVerifierAccount: string;
  fulfillmentVerifierEndpoint: string;
  fulfillmentProxy: string;
  permit2Contract?: string;
  /**
   * Solana escrow domain-separation fields, used to build the EscrowDomain the deposit hash
   * binds to. Absent for EVM/Tron.
   */
  svmSignatureClusterId?: string;
  svmSignatureDomainVersion?: number;
  /**
   * The depositRequestHash version to sign for a deposit from this chain: 1, keccak256 of the
   * request_id, or 2, the hash of the request's terms. Read with `depositRequestHashVersions` by
   * `depositRequestHashVersionsOf`.
   */
  depositRequestHashVersion?: number;
  /**
   * The depositRequestHash versions a deposit from this chain may be signed with, ascending: `[1]`,
   * `[1, 2]`, or `[2]` once the gateway no longer accepts v1. Absent from a gateway that predates
   * it. `preparePaymentRequest` signs v2 when it lists 2 (or, absent, when
   * `depositRequestHashVersion` is 2), and v1 otherwise.
   */
  depositRequestHashVersions?: number[];
  /**
   * The depositRequestHash version the gateway derives an originator-executed (direct) deposit's
   * id at, so the version that deposit's witness must commit: 1, keccak256 of the request_id, or
   * 2, the hash of the request's terms, the only versions today. `prepareDirectDepositRequest`
   * builds the deposit at it when you do not pass a version. Published for EVM chains only, and
   * absent from a gateway that predates it. It is carried as published, so a later version can
   * appear here:
   * `prepareDirectDepositRequest` refuses to build a direct deposit at a version other than 1 or 2,
   * whatever you pass, because that deposit would name no payment. Version 1 is deprecated for
   * direct deposits. Unrelated to `depositRequestHashVersion(s)`, which describe Permit2
   * signatures.
   */
  directDepositRequestHashVersion?: number;
  /**
   * Every escrow the gateway accepts a payment into on this chain, the default `escrowContract`
   * first, with how each one's signers sign. Absent from a gateway that predates it. Read with
   * {@link escrowSigningOf}.
   */
  escrows?: ChainEscrow[];
}

/** One escrow of {@link ChainDefaults.escrows}. */
export interface ChainEscrow {
  /** The escrow's address, or on Solana its program id. */
  escrowContract: string;
  /** Solana only: this escrow's signature domain version. */
  svmSignatureDomainVersion?: number;
  /**
   * Solana only: what a signer signs over this escrow's hashes. Absent or `''`: the 32-byte hash
   * itself. `'escrow-text-v1'`: the escrow text.
   */
  svmMessage?: string;
}

/**
 * Chain-specific overrides for the request-body contract fields
 * (`quote_selector`, `fulfillment_verifier`). Some chains must rewrite the raw
 * /v1/defaults values before they go on the wire — e.g. Tron normalizes base58
 * (`T…`) addresses to the canonical 20-byte hex the on-chain verifier and the
 * signed permit witness use. A chain that needs no rewrite returns undefined
 * and the caller falls back to the raw defaults. Applied identically on the
 * payment and quote paths, so their contract fields never diverge.
 */
export interface ContractFieldOverrides {
  quote_selector?: string;
  fulfillment_verifier?: {
    account: string;
    endpoint: string;
  };
}

/**
 * Throw a consistent, key-free error when a private key does not derive the
 * expected sender address. Adapters compare in their chain's canonical form and
 * pass the boolean result; the message names only the public addresses.
 */
export function assertKeyMatchesSender(matches: boolean, sender: string, derived: string): void {
  if (!matches) {
    throw new Error(
      `The private key derives ${derived}, which does not match the sender address ${sender}`,
    );
  }
}

/**
 * Chain adapter for the client-side concerns layered on the shared sender-auth
 * SDK (`@atum-labs/payment-request-sender-auth`), which builds and signs the
 * messages: contract-field normalization, Turnkey account mapping, and
 * private-key hygiene for the raw-key signing path.
 */
export interface ChainAdapter {
  /**
   * Turnkey account address format (e.g. `ADDRESS_FORMAT_ETHEREUM`), used to map a
   * wallet account back to this chain's namespace. Absent for a chain whose Turnkey format
   * is not confirmed (Stellar), which the reverse lookup then never claims.
   */
  turnkeyAddressFormat?: string;

  /**
   * Resolve chain-specific overrides for the request-body contract fields
   * (`quote_selector`, `fulfillment_verifier`). Both preparePaymentRequest and
   * prepareQuoteRequest resolve these fields through this one method, so the
   * payment and quote paths always carry byte-identical contract fields.
   * Returns undefined when the chain needs no rewrite (EVM); Tron normalizes
   * base58 → canonical hex.
   */
  resolveContractOverrides?(sourceDefaults: ChainDefaults): ContractFieldOverrides | undefined;

  /** Normalize private key format for this chain. */
  formatPrivateKey(key: string): string;

  /**
   * Reject a malformed raw key value-free (throwing `Invalid private key`)
   * before it reaches the chain's signing library. Chains whose key decoding
   * already fails without echoing the key (e.g. Solana's bs58/length checks)
   * omit this; EVM/Tron implement it because `ethers.Wallet` embeds the key
   * value verbatim in its error for malformed input.
   */
  validatePrivateKey?(key: string): void;

  /**
   * Assert the private key derives `address`, so a wrong key/sender pair fails
   * fast (mirrors the Turnkey pinnedAddress check) instead of signing as the
   * wrong depositor and only failing downstream. Throws on mismatch. The error
   * names the addresses (public) but never the key.
   */
  verifyAddressMatchesKey?(privateKey: string, address: string): void;
}
