import { buildEscrowDestination, deriveDepositRequestHash } from './destination.js';
import { readAmount, readDepositRequest, type DepositTerms } from './deposit-request-v2.js';
import type { BuildAuthMessageParams } from './types.js';
import { POSITIVE_DECIMAL_UINT } from './utils.js';

/** The params `buildCommitments` reads. */
type CommitmentParams = Pick<
  BuildAuthMessageParams,
  | 'sourceAsset'
  | 'depositor'
  | 'maxSourceAmount'
  | 'quoteSourceAmount'
  | 'sourceDefaults'
  | 'requestId'
  | 'destinationAsset'
  | 'destinationAccount'
  | 'paymentRequestJSON'
  | 'depositRequestHashVersion'
>;

/**
 * The amount the permit authorizes and the param it came from: `quoteSourceAmount` when it is set,
 * else `maxSourceAmount`. Mirrors the Go `BuildParams.depositAmount`.
 */
export function depositAmount(
  params: Pick<BuildAuthMessageParams, 'maxSourceAmount' | 'quoteSourceAmount'>,
): { field: 'maxSourceAmount' | 'quoteSourceAmount'; amount: string } {
  const { maxSourceAmount, quoteSourceAmount } = params;
  if (quoteSourceAmount === undefined || quoteSourceAmount === '') {
    // The Go builder refuses it too; read as BigInt, '' would sign a permit for 0.
    if (maxSourceAmount === '') {
      throw new Error('sender_auth: set maxSourceAmount or quoteSourceAmount');
    }
    return { field: 'maxSourceAmount', amount: maxSourceAmount };
  }
  if (maxSourceAmount !== '') {
    throw new Error('sender_auth: set maxSourceAmount or quoteSourceAmount, not both');
  }
  if (typeof quoteSourceAmount !== 'string' || !POSITIVE_DECIMAL_UINT.test(quoteSourceAmount)) {
    throw new Error(
      `sender_auth: quoteSourceAmount ${JSON.stringify(quoteSourceAmount)} is not a decimal integer above zero`,
    );
  }
  return { field: 'quoteSourceAmount', amount: quoteSourceAmount };
}

/**
 * The two escrow commitments a deposit signs: its depositRequestHash and its destination, as
 * `buildEscrowDestination` composes it. With `paymentRequestJSON` they are read from the request
 * with `readDepositRequest`, and the params that drive the permit must agree with the request where
 * it commits them, compared with `sameAddr`, the source chain's address equality; without it, they
 * are read from `requestId` and the destination params. Mirrors the Go `BuildParams.commitments`.
 */
export function buildCommitments(
  params: CommitmentParams,
  sameAddr: (a: string, b: string) => boolean,
): { depositRequestHash: string; destination: string } {
  const { requestId, destinationAsset, destinationAccount, paymentRequestJSON } = params;
  const version: number = params.depositRequestHashVersion ?? 1;
  if (version !== 0 && version !== 1 && version !== 2) {
    throw new Error(`sender_auth: depositRequestHash version ${String(version)} is not 1 or 2`);
  }
  if (paymentRequestJSON === undefined) {
    if (version === 2) {
      throw new Error(
        'sender_auth: depositRequestHash version 2 needs the assembled payment request, which it hashes',
      );
    }
    return {
      depositRequestHash: deriveDepositRequestHash(requestId ?? ''),
      destination: buildEscrowDestination(destinationAsset ?? '', destinationAccount ?? ''),
    };
  }
  const read = readDepositRequest(paymentRequestJSON);
  // The deprecated params are not needed, but one that is set must agree with the request.
  if (requestId !== undefined && requestId !== '' && requestId !== read.terms.requestId) {
    throw new Error(
      `sender_auth: the request id param ${JSON.stringify(requestId)} is not the request's request_id ${JSON.stringify(read.terms.requestId)}`,
    );
  }
  if (!!destinationAsset || !!destinationAccount) {
    const stated = buildEscrowDestination(destinationAsset ?? '', destinationAccount ?? '');
    if (stated !== read.terms.destination) {
      throw new Error(
        `sender_auth: the destination params ${JSON.stringify(stated)} is not the request's destination ${JSON.stringify(read.terms.destination)}`,
      );
    }
  }
  agreeWith(params, read.terms, sameAddr);
  return {
    depositRequestHash: version === 2 ? read.depositRequestHashV2 : read.depositRequestHashV1,
    destination: read.terms.destination,
  };
}

