import { Wallet } from 'ethers';
import {
  createPermitWitnessTransferFromPrehashWithDestination,
  hashPermitWitnessTransferFrom,
  PERMIT2_CONTRACT_ADDRESS,
} from '@atum-labs/evm-escrow-encoding';

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
import { DETAIL_SIGNER_MISMATCH } from '../commitment-rules.js';
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
import { buildCommitments, depositAmount } from '../build-commitments.js';
import { RecoveryFailedError, SignerMismatchError } from '../errors.js';
import { evmChainId } from '../chain-id.js';

// EVM Permit2 sender_auth adapter. Mirrors the Go evmAdapter.
export const evmAdapter: ChainAdapter = {
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
    // Shape first, so a malformed identifier names itself rather than failing inside a chain
    // library. Strict chain id next, matching recoverAndVerify below and the Go mirror:
    // `parseInt` reads `0x66eee` as 421614, so a hex reference would sign a Permit2 domain the
    // identifier does not name.
    const { network: sourceChainId, asset: tokenAddress } = parseSourceAsset(sourceAsset);
    const chainIdNum = evmChainId(sourceChainId);

    // Permit2 is the EIP-712 verifyingContract and is not guaranteed to be at the canonical
    // address, so prefer what the gateway published for this chain and fall back to the
    // canonical constant only when it published none.
    const permit2Contract = sourceDefaults.permit2Contract ?? PERMIT2_CONTRACT_ADDRESS;

    const permitParams = {
      chainId: chainIdNum,
      verifyingContract: permit2Contract,
      token: tokenAddress,
      amount,
      spender: sourceDefaults.escrowContract,
      nonce: resolvePermitNonce(nonce),
      deadline: resolvePermitDeadline(deadline),
      reserver: sourceDefaults.quoteSelector,
      releaser: sourceDefaults.fulfillmentVerifierAccount,
      // Composed through the shared helpers.
      ...buildCommitments(params, sameAddress),
    };
    const messagePrehash = createPermitWitnessTransferFromPrehashWithDestination(permitParams);
    const messageHash = hashPermitWitnessTransferFrom(messagePrehash);
    return {
      messageScheme: 'EVM_PERMIT2',
      messageHash,
      messagePrehash: JSON.stringify(messagePrehash),
    };
  },

  async sign(signedMessage: SignedMessageInput, privateKey: string): Promise<string> {
    if (!signedMessage.message_prehash) {
      throw new Error('EVM adapter sign(): signed_messages[i].message_prehash is required');
    }
    const prehash = JSON.parse(signedMessage.message_prehash);
    // Verifiers rebuild the permit from the prehash while `message` carries the digest, so a
    // producer supplying two different permits would have us sign one and advertise the other.
    // Both fields are caller-controlled, so require them to agree before signing.
    const prehashDigest = hashPermitWitnessTransferFrom(prehash);
    if (prehashDigest.toLowerCase() !== signedMessage.message.toLowerCase()) {
      throw new Error(
        `EVM adapter sign(): message_prehash implies digest ${prehashDigest} but message is ${signedMessage.message}`,
      );
    }
    const wallet = new Wallet(privateKey);
    return wallet.signTypedData(prehash.domain, prehash.types, prehash.message);
  },

  recoverSigner(signed: SignedMessageInput, source: SourceRef): string {
    // Recover from the signed message's own digest, with no prehash parse: the recover-only
    // primitive a multi-message verifier runs over every signed_messages[] entry, including
    // non-Permit2 setup approvals. ethers rejects EIP-2 high-s during recovery.
    let recovered: string;
    try {
      recovered = recoverEvmSigner(signed.message, signed.signature);
    } catch (e) {
      throw new RecoveryFailedError(
        `sender_auth: could not recover a signer: ${(e as Error).message}`,
      );
    }
    if (!sameAddress(recovered, source.account)) {
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
    // The Permit2 the escrow uses comes from the verifier, never from the client-supplied prehash.
    const permit2 = expected.permit2Contract ?? PERMIT2_CONTRACT_ADDRESS;
    if (!/^0x[0-9a-fA-F]{40}$/.test(permit2)) {
      throw new Error(
        `sender_auth: expected Permit2 contract ${JSON.stringify(permit2)} is not an address`,
      );
    }
    const p = readPermitForVerify('eip155', signed, source, permit2, commitment);
    if (!permitSignerIs('eip155', signed, source.account)) {
      throw commitmentRefusal('eip155', 'signer_mismatch', DETAIL_SIGNER_MISMATCH);
    }

    const f = p.fields;
    const amount = BigInt(f.amount).toString();
    const deadlineSec = Number(f.deadline);
    assertToken(f.token, source.asset, (a) => a);
    assertPermitAmount('eip155', amount, expected);
    assertFresh(deadlineSec, expected.nowSec ?? nowSec());
    if (expected.escrowContract !== undefined) {
      assertSpender(f.spender, expected.escrowContract, (a) => a);
    }
    assertRolePairComplete(expected.reserver, expected.releaser);
    if (expected.reserver !== undefined && expected.releaser !== undefined) {
      assertWitnessRoles(f.reserver, f.releaser, expected.reserver, expected.releaser, (a) => a);
    }
    // Recovery proves the commitment is authentic; this proves it is the payment's own.
    const result = requireCommitment('eip155', p.destination, p.hashText, p.hash, commitment);

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
