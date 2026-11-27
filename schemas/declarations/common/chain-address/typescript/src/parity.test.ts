import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  InvalidAccountError,
  REASONS,
  checkAccount,
  parse,
  supportedNamespaces,
  type Reason,
  validate,
} from './index.js';

// The same frozen file the Go half asserts against. If these two ever disagree, one language has
// drifted and the cross-language contract is broken.
const vectorsPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vectors.json');

interface AcceptCase {
  name: string;
  network: string;
  account: string;
  bytesHex: string;
  kind?: string;
}

interface RejectCase {
  name: string;
  network: string;
  account: string;
  reason: Reason;
  message: string;
}

const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as {
  accept: AcceptCase[];
  reject: RejectCase[];
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('chain-address parity', () => {
  it('reads a non-empty corpus', () => {
    expect(vectors.accept.length).toBeGreaterThan(0);
    expect(vectors.reject.length).toBeGreaterThan(0);
  });

  it.each(vectors.accept)('accepts $name with the canonical bytes', (want) => {
    const got = validate(want.network, want.account);
    expect(toHex(got.bytes)).toBe(want.bytesHex);
    expect(got.kind).toBe(want.kind ?? '');
  });

  it.each(vectors.reject)('rejects $name with reason $reason', (want) => {
    const error = checkAccount(want.network, want.account);
    expect(error).not.toBeNull();
    expect(error!.reason).toBe(want.reason);
    expect(error!.message).toBe(want.message);
  });
});

// A G account and a C contract with the same 32 bytes parse to equal bytes, so the kind is the only
// thing that tells them apart. The vectors pin each one's kind; this pins that the pair collides.
describe('stellar account kind', () => {
  it('tells a G account from a C contract that shares its bytes', () => {
    const account = validate('stellar:pubnet', 'GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH');
    const contract = validate('stellar:pubnet', 'CA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCTO56');
    expect(toHex(contract.bytes)).toBe(toHex(account.bytes));
    expect(account.kind).toBe('account');
    expect(contract.kind).toBe('contract');
  });
});

describe('coverage', () => {
  it('pins every reason', () => {
    // REASONS, not a list restated here. The union is derived from it, so a reason cannot exist
    // without this loop demanding a vector for it, which is what the namespace half below already
    // gets from supportedNamespaces().
    const seen = new Set(vectors.reject.map((c) => c.reason));
    for (const reason of REASONS) {
      expect(seen.has(reason), `no vector pins reason ${reason}`).toBe(true);
    }
  });

  it('pins every supported namespace', () => {
    const seen = new Set(vectors.accept.map((c) => c.network.split(':')[0]));
    for (const namespace of supportedNamespaces()) {
      expect(seen.has(namespace), `no accept vector for namespace ${namespace}`).toBe(true);
    }
  });
});

// The vectors pin only the reason and message, which are the same for every UNPARSEABLE input, so a
// refusal for the wrong cause (a muxed contract refused by a checksum slip in the vector) would
// still pass them. Mirrors TestStellarRejectionCauses in the Go half. The wording is the Stellar
// escrow-encoding decoder's, which this package calls; its own tests pin the error class for every
// case in the shared strkey-vectors.json.
describe('stellar rejection causes', () => {
  it.each([
    [
      'not an account or contract address',
      'WADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4RQG',
      'not an account or contract address',
    ],
    [
      'muxed account',
      'MADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA6OSU',
      'unsupported address type',
    ],
    [
      'S-prefixed string',
      'SA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCTOLY',
      'not an account or contract address',
    ],
    [
      'hash',
      'XA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSTPP',
      'not an account or contract address',
    ],
    [
      'account checksum',
      'GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYG',
      'bad checksum',
    ],
    [
      'contract checksum',
      'CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE6',
      'bad checksum',
    ],
    ['lowercase', 'ga5wuj54z23killcuounaktpbvzwkmqvo4o6eq5ghlaerimllhncskyh', 'upper-case base32'],
    [
      'newline in a valid 31-byte payload',
      'GA5WUJ54Z23KILLCUOUN\nAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ',
      'upper-case base32',
    ],
    [
      'carriage return in a valid 31-byte payload',
      'GA5WUJ54Z23KILLCUOUN\rAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ',
      'upper-case base32',
    ],
    [
      'contract with a newline in a valid 31-byte payload',
      'CA5WUJ54Z23KILLCUOUN\nAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNBL7Y',
      'upper-case base32',
    ],
    [
      'T-prefixed string',
      'TA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCTXKW',
      'not an account or contract address',
    ],
    [
      'signed payload',
      'PA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSAAAAACACAQDATGQY',
      'not an account or contract address',
    ],
    [
      'muxed contract with a valid checksum',
      'WA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSAAAAAAAAAAAAC4AS',
      'not an account or contract address',
    ],
    [
      'muxed account with a valid checksum',
      'MA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSAAAAAAAAAAAAADCA',
      'unsupported address type',
    ],
  ])('refuses a %s for the right cause', (_name, account, detail) => {
    const error = checkAccount('stellar:pubnet', account);
    expect(error?.reason).toBe('UNPARSEABLE');
    expect(error?.detail).toContain(detail);
  });
});

// The one strkey vector file every Stellar strkey decoder in the repo is tested against. chain-address no
// longer carries its own decoder; this proves the delegation keeps every case's outcome.
interface StrkeyVectors {
  valid: { name: string; address: string; payloadHex: string }[];
  invalid: { name: string; address: string }[];
}
const strkeyVectors: StrkeyVectors = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      ...Array(6).fill('..'),
      'contracts',
      'stellar',
      'conformance',
      'strkey-vectors.json',
    ),
    'utf8',
  ),
);

describe('shared stellar strkey vectors', () => {
  it('has cases to run', () => {
    expect(strkeyVectors.valid.length).toBeGreaterThan(0);
    expect(strkeyVectors.invalid.length).toBeGreaterThan(0);
  });

  it.each(strkeyVectors.valid.map((c) => [c.name, c] as const))('accepts %s', (_name, c) => {
    // parse, not validate: the all-zero account is a valid strkey, refused only by the zero rule.
    expect(Buffer.from(parse('stellar:pubnet', c.address).bytes).toString('hex')).toBe(c.payloadHex);
  });

  it.each(strkeyVectors.invalid.map((c) => [c.name, c] as const))('refuses %s', (_name, c) => {
    expect(() => parse('stellar:pubnet', c.address)).toThrow(InvalidAccountError);
    // Whitespace and emptiness are refused before the strkey is read, with their own reasons.
    let reason: string | undefined;
    try {
      parse('stellar:pubnet', c.address);
    } catch (error) {
      reason = (error as InvalidAccountError).reason;
    }
    expect(['UNPARSEABLE', 'EMPTY', 'SURROUNDING_WHITESPACE']).toContain(reason);
  });
});
