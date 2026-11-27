import { getBytes, hexlify } from 'ethers';
import nacl from 'tweetnacl';
import {
  Pubkey,
  computeDepositHash,
  MAX_DEPOSIT_VALIDITY_SECS,
  type EscrowDomain,
} from '@atum-labs/stellar-escrow-encoding';

import type {
  ChainAdapter,
  AuthMessageResult,
  StellarDepositPrehash,
  SignedMessageInput,
  SourceRef,
  VerifyExpectations,
  VerifiedSenderAuth,
} from '../types.js';
import { buildCommitments, depositAmount } from '../build-commitments.js';
import {
  MAX_DEADLINE_SEC,
  commitmentRefusal,
  malformedPrehash,
  requireCommitment,
} from '../commitment-permit.js';
import { DETAIL_DEADLINE_RANGE, parseHash32 } from '../commitment-rules.js';
import type { CommitmentExpectation } from '../commitment-rules.js';
import {
  bindStellarDeposit,
  readStellarDepositForVerify,
  readStellarRecord,
  stellarDelegateKey,
  stellarEscrowDomain,
  STELLAR_DIGEST,
  STELLAR_SIGNATURE,
} from '../commitment-stellar.js';
import { verifyEd25519Strict } from '../commitment-solana.js';
import {
  assertToken,
  assertPermitAmount,
  assertWitnessRoles,
  parseSourceAsset,
  sameAddress,
} from '../utils.js';
import { DelegateUnverifiedError, RecoveryFailedError, SignerMismatchError } from '../errors.js';

/** A plain decimal unsigned integer: no sign, prefix, space or leading zero. */
const DECIMAL_UINT = /^(?:0|[1-9][0-9]*)$/;

/** Stellar addresses are canonical upper-case strkeys, compared exactly. */
const idAddr = (a: string) => a;

/**
 * Seconds `issued_at` is back-dated from the local clock when the caller supplies none. The escrow
 * requires `issued_at <= ledger time`; a local clock ahead of the ledger would otherwise revert.
 */
export const STELLAR_ISSUED_AT_SKEW_SECS = 30;

/** Validity of a deposit built with no explicit deadline, within the escrow's 24 hour bound. */
export const STELLAR_DEFAULT_VALIDITY_SECS = 3600;

function stellarDomainFor(network: string, escrow: string): EscrowDomain {
  const domain = stellarEscrowDomain(network, escrow);
  if (typeof domain === 'string') throw new Error(`sender_auth: Stellar source: ${domain}`);
  return domain;
}

/**
 * The deposit digest of a prehash, hashed with the shared Stellar escrow encoder after the strict
 * record reader the verifier uses has accepted every member, so a builder never signs a record the
 * verifier would refuse.
 */
function hashDeposit(prehash: StellarDepositPrehash, domain: EscrowDomain): string {
  const rec = readStellarRecord({ ...prehash });
  if (typeof rec === 'string') {
    throw new Error(`sender_auth: Stellar deposit is not usable: ${rec}`);
  }
  return hexlify(computeDepositHash(rec.params, domain));
}

/**
 * Refuses a Stellar message that is not the deposit digest of its own `message_prehash`, before any
 * key signs it. `stellarAdapter.sign` signs the 32 bytes it is given, and an ed25519 signature over
 * 32 bytes is also how a Stellar transaction is signed (over the transaction's hash), so a requester
 * that sets `message` to a transaction hash would otherwise get a transaction signature from the
 * payer's key. A digest rebuilt from the prehash, the network and the escrow cannot be a transaction
 * hash, so a message that equals it is a deposit and nothing else.
 *
 * The escrow only has to be the one the request names: the check does not decide whether that escrow
 * is trustworthy (`verifyPaymentRequest` binds it to the payer's own configuration), only that the
 * bytes are a deposit digest for it. The adapter's `sign` cannot run this itself because it is given
 * the message and no network or escrow, so every entry point that holds a request runs it first.
 *
 * @throws If `message` is not a 32-byte digest, `message_prehash` is missing or is not a usable
 * Stellar deposit record, or the digest of that record under `network` and `escrowContract` differs
 * from `message`.
 */
