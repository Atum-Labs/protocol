/**
 * The verifier rows of the live policy matrix in test-policies.ts.
 *
 * Every witness is built in the form the verifier's Go backend sends: lowercase addresses, decimal
 * chain id, and the escrow's V3 ReleaseWitness / RefundWitness members. Each DENY case changes
 * exactly one thing from an ALLOW case, so a denial is attributable to that binding.
 *
 * Each EVM and Tron chain signs with its own configured releaser, since the verifier's keys are per
 * chain (one EVM chain can use a different key from the rest).
 */
import { ethers } from 'ethers';
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { TronWeb } from 'tronweb';

import { evmNumericChainId, toTronEvmHex, tronTip712ChainId } from '../src/admin';
import type { TurnkeyClient } from '../src/client';

export interface VerifierCase {
  name: string;
  expect: 'DENY' | 'ALLOW' | 'REJECTED' | 'REFUSED';
  run: () => Promise<unknown>;
}

export interface VerifierCaseInput {
  chains: Record<string, { kind: 'evm' | 'tron' | 'solana' | 'stellar'; chainId: string }>;
  verifierExtras?: {
    escrows?: Record<string, string[]>;
    releasers?: Record<string, string[]>;
  };
  /** Read at run time: the client is only built for a live run. */
  client: () => TurnkeyClient;
  solanaAddress?: string;
}

const WITNESS_FIELDS = [
  { name: 'depositId', type: 'bytes32' },
  { name: 'quoteHash', type: 'bytes32' },
  { name: 'depositRequestHash', type: 'bytes32' },
  { name: 'destinationHash', type: 'bytes32' },
  { name: 'depositor', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'feeAmount', type: 'uint256' },
  { name: 'reserver', type: 'address' },
  { name: 'releaser', type: 'address' },
  { name: 'settler', type: 'address' },
];

const DECOY = '0x' + 'de'.repeat(20);

interface WitnessOverrides {
  primaryType?: string;
  name?: string;
  version?: string;
  chainId?: number;
  verifyingContract?: string;
  releaser?: string;
}

function witnessPayload(
  primaryType: 'ReleaseWitness' | 'RefundWitness',
  chainId: number,
  escrow: string,
  releaser: string,
  o: WitnessOverrides = {},
): string {
  const type = o.primaryType ?? primaryType;
  return JSON.stringify({
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      [type]: WITNESS_FIELDS,
    },
    primaryType: type,
    domain: {
      name: o.name ?? 'Escrow',
      version: o.version ?? '3',
      chainId: o.chainId ?? chainId,
      verifyingContract: (o.verifyingContract ?? escrow).toLowerCase(),
    },
    message: {
      depositId: '0x' + '11'.repeat(32),
      quoteHash: '0x' + '22'.repeat(32),
      depositRequestHash: '0x' + '33'.repeat(32),
      destinationHash: '0x' + '44'.repeat(32),
      depositor: DECOY,
      token: DECOY,
      amount: '1',
      feeAmount: '0',
      reserver: DECOY,
      releaser: (o.releaser ?? releaser).toLowerCase(),
      settler: DECOY,
    },
  });
}

const VERDICT_FIELDS: Record<
  'FulfillmentVerdict' | 'DepositVerdict',
  { name: string; type: string }[]
> = {
  FulfillmentVerdict: [
    { name: 'domain', type: 'string' },
    { name: 'paymentId', type: 'bytes32' },
    { name: 'chainId', type: 'string' },
    { name: 'outcome', type: 'string' },
    { name: 'blockNumber', type: 'uint256' },
    { name: 'blockHash', type: 'bytes32' },
    { name: 'finalityPolicy', type: 'string' },
    { name: 'transactionHash', type: 'bytes32' },
    { name: 'fulfiller', type: 'address' },
  ],
  DepositVerdict: [
    { name: 'domain', type: 'string' },
    { name: 'paymentId', type: 'bytes32' },
    { name: 'chainId', type: 'string' },
    { name: 'escrowAddress', type: 'address' },
    { name: 'outcome', type: 'string' },
    { name: 'blockNumber', type: 'uint256' },
    { name: 'blockHash', type: 'bytes32' },
    { name: 'finalityPolicy', type: 'string' },
    { name: 'transactionHash', type: 'bytes32' },
  ],
};

