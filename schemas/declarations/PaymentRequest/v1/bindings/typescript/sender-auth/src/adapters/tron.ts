import { Wallet } from 'ethers';
import {
  createTvmPermitWitnessTransferFromPrehashWithDestination,
  hashTvmPermitWitnessTransferFrom,
  normalizeAddress,
  type TvmPermitWitnessTransferFromWithDestinationParams,
} from '@atum-labs/tvm-escrow-encoding';

import type {
  ChainAdapter,
  AuthMessageResult,
  SignedMessageInput,
  SourceRef,
  VerifyExpectations,
  VerifiedSenderAuth,
} from '../types.js';
import type { CommitmentExpectation } from '../commitment-rules.js';
import {
  commitmentRefusal,
  permitSignerIs,
  readPermitForVerify,
  recoverEvmSigner,
  requireCommitment,
} from '../commitment-permit.js';
import { DETAIL_NO_TRON_PERMIT2, DETAIL_SIGNER_MISMATCH } from '../commitment-rules.js';
import {
  resolvePermitNonce,
  resolvePermitDeadline,
  sameAddress,
  assertToken,
  assertPermitAmount,
  assertFresh,
  assertSpender,
  assertWitnessRoles,
  assertRolePairComplete,
  nowSec,
  parseSourceAsset,
} from '../utils.js';
import { RecoveryFailedError, SignerMismatchError } from '../errors.js';
import { tronNumericChainId, resolveTronPermit2 } from '../chain-id.js';
import { buildCommitments, depositAmount } from '../build-commitments.js';

/**
 * Address equality for Tron, which spells an address in base58 or hex: both are compared in
 * `normalizeAddress`'s form, and an address it cannot read is compared as given. Mirrors the Go
 * `sameTronAddress`.
 */
function sameTronAddress(a: string, b: string): boolean {
  const canonical = (address: string): string => {
    try {
      return '0x' + normalizeAddress(address);
    } catch {
      return address;
    }
  };
  return sameAddress(canonical(a), canonical(b));
}

