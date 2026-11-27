// Builds and signs the body of POST /v1/payments/awards from the quote request the caller sent and
// the quote it chose. No network access: the caller resolves the chain defaults and, on Solana,
// the deposit's issued_at.

import {
  assertStellarSignable,
  buildReserveMessage,
  CommitmentError,
  deterministicPermitNonce,
  deterministicSolanaNonce,
  deterministicStellarNonce,
  getChainAdapter as getSenderAuthAdapter,
  POSITIVE_DECIMAL_UINT,
  verifyQuoteRequestBinding,
} from '@atum-labs/payment-request-sender-auth';
import type { ReserveMessageInput } from '@atum-labs/payment-request-sender-auth';
import { computePaymentIdV2 } from '@atum-labs/evm-escrow-encoding';
import {
  computePaymentId as computeTronPaymentId,
  normalizeAddress,
} from '@atum-labs/tvm-escrow-encoding';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  matchEscrowWitness,
  WitnessKind,
  type EscrowMessageForm,
  type EscrowWitnessMatch,
} from '@atum-labs/solana-escrow-encoding';
import { Address, ACCOUNT_ADDRESS } from '@atum-labs/stellar-escrow-encoding';
import { parseAssetIdentifier } from './asset-identifier';
import type { ChainDefaults } from './chain-adapters';
import type {
  AwardedQuote,
  AwardRequest,
  CreateQuoteRequest,
  Quote,
  SenderAuthMessageScheme,
  SignedMessage,
} from './generated/types.gen';
import { signReserveAuth } from './reserve-auth';
import { escrowSigningOf } from './escrow-signing';
import type { SenderSigner } from './signers';

const QUOTE_ID = /^0x[0-9a-fA-F]{64}$/;

/** What an award is built from, as checked before anything is fetched or signed. */
export interface AwardInputs {
  chainId: string;
  namespace: string;
  sourceAsset: string;
  depositor: string;
  /** The quote request's `quote_selector`, the account that signs the reserve. */
  selector: string;
  /** The quote's `source_amount`, which the permit authorizes and the reserve binds. */
  sourceAmount: string;
  settler: string;
}

/**
 * Checks that `quote` is a quote for `quoteRequest` that can still be awarded, as the gateway
 * checks a quote against the quote request it stored, and that a signer is on hand for the
 * reserve. Throws on the first problem.
 */
export function readAwardInputs(params: {
  quoteRequestId: string;
  quoteRequest: CreateQuoteRequest;
  quote: Quote | AwardedQuote;
  selectorSigner?: SenderSigner;
  now: number;
}): AwardInputs {
  const { quoteRequest, quote } = params;
  if (typeof params.quoteRequestId !== 'string' || params.quoteRequestId === '') {
    throw new Error('payment-gateway-client: quoteRequestId is required');
  }
  if (typeof quote.quote_id !== 'string' || !QUOTE_ID.test(quote.quote_id)) {
    throw new Error('payment-gateway-client: quote_id is not a 0x-prefixed 32-byte hex value');
  }
  const fq = quote.fulfillment_quote as Record<string, unknown> | null | undefined;
  if (typeof fq !== 'object' || fq === null) {
    throw new Error('payment-gateway-client: the quote has no fulfillment_quote object');
  }
  try {
    verifyQuoteRequestBinding(JSON.stringify(fq), JSON.stringify(quoteRequest));
  } catch (e) {
    if (!(e instanceof CommitmentError)) throw e;
    throw new Error(
      `payment-gateway-client: the quote is not for this quote request: ${e.result.detail}`,
      { cause: e },
    );
  }
  // As the gateway checks it: the settler copies source.account verbatim.
  const quotedSource = fq.source as { account?: unknown } | undefined;
  if (quotedSource?.account !== quoteRequest.source.account) {
    throw new Error(
      "payment-gateway-client: the quote's source.account is not the quote request's",
    );
  }
  const awardDeadline =
    typeof fq.award_deadline === 'string' ? Date.parse(fq.award_deadline) : Number.NaN;
  if (Number.isNaN(awardDeadline)) {
    throw new Error("payment-gateway-client: the quote's award_deadline is not a timestamp");
  }
  // The gateway replays a re-sent award even after the deadline.
  const awarded = 'awarded_payment_id' in quote && Boolean(quote.awarded_payment_id);
  if (!awarded && awardDeadline <= params.now) {
    throw new Error(
      `payment-gateway-client: the quote's award_deadline ${String(fq.award_deadline)} has passed`,
    );
  }
  if (typeof fq.source_amount !== 'string' || !POSITIVE_DECIMAL_UINT.test(fq.source_amount)) {
    throw new Error(
      "payment-gateway-client: the quote's source_amount is not a decimal integer above zero",
    );
  }
  if (typeof fq.settler_address !== 'string' || fq.settler_address === '') {
    throw new Error('payment-gateway-client: the quote has no settler_address');
  }

  const source = parseAssetIdentifier(quoteRequest.source.asset_identifier);
  const depositor = quoteRequest.source.account;
  const selector = quoteSelectorOf(quoteRequest);
  if (source.namespace === 'stellar') {
    // The reserver is a raw ed25519 key: the escrow checks the reserve signature against it and
    // never calls it as a contract.
    if (!isStellarAccount(selector)) {
      throw new Error(
        `payment-gateway-client: the quote_selector ${selector} is not a Stellar G... account: ` +
          'the escrow checks the reserve signature against its ed25519 key',
      );
    }
  }
  if (!params.selectorSigner && !sameAccount(source.namespace, selector, depositor)) {
    throw new Error(
      `payment-gateway-client: the quote request names quote_selector ${selector}, which signs the ` +
        'reserve: pass its signer as selectorSigner',
    );
  }
  return {
    chainId: source.chainId,
    namespace: source.namespace,
    sourceAsset: source.normalized,
    depositor,
    selector,
    sourceAmount: fq.source_amount,
    settler: fq.settler_address,
  };
}