/**
 * Refuses a param that drives the permit and is set, but names a different value than the one
 * `terms` commits, so v2 never commits terms the permit does not use. Mirrors the Go
 * `BuildParams.agreeWith`.
 */
function agreeWith(
  params: CommitmentParams,
  terms: DepositTerms,
  sameAddr: (a: string, b: string) => boolean,
): void {
  const { sourceAsset, depositor, maxSourceAmount, quoteSourceAmount, sourceDefaults } = params;
  if (sourceAsset !== '' && !sameAsset(sourceAsset, terms.sourceAssetIdentifier, sameAddr)) {
    throw new Error(
      `sender_auth: the source asset param ${JSON.stringify(sourceAsset)} is not the request's source asset_identifier ${JSON.stringify(terms.sourceAssetIdentifier)}`,
    );
  }
  if (!!depositor && !sameAddr(depositor, terms.sourceAccount)) {
    throw new Error(
      `sender_auth: the depositor param ${JSON.stringify(depositor)} is not the request's source account ${JSON.stringify(terms.sourceAccount)}`,
    );
  }
  // terms commits the amount as readAmount reads it, and nothing when the request omits it. An
  // amount readAmount refuses reads as a Problem, which no committed amount is.
  if (
    maxSourceAmount !== '' &&
    terms.maxSourceAmount !== undefined &&
    readAmount(maxSourceAmount, 'max_source_amount') !== terms.maxSourceAmount
  ) {
    throw new Error(
      `sender_auth: the max source amount param ${JSON.stringify(maxSourceAmount)} is not the request's max_source_amount ${JSON.stringify(terms.maxSourceAmount)}`,
    );
  }
  // A quote is paid at its own amount, which the request's cap bounds.
  if (
    quoteSourceAmount !== undefined &&
    quoteSourceAmount !== '' &&
    terms.maxSourceAmount !== undefined &&
    !(
      POSITIVE_DECIMAL_UINT.test(quoteSourceAmount) &&
      BigInt(quoteSourceAmount) <= BigInt(terms.maxSourceAmount)
    )
  ) {
    throw new Error(
      `sender_auth: the quote source amount param ${JSON.stringify(quoteSourceAmount)} is above the request's max_source_amount ${JSON.stringify(terms.maxSourceAmount)}`,
    );
  }
  const { escrowContract, quoteSelector, fulfillmentVerifierAccount } = sourceDefaults;
  if (!!escrowContract && !sameAddr(escrowContract, terms.escrowContractAddress)) {
    throw new Error(
      `sender_auth: the escrow contract default ${JSON.stringify(escrowContract)} is not the request's escrow_contract_address ${JSON.stringify(terms.escrowContractAddress)}`,
    );
  }
  // The witness reserver and releaser.
  if (
    !!quoteSelector &&
    terms.quoteSelector !== undefined &&
    !sameAddr(quoteSelector, terms.quoteSelector)
  ) {
    throw new Error(
      `sender_auth: the quote selector default ${JSON.stringify(quoteSelector)} is not the request's quote_selector ${JSON.stringify(terms.quoteSelector)}`,
    );
  }
  if (
    !!fulfillmentVerifierAccount &&
    !sameAddr(fulfillmentVerifierAccount, terms.fulfillmentVerifierAccount)
  ) {
    throw new Error(
      `sender_auth: the fulfillment verifier default ${JSON.stringify(fulfillmentVerifierAccount)} is not the request's fulfillment_verifier account ${JSON.stringify(terms.fulfillmentVerifierAccount)}`,
    );
  }
}

/**
 * Asset identifier equality: the chain and asset namespace exactly, and the token address, after
 * the last `:`, with `sameAddr`. Mirrors the Go `sameAsset`.
 */
function sameAsset(a: string, b: string, sameAddr: (a: string, b: string) => boolean): boolean {
  const i = a.lastIndexOf(':');
  const j = b.lastIndexOf(':');
  if (i < 0 || j < 0) return a === b;
  return a.slice(0, i) === b.slice(0, j) && sameAddr(a.slice(i + 1), b.slice(j + 1));
}