/** A veri-fill verdict as its Go backend sends it: the Atum Verdict domain, which names no contract. */
function verdictPayload(
  primaryType: 'FulfillmentVerdict' | 'DepositVerdict',
  chainId: number,
  o: WitnessOverrides = {},
): string {
  const type = o.primaryType ?? primaryType;
  const domainFields = [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
  ];
  const domain = {
    name: o.name ?? 'Atum Verdict',
    version: o.version ?? '1',
    chainId: o.chainId ?? chainId,
  };
  return JSON.stringify({
    types: { EIP712Domain: domainFields, [type]: VERDICT_FIELDS[primaryType] },
    primaryType: type,
    domain,
    message: {
      domain: 'did:web:veri-fill.example',
      paymentId: '0x' + '55'.repeat(32),
      chainId: `eip155:${chainId}`,
      outcome: primaryType === 'DepositVerdict' ? 'held' : 'delivered',
      blockNumber: '1',
      blockHash: '0x' + '66'.repeat(32),
      finalityPolicy: 'confirmations:1',
      transactionHash: '0x' + '77'.repeat(32),
      ...(primaryType === 'DepositVerdict' ? { escrowAddress: DECOY } : { fulfiller: DECOY }),
    },
  });
}

export function verifierCases(input: VerifierCaseInput): VerifierCase[] {
  const cases: VerifierCase[] = [];
  const typed = (signWith: string, payload: string) => () =>
    input.client().signRawPayload({
      signWith,
      payload,
      encoding: 'PAYLOAD_ENCODING_EIP712',
      hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
    });

  let firstEvm: { signWith: string; chainId: number; escrow: string; releaser: string } | undefined;
  const refusalProbed = new Set<string>();

  for (const [key, chain] of Object.entries(input.chains)) {
    if (chain.kind !== 'evm' && chain.kind !== 'tron') continue;
    const escrows = input.verifierExtras?.escrows?.[key] ?? [];
    const releaserRaw = input.verifierExtras?.releasers?.[key]?.[0];
    if (escrows.length === 0 || !releaserRaw) {
      throw new Error(`verifierExtras is missing escrows or releasers for chain "${key}".`);
    }
    const isTron = chain.kind === 'tron';
    const escrowHexes = escrows.map((e) => (isTron ? toTronEvmHex(e) : e.toLowerCase()));
    const releaserHex = isTron ? toTronEvmHex(releaserRaw) : releaserRaw.toLowerCase();
    // Turnkey matches signWith case-sensitively: a Tron account by its base58 address, an EVM one
    // by its checksummed address.
    const signWith = isTron
      ? releaserRaw.startsWith('T')
        ? releaserRaw
        : TronWeb.address.fromHex('41' + releaserHex.slice(2))
      : ethers.getAddress(releaserHex);
    const chainId = isTron ? tronTip712ChainId(chain.chainId) : evmNumericChainId(chain.chainId);

    // One control per listed escrow: older deposits can still sit on any of them.
    for (const escrowHex of escrowHexes) {
      for (const pt of ['ReleaseWitness', 'RefundWitness'] as const) {
        cases.push({
          name: `verifier ${pt} on ${chain.chainId} escrow ${escrowHex} (positive control)`,
          expect: 'ALLOW',
          run: typed(signWith, witnessPayload(pt, chainId, escrowHex, releaserHex)),
        });
      }
    }
    if (!isTron) {
      for (const pt of ['FulfillmentVerdict', 'DepositVerdict'] as const) {
        cases.push({
          name: `verifier ${pt} on ${chain.chainId} (positive control)`,
          expect: 'ALLOW',
          run: typed(signWith, verdictPayload(pt, chainId)),
        });
      }
    }
    // Digest signing on the releaser itself. The ed25519 allow is scoped to the Solana account and
    // Turnkey refuses the pairing on secp256k1, so either refusal may come first.
    if (!refusalProbed.has(signWith)) {
      refusalProbed.add(signWith);
      cases.push({
        name: `verifier ${chain.chainId} releaser HEXADECIMAL + NOT_APPLICABLE (must be refused)`,
        expect: 'REFUSED',
        run: () =>
          input.client().signRawPayload({
            signWith,
            payload: '0x' + 'dd'.repeat(32),
            encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
            hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
          }),
      });
    }
    if (!isTron && !firstEvm) {
      firstEvm = { signWith, chainId, escrow: escrowHexes[0]!, releaser: releaserHex };
    }
  }

  if (firstEvm) {
    const { signWith, chainId, escrow, releaser } = firstEvm;
    const deny = (what: string, o: WitnessOverrides) =>
      cases.push({
        name: `verifier ReleaseWitness with ${what}`,
        expect: 'DENY',
        run: typed(signWith, witnessPayload('ReleaseWitness', chainId, escrow, releaser, o)),
      });
    deny('a foreign verifyingContract', { verifyingContract: DECOY });
    deny('the wrong chain id', { chainId: chainId + 1 });
    deny("domain version '2' (proves domain.version is enforced)", { version: '2' });
    deny("domain name 'Permit2'", { name: 'Permit2' });
    deny('a releaser that is not the verifier', { releaser: DECOY });
    deny("primaryType 'ReserveWitness' over the same members", { primaryType: 'ReserveWitness' });
    deny("primaryType 'FulfillmentVerdict' under the escrow domain", {
      primaryType: 'FulfillmentVerdict',
    });

    const denyVerdict = (what: string, o: WitnessOverrides) =>
      cases.push({
        name: `verifier FulfillmentVerdict with ${what}`,
        expect: 'DENY',
        run: typed(signWith, verdictPayload('FulfillmentVerdict', chainId, o)),
      });
    denyVerdict('the wrong chain id', { chainId: chainId + 1 });
    denyVerdict("domain name 'Escrow'", { name: 'Escrow' });
    denyVerdict("domain version '2'", { version: '2' });
    denyVerdict("primaryType 'ReleaseWitness' under the verdict domain", {
      primaryType: 'ReleaseWitness',
    });

    cases.push({
      name: 'verifier sign_raw_payloads batch carrying a valid witness',
      expect: 'DENY',
      run: () =>
        input.client().executeActivity('ACTIVITY_TYPE_SIGN_RAW_PAYLOADS', 'sign_raw_payloads', {
          signWith,
          payloads: [witnessPayload('ReleaseWitness', chainId, escrow, releaser)],
          encoding: 'PAYLOAD_ENCODING_EIP712',
          hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
        }),
    });
    cases.push({
      name: 'verifier EVM signTransaction (the verifier never signs a transaction)',
      expect: 'DENY',
      run: () =>
        input.client().signTransaction({
          signWith,
          type: 'TRANSACTION_TYPE_ETHEREUM',
          unsignedTransaction: ethers.Transaction.from({
            to: DECOY,
            value: 0n,
            nonce: 0,
            chainId,
            gasLimit: 21_000n,
            maxFeePerGas: 1_000_000_000n,
            maxPriorityFeePerGas: 1n,
            type: 2,
          }).unsignedSerialized.slice(2),
        }),
    });
  }

  // Credential changes on the agent's OWN user, which Turnkey otherwise allows implicitly. A probe
  // on another user id proves nothing here.
  const ownUser = async (): Promise<string> => {
    const who = await input.client().whoami();
    if (!who.userId)
      throw new Error('whoami returned no userId, so the credential probes cannot run');
    return who.userId;
  };
  cases.push({
    name: 'verifier CREATE_API_KEYS_V2 on its own user (a stolen credential must not add a key)',
    expect: 'DENY',
    run: async () =>
      input.client().executeActivity('ACTIVITY_TYPE_CREATE_API_KEYS_V2', 'create_api_keys', {
        apiKeys: [],
        userId: await ownUser(),
      }),
  });
  const sol = input.solanaAddress;
  if (sol) {
    cases.push({
      name: 'verifier Solana signTransaction (the verifier never signs a transaction)',
      expect: 'DENY',
      run: async () => {
        const payer = new PublicKey(sol);
        // Any well-formed blockhash will do: the policy engine never checks it, and nothing is sent.
        const msg = new TransactionMessage({
          payerKey: payer,
          recentBlockhash: '11111111111111111111111111111111',
          instructions: [
            SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }),
          ],
        }).compileToV0Message();
        return input.client().signTransaction({
          signWith: sol,
          type: 'TRANSACTION_TYPE_SOLANA',
          unsignedTransaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString(
            'hex',
          ),
        });
      },
    });
  }

  return cases;
}