/**
 * Builds and signs the award: the depositor's `sender_auth` for exactly the quote's
 * `source_amount`, naming the selector as reserver, then the selector's `reserve_auth` over the
 * deposit it derives. The deposit nonce derives from the award's `requestId`, so a rebuild for the
 * same award signs the same EVM or Tron permit.
 *
 * @returns the award body and the payment id derived from the signed deposit
 */
export async function signAward(params: {
  requestId: string;
  quoteRequestId: string;
  quoteRequest: CreateQuoteRequest;
  quote: Quote | AwardedQuote;
  inputs: AwardInputs;
  depositorSigner: SenderSigner;
  selectorSigner?: SenderSigner;
  /** The source chain's `/v1/defaults`: Permit2 address and Solana escrow domain. */
  chainDefaults: ChainDefaults;
  depositRequestHashVersion: 1 | 2;
  solanaIssuedAt?: bigint;
  /** Stellar-only: the deposit's `issued_at`, the latest closed ledger's close time. */
  stellarIssuedAt?: bigint;
  /** Stellar-only: the `epoch` of the payer's delegate record, which the deposit digest commits to. */
  resolvedDelegateEpoch?: bigint;
  /** Stellar-only: the registered signing key when a full delegate record is available. */
  stellarDelegateSigner?: string;
}): Promise<{ request: AwardRequest; paymentId: string }> {
  const { quoteRequest, inputs, chainDefaults } = params;
  const solana = inputs.namespace === 'solana';
  if (solana && params.solanaIssuedAt === undefined) {
    throw new Error('payment-gateway-client: a Solana deposit needs its issued_at resolved');
  }
  const stellar = inputs.namespace === 'stellar';
  if (stellar && params.stellarIssuedAt === undefined) {
    throw new Error('payment-gateway-client: a Stellar deposit needs its issued_at resolved');
  }
  if (stellar && params.resolvedDelegateEpoch === undefined) {
    throw new Error('payment-gateway-client: a Stellar deposit needs its delegate epoch resolved');
  }
  const identity = { requestId: params.requestId, depositor: inputs.depositor };
  const nonce = solana
    ? deterministicSolanaNonce(identity)
    : stellar
      ? deterministicStellarNonce(identity)
      : deterministicPermitNonce(identity);
  // As on POST /v1/payments: the permit outlives the fulfillment deadline by one second.
  const fulfillmentMs = Date.parse(quoteRequest.fulfillment_deadline);
  if (!solana && Number.isNaN(fulfillmentMs)) {
    throw new Error(
      "payment-gateway-client: the quote request's fulfillment_deadline is not a timestamp",
    );
  }

  // How the escrow the quote request names signs: its own domain version and message scheme when
  // /v1/defaults lists it, the chain's otherwise.
  const escrowSigning = escrowSigningOf(chainDefaults, quoteRequest.escrow_contract_address);
  const svmMessageScheme = solana ? escrowSigning.svmMessageScheme : '';
  // The roles come from the quote request, which the deposit commits; only what the body does not
  // carry comes from /v1/defaults.
  const sourceDefaults: ChainDefaults = {
    ...chainDefaults,
    svmSignatureDomainVersion: escrowSigning.svmSignatureDomainVersion,
    escrowContract: quoteRequest.escrow_contract_address,
    quoteSelector: inputs.selector,
    fulfillmentVerifierAccount: quoteRequest.fulfillment_verifier.account,
    fulfillmentVerifierEndpoint: quoteRequest.fulfillment_verifier.endpoint,
  };
  const issuedAt = params.solanaIssuedAt;
  const auth = await getSenderAuthAdapter(inputs.chainId).buildAuthMessage({
    sourceAsset: inputs.sourceAsset,
    depositor: inputs.depositor,
    maxSourceAmount: '',
    quoteSourceAmount: inputs.sourceAmount,
    sourceDefaults,
    paymentRequestJSON: JSON.stringify(quoteRequest),
    depositRequestHashVersion: params.depositRequestHashVersion,
    deadline: solana ? undefined : Math.floor(fulfillmentMs / 1000) + 1,
    nonce,
    ...(issuedAt !== undefined ? { solanaClockReader: async () => issuedAt } : {}),
    ...(stellar
      ? { issuedAt: params.stellarIssuedAt, delegateEpoch: params.resolvedDelegateEpoch }
      : {}),
  });

  const reserveInput: Omit<ReserveMessageInput, 'depositId'> = {
    network: inputs.chainId,
    escrowContract: quoteRequest.escrow_contract_address,
    quoteHash: params.quote.quote_id,
    settler: inputs.settler,
    sourceAmount: inputs.sourceAmount,
    svmSignatureClusterId: chainDefaults.svmSignatureClusterId,
    svmSignatureDomainVersion: escrowSigning.svmSignatureDomainVersion,
  };
  // The deposit id exists only once the depositor has signed, so the reserve's other inputs are
  // checked with a stand-in first: a quote the reserve refuses never costs a deposit signature.
  buildReserveMessage({ ...reserveInput, depositId: '0x' + '01'.repeat(32) });

  const unsigned: SignedMessage = {
    message: auth.messageHash,
    message_prehash: auth.messagePrehash,
    signature: '',
  };
  if (stellar) {
    // The same refusal signPaymentRequest makes: a Stellar key signs only the deposit digest of the
    // message's own prehash under this network and escrow, never bytes that are not that digest, and
    // a signer bound to another network is refused. The message is built here from the quote, not
    // taken from a requester, so this cannot fire on a correct build; it keeps the award path from
    // signing a Stellar message the shared guard would refuse should the build above ever change.
    assertStellarSignerNetwork(params.depositorSigner, inputs.chainId, 'depositorSigner');
    if (params.selectorSigner) {
      assertStellarSignerNetwork(params.selectorSigner, inputs.chainId, 'selectorSigner');
    }
    assertStellarSignable(unsigned, inputs.chainId, quoteRequest.escrow_contract_address);
  }
  const { signature, delegateSigner } = await params.depositorSigner.sign({
    ...unsigned,
    svmMessageScheme,
  });
  if (
    stellar &&
    params.stellarDelegateSigner !== undefined &&
    delegateSigner !== params.stellarDelegateSigner
  ) {
    throw new Error(
      `payment-gateway-client: the award signer did not return the registered Stellar delegate key ${params.stellarDelegateSigner}`,
    );
  }
  const deposit: SignedMessage = {
    ...unsigned,
    signature,
    ...(delegateSigner ? { payload: { delegate_signer: delegateSigner } } : {}),
  };
  let depositForm: EscrowMessageForm | undefined;
  if (solana) {
    depositForm = assertSolanaSigned(
      deposit,
      delegateSigner ?? inputs.depositor,
      WitnessKind.Deposit,
      svmMessageScheme,
      'depositorSigner',
    );
  }

  // The escrow's deposit id: over the permit signature and nonce on EVM and Tron, the signed
  // deposit hash on Solana and Stellar.
  const paymentId =
    inputs.namespace === 'eip155'
      ? computePaymentIdV2(inputs.depositor, signature, nonce.toString())
      : inputs.namespace === 'tron'
        ? computeTronPaymentId(inputs.depositor, signature, nonce.toString())
        : auth.messageHash.toLowerCase();

  const reserve = await signReserveAuth(
    { ...reserveInput, depositId: paymentId },
    params.selectorSigner ?? params.depositorSigner,
    { svmMessageScheme },
  );
  if (solana) {
    const reserveForm = assertSolanaSigned(
      reserve,
      inputs.selector,
      WitnessKind.Reserve,
      svmMessageScheme,
      params.selectorSigner ? 'selectorSigner' : 'depositorSigner',
    );
    assertSolanaWitnessesFit(depositForm, reserveForm);
  }
  // The escrow checks the reserve against the reserver the deposit names. A Stellar depositor signs
  // with its delegate key, which is not necessarily the selector's, so a reserve signed by the wrong
  // key is refused here instead of reverting the deposit on chain.
  if (stellar && !stellarReserveSignedBy(reserve, inputs.selector)) {
    throw new Error(
      `payment-gateway-client: the reserve was not signed by the quote_selector ${inputs.selector}: ` +
        'pass its signer as selectorSigner',
    );
  }

  return {
    paymentId,
    request: {
      request_id: params.requestId,
      quote_request_id: params.quoteRequestId,
      quote_id: params.quote.quote_id,
      sender_auth: {
        message_scheme: auth.messageScheme as SenderAuthMessageScheme,
        signed_messages: [deposit],
      },
      reserve_auth: reserve,
    },
  };
}