export function assertStellarSignable(
  signed: SignedMessageInput,
  network: string,
  escrowContract: string | undefined,
): void {
  if (typeof signed.message !== 'string' || !STELLAR_DIGEST.test(signed.message)) {
    throw new Error('sender_auth: message must be the 0x-prefixed 32-byte deposit digest');
  }
  if (typeof signed.message_prehash !== 'string' || signed.message_prehash === '') {
    throw new Error(
      'sender_auth: a Stellar message is signed only with its message_prehash, which the deposit digest is rebuilt from',
    );
  }
  let prehash: unknown;
  try {
    prehash = JSON.parse(signed.message_prehash);
  } catch {
    throw new Error('sender_auth: message_prehash is not valid JSON');
  }
  if (typeof prehash !== 'object' || prehash === null || Array.isArray(prehash)) {
    throw new Error('sender_auth: message_prehash must be a JSON object');
  }
  const domain = stellarDomainFor(network, escrowContract ?? '');
  const digest = hashDeposit(prehash as StellarDepositPrehash, domain);
  if (digest.toLowerCase() !== signed.message.toLowerCase()) {
    throw new Error(
      `sender_auth: message_prehash implies deposit digest ${digest} but message is ${signed.message}: refusing to sign bytes that are not the deposit`,
    );
  }
}

