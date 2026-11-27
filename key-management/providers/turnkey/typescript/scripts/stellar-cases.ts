/**
 * The Stellar rows of the live policy matrix in test-policies.ts.
 *
 * What these can and cannot prove. Turnkey documents no Stellar transaction parsing, so there is no
 * policy to exercise per transaction field: every Stellar signature is a raw ed25519 payload, and a
 * policy sees only the encoding, the hash function and the wallet account. The rows therefore check
 * exactly that fence, and the positive control comes first because the deny rows pass vacuously
 * while the allow matches nothing (`wallet_account.address` scoping on a Stellar account has no
 * documented example; this row is where it is first exercised).
 *
 * The payload is a stand-in transaction hash (32 bytes). Nothing is broadcast and the signature is
 * discarded.
 */
import type { TurnkeyClient } from '../src/client';

export interface StellarCase {
  name: string;
  expect: 'DENY' | 'ALLOW' | 'REJECTED' | 'REFUSED';
  run: () => Promise<unknown>;
}

export interface StellarCaseInput {
  role: 'settler' | 'sender' | 'verifier';
  /** The Stellar account, a `G...` strkey, that the allow is scoped to. */
  stellarAddress: string;
  /** Read at run time: the client is only built for a live run. */
  client: () => TurnkeyClient;
}

const HASH_SHAPED_PAYLOAD = 'cc'.repeat(32);

export function stellarCases(input: StellarCaseInput): StellarCase[] {
  const { role, stellarAddress: signWith, client } = input;
  const cases: StellarCase[] = [
    {
      name: 'Stellar signRawPayload HEXADECIMAL + NOT_APPLICABLE on the Stellar account (positive control: a transaction hash)',
      expect: 'ALLOW',
      run: () =>
        client().signRawPayload({
          signWith,
          payload: HASH_SHAPED_PAYLOAD,
          encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
          hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
        }),
    },
    {
      // TurnkeyStellarSigner.signMessage sends this pairing for the gateway handshake, which is
      // text. The verifier signs binary digests only, so its allow omits TEXT_UTF8.
      name:
        role === 'verifier'
          ? 'Stellar signRawPayload TEXT_UTF8 + NOT_APPLICABLE (the verifier allows HEXADECIMAL only)'
          : 'Stellar signRawPayload TEXT_UTF8 + NOT_APPLICABLE (the signMessage handshake pairing)',
      expect: role === 'verifier' ? 'DENY' : 'ALLOW',
      run: () =>
        client().signRawPayload({
          signWith,
          payload: 'settler-agent:gw-handshake:v1\nprobe',
          encoding: 'PAYLOAD_ENCODING_TEXT_UTF8',
          hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
        }),
    },
    {
      // Another hash function must not become a second path to the key. Either the policy or the
      // API may turn it away first, so both count.
      name: 'Stellar signRawPayload HASH_FUNCTION_SHA256 on the Stellar account',
      expect: 'REFUSED',
      run: () =>
        client().signRawPayload({
          signWith,
          payload: HASH_SHAPED_PAYLOAD,
          encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
          hashFunction: 'HASH_FUNCTION_SHA256',
        }),
    },
    {
      name: 'Stellar signRawPayload HASH_FUNCTION_NO_OP on the Stellar account',
      expect: 'REFUSED',
      run: () =>
        client().signRawPayload({
          signWith,
          payload: HASH_SHAPED_PAYLOAD,
          encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
          hashFunction: 'HASH_FUNCTION_NO_OP',
        }),
    },
  ];
  return cases;
}