/**
 * Refuses a Solana signature the escrow would refuse: not by `account`, or not in a form the escrow's
 * message scheme accepts. A custom `SenderSigner` that ignores `svmMessageScheme` signs the raw hash,
 * which a text escrow (escrow-text-v1) refuses on chain after the award, so it fails here instead.
 */
function assertSolanaSigned(
  signed: { message: string; signature: string },
  account: string,
  kind: WitnessKind,
  scheme: string,
  which: string,
): EscrowMessageForm {
  let match: EscrowWitnessMatch | undefined;
  try {
    match = matchEscrowWitness(
      scheme,
      kind,
      Buffer.from(signed.message.replace(/^0x/, ''), 'hex'),
      bs58.decode(account),
      Buffer.from(signed.signature.replace(/^0x/, ''), 'hex'),
    );
  } catch {
    match = undefined;
  }
  if (match === undefined) {
    throw new Error(
      `payment-gateway-client: ${which} did not sign the ${kind === WitnessKind.Deposit ? 'deposit' : 'reserve'} ` +
        `as ${account} in a form this escrow accepts (${scheme === '' ? 'the raw hash' : scheme}): refusing to send the award`,
    );
  }
  return match.form;
}

/**
 * Refuses a deposit and a reserve both signed as v0 off-chain messages (a Ledger signs that form):
 * the settler's deposit and reserve transaction then measures 1245 bytes with the cluster's lookup
 * table, over Solana's 1232 byte packet, so it could never be sent after the award. Every other pair
 * of forms fits (a v1 or bare form on either side saves at least 35 bytes).
 */