// Stellar ed25519 deposit sender_auth adapter. Mirrors the Go stellarAdapter. The payer authorises
// each deposit with an offchain ed25519 signature by its delegate signer over the escrow's deposit
// digest; the delegate itself is registered once on chain (`create_delegate`, plus a SEP-41
// `approve` to the escrow), which is outside this adapter.
export const stellarAdapter: ChainAdapter = {
  async buildAuthMessage(params): Promise<AuthMessageResult> {
    const {
      sourceAsset,
      depositor,
      requestId,
      sourceDefaults,
      paymentRequestJSON,
      nonce,
      issuedAt: suppliedIssuedAt,
      deadline: suppliedDeadline,
      delegateEpoch,
    } = params;
    if (paymentRequestJSON === undefined && !requestId) {
      throw new Error('sender_auth: request_id is required');
    }
    const { network, asset: token } = parseSourceAsset(sourceAsset);
    const domain = stellarDomainFor(network, sourceDefaults.escrowContract);

    // Required: the digest commits to the delegate record's epoch, which is on-chain state. Guessing 1
    // would sign a deposit the escrow voids whenever the payer has ever re-created the delegate.
    if (
      delegateEpoch === undefined ||
      !DECIMAL_UINT.test(String(delegateEpoch)) ||
      BigInt(delegateEpoch) < 1n ||
      BigInt(delegateEpoch) >= 1n << 64n
    ) {
      throw new Error(
        "sender_auth: a Stellar deposit needs delegateEpoch, the epoch of the payer's delegate record (get_delegate), as an integer from 1 to 2^64-1",
      );
    }

    // The nonce is an unordered per-depositor u64 the escrow never reuses. A caller that supplies
    // none gets a random one; a supplied one must fit u64, which would otherwise fail on chain after
    // the payer has signed.
    if (typeof nonce === 'string' && !DECIMAL_UINT.test(nonce)) {
      throw new Error('sender_auth: Stellar nonce must be a decimal integer string');
    }
    const depositNonce = nonce !== undefined ? BigInt(nonce) : randomU64();
    if (depositNonce < 0n || depositNonce >= 1n << 64n) {
      throw new Error(
        'sender_auth: Stellar nonce must fit an unsigned 64-bit integer (0 <= nonce < 2^64)',
      );
    }
    const issuedAt =
      suppliedIssuedAt !== undefined
        ? BigInt(suppliedIssuedAt)
        : BigInt(Math.floor(Date.now() / 1000) - STELLAR_ISSUED_AT_SKEW_SECS);
    const deadline =
      suppliedDeadline !== undefined
        ? BigInt(suppliedDeadline)
        : issuedAt + BigInt(STELLAR_DEFAULT_VALIDITY_SECS);
    if (issuedAt < 0n || deadline <= issuedAt) {
      throw new Error('sender_auth: Stellar deadline must be after issued_at');
    }
    if (deadline - issuedAt > MAX_DEPOSIT_VALIDITY_SECS) {
      throw new Error(
        `sender_auth: Stellar deposit validity ${deadline - issuedAt}s exceeds the escrow's ${MAX_DEPOSIT_VALIDITY_SECS}s bound`,
      );
    }

    // BigInt() would read "0x10", "0b1", " 5", "+5" and "01250000" as numbers; the amount is signed
    // exactly as parsed, so only a plain decimal string is accepted, as the verifier and Go read it.
    // It is the chosen quote's source amount when one is set, else the request's maximum.
    // An empty maximum with no quote reads as an invalid amount, as the Go builder reports it.
    const hasQuote = params.quoteSourceAmount !== undefined && params.quoteSourceAmount !== '';
    const { field: amountField, amount: maxAmount } = hasQuote
      ? depositAmount(params)
      : { field: 'maxSourceAmount' as const, amount: params.maxSourceAmount };
    if (typeof maxAmount !== 'string' || !DECIMAL_UINT.test(maxAmount)) {
      throw new Error(`sender_auth: invalid ${amountField} ${JSON.stringify(maxAmount)}`);
    }
    const commitments = buildCommitments(params, sameAddress);
    const prehash: StellarDepositPrehash = {
      deposit_request_hash: commitments.depositRequestHash,
      destination: commitments.destination,
      depositor,
      token,
      epoch: BigInt(delegateEpoch).toString(),
      amount: maxAmount,
      reserver: sourceDefaults.quoteSelector,
      releaser: sourceDefaults.fulfillmentVerifierAccount,
      nonce: depositNonce.toString(),
      issued_at: issuedAt.toString(),
      deadline: deadline.toString(),
    };
    // Hashing validates every member (strkeys, ranges, non-zero), so an unusable deposit is refused
    // here, before the payer signs, rather than reverting on chain.
    return {
      messageScheme: 'STELLAR',
      messageHash: hashDeposit(prehash, domain),
      messagePrehash: JSON.stringify(prehash),
    };
  },

  async sign(signedMessage: SignedMessageInput, privateKey: string): Promise<string> {
    if (typeof signedMessage.message !== 'string' || !STELLAR_DIGEST.test(signedMessage.message)) {
      throw new Error('sender_auth: message must be the 0x-prefixed 32-byte deposit digest');
    }
    const sig = nacl.sign.detached(
      getBytes(signedMessage.message),
      secretKeyFromPrivate(privateKey),
    );
    return '0x' + Buffer.from(sig).toString('hex');
  },

  deriveDelegateSigner(privateKey: string): string {
    return Pubkey.fromBytes(
      nacl.sign.keyPair.fromSecretKey(secretKeyFromPrivate(privateKey)).publicKey,
    ).toString();
  },

  /**
   * Verifies the signature against `payload.delegate_signer` and returns `source.account` when that
   * key is `source.account` (the payer's own key registered as its delegate). A signature that
   * verifies under any other key throws `DelegateUnverifiedError`: the requester named that key, and
   * whether it is registered for the depositor is on-chain state (`get_delegate` for the depositor
   * and token) that no offline check reads, so it is not shown to be the depositor's signer. A bad
   * signature throws `SignerMismatchError`.
   */
  recoverSigner(signed: SignedMessageInput, source: SourceRef): string {
    const key = stellarDelegateKey(signed.payload);
    if (typeof key === 'string') throw new RecoveryFailedError(`sender_auth: ${key}`);
    if (typeof signed.message !== 'string' || !STELLAR_DIGEST.test(signed.message)) {
      throw new RecoveryFailedError(
        'sender_auth: message must be the 0x-prefixed 32-byte deposit digest',
      );
    }
    if (typeof signed.signature !== 'string' || !STELLAR_SIGNATURE.test(signed.signature)) {
      throw new RecoveryFailedError('sender_auth: signature must be 0x-prefixed 64-byte hex');
    }
    if (!verifyEd25519Strict(key, getBytes(signed.message), getBytes(signed.signature))) {
      throw new SignerMismatchError('sender_auth: ed25519 verification failed');
    }
    const delegate = Pubkey.fromBytes(key).toString();
    if (delegate !== source.account) {
      throw new DelegateUnverifiedError(
        `sender_auth: the delegate signer is not source.account and is not verified as registered for it: delegate_signer ${delegate}`,
      );
    }
    return source.account;
  },

  recoverAndVerify(
    signed: SignedMessageInput,
    source: SourceRef,
    commitment: CommitmentExpectation,
    expected: VerifyExpectations,
  ): VerifiedSenderAuth {
    // The network is the payment's own source chain; the escrow is the verifier's configuration.
    const read = readStellarDepositForVerify(signed, source.network, expected.escrowContract, {
      reserver: expected.reserver,
      releaser: expected.releaser,
    });
    const refusal = bindStellarDeposit(read.domain, read.record, signed, source.account);
    if (refusal !== undefined) throw commitmentRefusal('stellar', refusal.outcome, refusal.detail);
    const f = read.record.fields;
    const destination = read.destination;
    const prehash = {
      depositRequestHash: read.hashText,
      depositor: f['depositor']!,
      token: f['token']!,
      amount: f['amount']!,
      reserver: f['reserver']!,
      releaser: f['releaser']!,
      deadline: f['deadline']!,
    };
    if (BigInt(prehash.deadline) > BigInt(MAX_DEADLINE_SEC)) {
      throw malformedPrehash('stellar', 'prehash_mismatch', DETAIL_DEADLINE_RANGE);
    }
    const deadlineSec = Number(prehash.deadline);
    // No freshness check here: the escrow's ledger-time window and nonce bitmap are the authority.
    assertToken(prehash.token, source.asset, idAddr);
    assertPermitAmount('stellar', prehash.amount, expected);
    // Both roles are required (checked in readStellarDepositForVerify), so unlike EVM and Solana the
    // comparison is never skipped.
    assertWitnessRoles(
      prehash.reserver,
      prehash.releaser,
      expected.reserver!,
      expected.releaser!,
      idAddr,
    );
    const result = requireCommitment(
      'stellar',
      destination,
      prehash.depositRequestHash,
      parseHash32(prehash.depositRequestHash)!,
      commitment,
    );
    // Last, so every other refusal keeps its own outcome: the signature, the record and the
    // commitment all held, and the signer is still only the requester's word for the depositor.
    const delegateSigner = Pubkey.fromBytes(
      stellarDelegateKey(signed.payload) as Uint8Array,
    ).toString();
    if (delegateSigner !== source.account) {
      throw new DelegateUnverifiedError(
        `sender_auth: the delegate signer is not source.account and is not verified as registered for it: delegate_signer ${delegateSigner}`,
      );
    }
    return {
      amount: prehash.amount,
      deadlineSec,
      permit: {
        scheme: 'STELLAR',
        token: prehash.token,
        amount: prehash.amount,
        deadlineSec,
        reserver: prehash.reserver,
        releaser: prehash.releaser,
        depositor: prehash.depositor,
        // Equal to the depositor here, and still not shown to be registered for it on chain.
        delegateSigner,
        delegateOnchainUnverified: true,
        delegateEpoch: f['epoch']!,
        destination,
        depositRequestHash: prehash.depositRequestHash,
      },
      commitment: { ...result, scheme: 'STELLAR' },
    };
  },
};

function randomU64(): bigint {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).readBigUInt64BE();
}

/**
 * Resolve a 64-byte Ed25519 secret key from the supported encodings: a 64-char hex 32-byte seed.
 * Stellar's own S... secret strkey is not accepted here: the caller decodes it, so a secret never
 * passes through a string this package parses or could echo.
 */
function secretKeyFromPrivate(privateKey: string): Uint8Array {
  const hex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'Invalid Stellar private key: expected a 32-byte ed25519 seed as 64 hex digits',
    );
  }
  return nacl.sign.keyPair.fromSeed(Uint8Array.from(Buffer.from(hex, 'hex'))).secretKey;
}
