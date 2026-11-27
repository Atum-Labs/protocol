// The reserve a deposit's reserver signs to pay a chosen quote: the escrow's reserve witness
// {depositId, quoteHash, settler, sourceAmount}. Its input is read with the rules
// `verifyReserveAuth` reads its expectations with, so a reserve built here, signed by the reserver,
// verifies against the same values.

import { Address, computeReserveHash } from '@atum-labs/stellar-escrow-encoding';
import { namespaceOf } from './chain-id.js';
import { stellarEscrowDomain } from './commitment-stellar.js';
import {
  readExpectations,
  readSolanaExpectations,
  reserveDigest,
  reserveTypedData,
  solanaReserveDigest,
  solanaReserveRecord,
} from './reserve-auth.js';
import type { ReserveAuth, ReserveAuthExpectations } from './reserve-auth.js';

/** What the reserve says: `verifyReserveAuth`'s expectations without the reserver. */
export type ReserveMessageInput = Omit<ReserveAuthExpectations, 'reserver'>;

/** A reserve_auth before the reserver signs it. */
export type ReserveMessage = Omit<ReserveAuth, 'signature'> & { message_prehash: string };

/**
 * Builds the reserve the deposit's reserver signs. On EVM and Tron, `message_prehash` is the reserve
 * typed data as JSON and `message` its EIP-712 (TIP-712 on Tron) digest, so any signer that signs
 * typed data after checking it hashes to `message` can sign it. Tron addresses may be base58 or
 * 41-prefixed hex; the typed data carries their 20-byte hex form. On Solana, `message` is the
 * escrow's reserve hash, which the reserver signs with ed25519 as bytes, and `message_prehash` the
 * reserve record `{deposit_hash, recipient, quote_hash, source_amount}`; the escrow's signature
 * domain comes from `svmSignatureClusterId` and `svmSignatureDomainVersion` (5 or later). On
 * Stellar, `message` is the escrow's reserve digest, which the reserver signs with ed25519 as bytes,
 * and `message_prehash` the reserve record `{deposit_id, quote_hash, settler, source_amount}`: the
 * hashes as 0x-prefixed hex, `settler` a `G...` or `C...` strkey and `source_amount` a decimal
 * string; the escrow's domain is its own contract id and the network's passphrase. Throws on
 * input the escrow could never accept.
 */
export function buildReserveMessage(input: ReserveMessageInput): ReserveMessage {
  const namespace = typeof input.network === 'string' ? namespaceOf(input.network) : '';
  if (namespace === 'solana') {
    const read = readSolanaExpectations(input, true);
    if ('detail' in read) throw new Error(`reserve_auth: ${read.detail}`);
    return {
      message: '0x' + Buffer.from(solanaReserveDigest(read.witness)).toString('hex'),
      message_prehash: JSON.stringify(solanaReserveRecord(read.witness)),
    };
  }
  if (namespace === 'stellar') return buildStellarReserveMessage(input);
  if (namespace !== 'eip155' && namespace !== 'tron') {
    throw new Error('reserve_auth: the network is not an eip155, tron, solana or stellar chain');
  }
  const read = readExpectations(namespace, input, true);
  if ('detail' in read) throw new Error(`reserve_auth: ${read.detail}`);
  return {
    message: reserveDigest(read.witness),
    message_prehash: JSON.stringify(reserveTypedData(read.witness)),
  };
}

const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;

/** The Stellar reserve: the escrow's reserve digest and the record it is computed from. */
function buildStellarReserveMessage(input: ReserveMessageInput): ReserveMessage {
  const fail = (detail: string): never => {
    throw new Error(`reserve_auth: ${detail}`);
  };
  const domain = stellarEscrowDomain(input.network, input.escrowContract);
  if (typeof domain === 'string') return fail(domain);
  const hash = (name: string, value: unknown): string => {
    if (typeof value !== 'string' || !HASH32.test(value) || /^0x0{64}$/.test(value)) {
      return fail(`the ${name} is not a non-zero 0x-prefixed 32-byte hex value`);
    }
    return value.toLowerCase();
  };
  const depositId = hash('depositId', input.depositId);
  const quoteHash = hash('quoteHash', input.quoteHash);
  let settler: Address;
  try {
    settler = Address.fromStrkey(input.settler);
  } catch {
    return fail('the settler is not a Stellar G... or C... address');
  }
  if (settler.equals(Address.contract(domain.contractId))) {
    return fail('the Stellar settler cannot be the escrow itself');
  }
  if (typeof input.sourceAmount !== 'string' || !POSITIVE_DECIMAL.test(input.sourceAmount)) {
    return fail('the sourceAmount is not a positive decimal integer string');
  }
  const sourceAmount = BigInt(input.sourceAmount);
  let digest: Uint8Array;
  try {
    digest = computeReserveHash(
      {
        depositId: Buffer.from(depositId.slice(2), 'hex'),
        quoteHash: Buffer.from(quoteHash.slice(2), 'hex'),
        settler,
        sourceAmount,
      },
      domain,
    );
  } catch (e) {
    // The encoder's own bounds, such as an amount above i128.
    return fail(e instanceof Error ? e.message : 'the reserve is not encodable');
  }
  return {
    message: '0x' + Buffer.from(digest).toString('hex'),
    message_prehash: JSON.stringify({
      deposit_id: depositId,
      quote_hash: quoteHash,
      settler: settler.toString(),
      source_amount: sourceAmount.toString(),
    }),
  };
}
