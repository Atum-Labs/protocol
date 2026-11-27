// Public API for @atum-labs/turnkey-signer.

export { TurnkeyClient } from './client';
export type { TurnkeyClientOpts } from './client';

export {
  getOrCreateTurnkeyClient,
  createIsolatedTurnkeyClient,
} from './client-registry';

export { createTurnkeyStamper, p1363ToDer } from './stamp';
export type { TurnkeyStamper } from './stamp';

export { resolveTurnkeyAccountAddress } from './signer-base';
export type { TurnkeySignerCommonDeps } from './signer-base';

export { TURNKEY_RETRY_BACKOFF_MS } from './constants';

export { noopLogger } from './logger';
export type { Logger } from './logger';

export { noopMeter } from './meter';
export type { Counter, Histogram, InstrumentOptions, Meter } from './meter';

export type {
  SignRawPayloadInput,
  SignRawPayloadResult,
  SignTransactionInput,
  SignTransactionResult,
  TurnkeyAccount,
  TurnkeyActivity,
  TurnkeyWallet,
} from './types';

export { TurnkeyEvmSigner } from './chains/evm';
export { TurnkeySolanaSigner, encodePayload } from './chains/solana';
export {
  TurnkeyTronSigner,
  extractTronSignatureFromTransactionProtobuf,
} from './chains/tron';
export {
  signSecp256k1PreimageAndVerify,
  bytesFromHexOrBytes,
} from './chains/secp256k1-helpers';

export * from './admin';
