import { hexlify, getBytes } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  computeDepositHashV2,
  Pubkey,
  generateNonce,
  type EscrowDomain,
} from '@atum-labs/solana-escrow-encoding';

import type {
  ChainAdapter,
  AuthMessageResult,
  SolanaDepositPrehashV2,
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
import type { CommitmentExpectation, SolanaDomain } from '../commitment-rules.js';
import {
  bindSolanaDeposit,
  solanaDelegateIs,
  readSolanaDepositForVerify,
  SOLANA_BASE58,
  SOLANA_DIGEST,
  SOLANA_SIGNATURE,
  SVM_DESTINATION_COMMITMENT_VERSION,
  verifyEd25519Strict,
} from '../commitment-solana.js';
import {
  assertToken,
  assertPermitAmount,
  assertWitnessRoles,
  assertRolePairComplete,
  REPLAY_HORIZON_SECS,
  SOLANA_REPLAY_SLOTS,
  parseSourceAsset,
  sameAddress,
} from '../utils.js';
import { RecoveryFailedError, SignerMismatchError } from '../errors.js';
import { clusterIdFromName } from '../chain-id.js';

/** Solana addresses are case-sensitive base58 — no normalization. */
const idAddr = (a: string) => a;

/** The domain >= 4 deposit hash: the deposit fields plus keccak256(destination) after the request hash. */
function hashDepositV2(prehash: SolanaDepositPrehashV2, domain: EscrowDomain): string {
  return hexlify(
    computeDepositHashV2(
      {
        depositRequestHash: getBytes(prehash.deposit_request_hash),
        depositor: Pubkey.fromBase58(prehash.depositor),
        mint: Pubkey.fromBase58(prehash.mint),
        amount: BigInt(prehash.amount),
        reserver: Pubkey.fromBase58(prehash.reserver),
        releaser: Pubkey.fromBase58(prehash.releaser),
        nonce: BigInt(prehash.nonce),
        issuedAt: BigInt(prehash.issued_at),
        deadline: BigInt(prehash.deadline),
      },
      // Plaintext, NOT pre-hashed: the encoder hashes it, and hashing an already-hashed
      // destination yields a well-formed commitment no on-chain state can satisfy.
      prehash.destination,
      domain,
    ),
  );
}

function domainFrom(defaults: {
  svmSignatureClusterId?: string;
  svmSignatureDomainVersion?: number;
  escrowContract?: string;
}): EscrowDomain {
  if (!defaults.escrowContract) {
    throw new Error(
      'sender_auth: Solana source requires escrowContract (escrow program id) for the deposit-hash domain',
    );
  }
  if (!defaults.svmSignatureClusterId || defaults.svmSignatureDomainVersion == null) {
    throw new Error(
      "sender_auth: Solana source requires svmSignatureClusterId and svmSignatureDomainVersion (the escrow's signature domain)",
    );
  }
  return {
    clusterId: clusterIdFromName(defaults.svmSignatureClusterId),
    signatureDomainVersion: defaults.svmSignatureDomainVersion,
    programId: Pubkey.fromBase58(defaults.escrowContract),
  };
}

// Solana ed25519 deposit sender_auth adapter. Mirrors the Go solanaAdapter.
export const solanaAdapter: ChainAdapter = {
  async buildAuthMessage(params): Promise<AuthMessageResult> {
    const {
      sourceAsset,
      depositor,
      requestId,
      sourceDefaults,
      paymentRequestJSON,
      nonce,
      solanaClockReader,
    } = params;
    // request_id is the idempotency key and is hashed into payment_id below; reject an empty one
    // loudly (matching the deterministic-nonce seed) instead of hashing the empty string.
    if (paymentRequestJSON === undefined && !requestId) {
      throw new Error('sender_auth: request_id is required');
    }
    const { network: sourceChainId, asset: tokenMint } = parseSourceAsset(sourceAsset);
    const { amount } = depositAmount(params);

    // Honor a caller-supplied nonce (e.g. deterministicSolanaNonce); otherwise generate a random
    // valid replay-window nonce. A supplied nonce is validated here because both failures would
    // otherwise surface only on-chain, after the payer has signed: a value that does not fit the
    // 8-byte little-endian field, and a low byte in the reserved replay-slot range (slot =
    // nonce & 0xFF must be < 235). Bits 8..31 are ignored on-chain and the bucket uses the upper
    // 4 bytes, so those are not constrained.
    const depositNonce = nonce !== undefined ? BigInt(nonce) : generateNonce();
    if (nonce !== undefined) {
      if (depositNonce < 0n || depositNonce >= 1n << 64n) {
        throw new Error(
          'sender_auth: Solana nonce must fit an unsigned 64-bit integer (0 <= nonce < 2^64)',
        );
      }
      if ((depositNonce & 0xffn) >= SOLANA_REPLAY_SLOTS) {
        throw new Error(
          `sender_auth: Solana nonce low byte (replay slot = nonce & 0xFF = ${depositNonce & 0xffn}) must be < ${SOLANA_REPLAY_SLOTS}; slots ${SOLANA_REPLAY_SLOTS}-255 are reserved`,
        );
      }
    }
    // Ground issued_at in the injected cluster-clock reader; fall back to wall clock.
    const issuedAt = solanaClockReader
      ? await solanaClockReader(sourceChainId)
      : BigInt(Math.floor(Date.now() / 1000));
    const deadline = issuedAt + BigInt(REPLAY_HORIZON_SECS - 8); // 120s, safely within 128s window

    const domain = domainFrom(sourceDefaults);
    // The destination is committed from signature domain version 4, so a lower version is refused.
    if (domain.signatureDomainVersion < SVM_DESTINATION_COMMITMENT_VERSION) {
      throw new Error(
        `sender_auth: Solana signature domain version ${domain.signatureDomainVersion} commits no destination; version ${SVM_DESTINATION_COMMITMENT_VERSION} or later is required`,
      );
    }
    const commitments = buildCommitments(params, sameAddress);
    const prehash: SolanaDepositPrehashV2 = {
      deposit_request_hash: commitments.depositRequestHash,
      destination: commitments.destination,
      depositor,
      mint: tokenMint,
      amount: BigInt(amount).toString(),
      reserver: sourceDefaults.quoteSelector,
      releaser: sourceDefaults.fulfillmentVerifierAccount,
      nonce: depositNonce.toString(),
      issued_at: issuedAt.toString(),
      deadline: deadline.toString(),
    };
    return {
      messageScheme: 'SOLANA',
      messageHash: hashDepositV2(prehash, domain),
      messagePrehash: JSON.stringify(prehash),
    };
  },

  async sign(signedMessage: SignedMessageInput, privateKey: string): Promise<string> {
    const messageBytes = getBytes(signedMessage.message);
    const secretKey = secretKeyFromPrivate(privateKey);
    const sig = nacl.sign.detached(messageBytes, secretKey);
    return '0x' + Buffer.from(sig).toString('hex');
  },

  deriveDelegateSigner(privateKey: string): string {
    return bs58.encode(nacl.sign.keyPair.fromSecretKey(secretKeyFromPrivate(privateKey)).publicKey);
  },

  recoverSigner(signed: SignedMessageInput, source: SourceRef): string {
    // The ed25519 signer is source.account. A payload.delegate_signer, when present, must equal
    // it; when absent, source.account is the verifying key. ed25519 is not key-recoverable, so
    // encoding failures are recovery_failed and a clean but failing verify is signer_mismatch.
    if (!solanaDelegateIs(signed.payload, source.account)) {
      throw new SignerMismatchError('sender_auth: delegate_signer is not source.account');
    }
    let pub: Uint8Array | undefined;
    try {
      if (SOLANA_BASE58.test(source.account)) pub = bs58.decode(source.account);
    } catch {
      pub = undefined;
    }
    if (pub === undefined || pub.length !== 32) {
      throw new RecoveryFailedError(
        'sender_auth: source.account is not a valid base58 ed25519 pubkey',
      );
    }
    if (typeof signed.message !== 'string' || !SOLANA_DIGEST.test(signed.message)) {
      throw new RecoveryFailedError(
        'sender_auth: message must be the 0x-prefixed 32-byte deposit hash',
      );
    }
    if (typeof signed.signature !== 'string' || !SOLANA_SIGNATURE.test(signed.signature)) {
      throw new RecoveryFailedError('sender_auth: signature must be 0x-prefixed 64-byte hex');
    }
    if (!verifyEd25519Strict(pub, getBytes(signed.message), getBytes(signed.signature))) {
      throw new SignerMismatchError('sender_auth: ed25519 verification failed');
    }
    return source.account;
  },

  recoverAndVerify(
    signed: SignedMessageInput,
    source: SourceRef,
    commitment: CommitmentExpectation,
    expected: VerifyExpectations,
  ): VerifiedSenderAuth {
    // Read and bind the deposit with the same rules and outcomes as the commitment check: the
    // deposit hash is rebuilt with the verifier's escrow domain, must be the signed message, and the
    // ed25519 signature must verify against source.account (a delegate_signer, when present, must
    // be that same key).
    const read = readSolanaDepositForVerify(signed, solanaDomainOf(expected));
    const refusal = bindSolanaDeposit(read.domain, read.root, signed, source.account);
    if (refusal !== undefined) throw commitmentRefusal('solana', refusal.outcome, refusal.detail);
    const f = read.record.fields;
    const destination = read.destination;
    const prehash = {
      depositRequestHash: read.hashText,
      depositor: f['depositor']!,
      mint: f['mint']!,
      amount: f['amount']!,
      reserver: f['reserver']!,
      releaser: f['releaser']!,
      deadline: f['deadline']!,
    };
    if (BigInt(prehash.deadline) > BigInt(MAX_DEADLINE_SEC)) {
      throw malformedPrehash('solana', 'prehash_mismatch', DETAIL_DEADLINE_RANGE);
    }
    const deadlineSec = Number(prehash.deadline);
    // Universal binding. There is no freshness check on Solana: the escrow's on-chain
    // issued_at/nonce replay window is the authority.
    assertToken(prehash.mint, source.asset, idAddr);
    assertPermitAmount('solana', prehash.amount, expected);
    // Opt-in atum-escrow scheme fail-fast (Solana has no separate spender — the escrow is
    // bound via the deposit-hash domain above).
    assertRolePairComplete(expected.reserver, expected.releaser);
    if (expected.reserver !== undefined && expected.releaser !== undefined) {
      assertWitnessRoles(
        prehash.reserver,
        prehash.releaser,
        expected.reserver,
        expected.releaser,
        idAddr,
      );
    }
    const result = requireCommitment(
      'solana',
      destination,
      prehash.depositRequestHash,
      parseHash32(prehash.depositRequestHash)!,
      commitment,
    );

    return {
      amount: prehash.amount,
      deadlineSec,
      permit: {
        scheme: 'SOLANA',
        token: prehash.mint,
        amount: prehash.amount,
        deadlineSec,
        reserver: prehash.reserver,
        releaser: prehash.releaser,
        depositor: prehash.depositor,
        destination,
        depositRequestHash: prehash.depositRequestHash,
      },
      commitment: { ...result, scheme: 'SOLANA' },
    };
  },
};

/**
 * Resolve a 64-byte Ed25519 secret key from the supported encodings:
 *   - 64-char hex string: a 32-byte seed
 *   - base58 32 bytes: a seed
 *   - base58 64 bytes: a full secret key
 */
function secretKeyFromPrivate(privateKey: string): Uint8Array {
  if (/^[0-9a-fA-F]{64}$/.test(privateKey)) {
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      seed[i] = parseInt(privateKey.substring(i * 2, i * 2 + 2), 16);
    }
    return nacl.sign.keyPair.fromSeed(seed).secretKey;
  }
  const decoded = bs58.decode(privateKey);
  if (decoded.length === 64) return decoded;
  if (decoded.length === 32) return nacl.sign.keyPair.fromSeed(decoded).secretKey;
  throw new Error(
    `Invalid Solana private key length: expected 32 or 64 bytes, got ${decoded.length}`,
  );
}

/** The Solana escrow domain the expectations configure, or undefined when they carry none. */
function solanaDomainOf(expected: VerifyExpectations): SolanaDomain | undefined {
  if (expected.svmSignatureDomainVersion === undefined) return undefined;
  return {
    escrowProgramId: expected.escrowContract ?? '',
    clusterId: expected.svmSignatureClusterId ?? '',
    domainVersion: expected.svmSignatureDomainVersion,
  };
}