export function assertSolanaWitnessesFit(
  depositForm: EscrowMessageForm | undefined,
  reserveForm: EscrowMessageForm,
): void {
  if (depositForm === 'v0' && reserveForm === 'v0') {
    throw new Error(
      'payment-gateway-client: the deposit and the reserve are both signed as v0 off-chain messages, ' +
        'which together do not fit in one Solana transaction: sign the reserve bare or as a v1 off-chain message: refusing to send the award',
    );
  }
}

/**
 * Refuses a signer bound to a network other than the quote's source network. A signer with no
 * `network` (a custom `SenderSigner`) is not bound and is admitted: the digest check, not the
 * signer's label, is what keeps a Stellar key from signing arbitrary bytes.
 */
function assertStellarSignerNetwork(signer: SenderSigner, chainId: string, which: string): void {
  if (signer.network !== undefined && signer.network.toLowerCase() !== chainId.toLowerCase()) {
    throw new Error(
      `payment-gateway-client: ${which} is for ${signer.network} but the quote request's source is ${chainId}: refusing to sign`,
    );
  }
}

/** The quote request's `quote_selector`, the account that signs the reserve; throws when it names none. */
export function quoteSelectorOf(quoteRequest: CreateQuoteRequest): string {
  // Checked as unknown: a quote request parsed from JSON can carry any value here.
  const selector: unknown = quoteRequest.quote_selector;
  if (typeof selector !== 'string' || selector.trim() === '') {
    throw new Error(
      'payment-gateway-client: the quote request names no quote_selector, the account that signs ' +
        'the reserve: name source.account, or the address that will sign it',
    );
  }
  return selector;
}

/** Whether two accounts of a source chain are the same: hex case-insensitively, base58 exactly. */
export function sameAccount(namespace: string, a: string, b: string): boolean {
  if (namespace === 'eip155') return a.toLowerCase() === b.toLowerCase();
  if (namespace === 'tron') {
    try {
      return normalizeAddress(a) === normalizeAddress(b);
    } catch {
      return a === b;
    }
  }
  return a === b;
}

function isStellarAccount(value: string): boolean {
  try {
    return Address.fromStrkey(value).type === ACCOUNT_ADDRESS;
  } catch {
    return false;
  }
}

/** Whether the reserve's ed25519 signature over its digest verifies under the `G...` selector's key. */
function stellarReserveSignedBy(
  reserve: { message: string; signature: string },
  selector: string,
): boolean {
  try {
    const key = Address.fromStrkey(selector).toBytes33().slice(1);
    return nacl.sign.detached.verify(
      Buffer.from(reserve.message.slice(2), 'hex'),
      Buffer.from(reserve.signature.slice(2), 'hex'),
      key,
    );
  } catch {
    return false;
  }
}