// Tron TIP-712 sender_auth adapter. Mirrors the Go tronAdapter. The message scheme stays
// EVM_PERMIT2 (Tron uses the same Permit2 wire format).
export const tronAdapter: ChainAdapter = {
  async buildAuthMessage(params): Promise<AuthMessageResult> {
    const { sourceAsset, sourceDefaults, deadline, nonce } = params;
    const { amount } = depositAmount(params);
    if (nonce === undefined) {
      throw new Error(
        'sender_auth: buildAuthMessage requires an explicit nonce — derive it deterministically from a stable request id (e.g. an order id) so retries reproduce the same permit; pass generatePermitNonce() only for genuinely one-shot builds',
      );
    }
    if (deadline === undefined) {
      throw new Error(
        "sender_auth: buildAuthMessage requires an explicit permit deadline (absolute Unix seconds) — the low-level builder does not default it; derive it from the payment's fulfillment/settlement deadline in the calling layer (pgc/mppx)",
      );
    }
    const { network: sourceChainId, asset: tokenAddress } = parseSourceAsset(sourceAsset);
    const permit2Address = sourceDefaults.permit2Contract ?? resolveTronPermit2(sourceChainId);

    const tvmParams: TvmPermitWitnessTransferFromWithDestinationParams = {
      chainId: tronNumericChainId(sourceChainId),
      permit2Address,
      tokenAddress,
      amount,
      spenderAddress: sourceDefaults.escrowContract,
      nonce: resolvePermitNonce(nonce),
      deadline: resolvePermitDeadline(deadline),
      reserverAddress: sourceDefaults.quoteSelector,
      releaserAddress: sourceDefaults.fulfillmentVerifierAccount,
      // Composed through the shared helpers.
      ...buildCommitments(params, sameTronAddress),
    };
    const messagePrehash = createTvmPermitWitnessTransferFromPrehashWithDestination(tvmParams);
    const messageHash = hashTvmPermitWitnessTransferFrom(messagePrehash);
    return {
      messageScheme: 'EVM_PERMIT2',
      messageHash,
      messagePrehash: JSON.stringify(messagePrehash),
    };
  },

  // Signs the TIP-712 typed data, not the bare digest, so a signer can inspect the fields it is
  // authorizing (Turnkey policies read `eth.eip_712.message[...]`).
  async sign(signedMessage: SignedMessageInput, privateKey: string): Promise<string> {
    if (!signedMessage.message_prehash) {
      throw new Error('Tron adapter sign(): signed_messages[i].message_prehash is required');
    }
    const prehash = JSON.parse(signedMessage.message_prehash);
    // Verifiers rebuild the permit from the prehash while `message` carries the digest, so a
    // producer supplying two different permits would have us sign one and advertise the other.
    // Both fields are caller-controlled, so require them to agree before signing.
    const prehashDigest = hashTvmPermitWitnessTransferFrom(prehash);
    if (prehashDigest.toLowerCase() !== signedMessage.message.toLowerCase()) {
      throw new Error(
        `Tron adapter sign(): message_prehash implies digest ${prehashDigest} but message is ${signedMessage.message}`,
      );
    }
    const wallet = new Wallet(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey);
    return wallet.signTypedData(prehash.domain, prehash.types, prehash.message);
  },

  recoverSigner(signed: SignedMessageInput, source: SourceRef): string {
    // Recover from the signed message's own digest, with no prehash parse. ethers rejects EIP-2
    // high-s during recovery. Compares in Tron's canonical hex form.
    let recovered: string;
    try {
      recovered = recoverEvmSigner(signed.message, signed.signature);
    } catch (e) {
      throw new RecoveryFailedError(
        `sender_auth: could not recover a signer: ${(e as Error).message}`,
      );
    }
    if (!sameAddress(recovered, normalizeAddress(source.account))) {
      throw new SignerMismatchError(`sender_auth: recovered ${recovered}, not source.account`);
    }
    return source.account;
  },

  recoverAndVerify(
    signed: SignedMessageInput,
    source: SourceRef,
    commitment: CommitmentExpectation,
    expected: VerifyExpectations,
  ): VerifiedSenderAuth {
    // The Permit2 the escrow uses comes from the verifier (or the pinned per-network address),
    // never from the client-supplied prehash.
    let permit2B58: string;
    try {
      permit2B58 = expected.permit2Contract ?? resolveTronPermit2(source.network);
    } catch {
      throw commitmentRefusal('tron', 'verifier_misconfigured', DETAIL_NO_TRON_PERMIT2);
    }
    let permit2: string;
    try {
      permit2 = normalizeAddress(permit2B58);
    } catch {
      throw new Error(
        `sender_auth: expected Permit2 contract ${JSON.stringify(permit2B58)} is not a Tron address`,
      );
    }
    const p = readPermitForVerify('tron', signed, source, permit2, commitment);
    if (!permitSignerIs('tron', signed, source.account)) {
      throw commitmentRefusal('tron', 'signer_mismatch', DETAIL_SIGNER_MISMATCH);
    }

    const f = p.fields;
    const amount = BigInt(f.amount).toString();
    const deadlineSec = Number(f.deadline);
    assertToken(f.token, source.asset, normalizeAddress);
    assertPermitAmount('tron', amount, expected);
    assertFresh(deadlineSec, expected.nowSec ?? nowSec());
    if (expected.escrowContract !== undefined) {
      assertSpender(f.spender, expected.escrowContract, normalizeAddress);
    }
    assertRolePairComplete(expected.reserver, expected.releaser);
    if (expected.reserver !== undefined && expected.releaser !== undefined) {
      assertWitnessRoles(
        f.reserver,
        f.releaser,
        expected.reserver,
        expected.releaser,
        normalizeAddress,
      );
    }
    const result = requireCommitment('tron', p.destination, p.hashText, p.hash, commitment);

    return {
      amount,
      deadlineSec,
      permit: {
        scheme: 'EVM_PERMIT2',
        token: f.token,
        amount,
        deadlineSec,
        reserver: f.reserver,
        releaser: f.releaser,
        spender: f.spender,
        destination: p.destination,
        depositRequestHash: p.hashText,
      },
      commitment: { ...result, scheme: 'EVM_PERMIT2' },
    };
  },
};
