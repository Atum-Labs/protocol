import { describe, it, expect } from 'vitest';
import {
  namespaceOf,
  evmChainId,
  tronNumericChainId,
  resolveTronPermit2,
  clusterIdFromName,
  MAX_EVM_CHAIN_ID,
  MAX_TRON_CHAIN_ID,
} from './chain-id.js';
import { TronChainIdError } from './errors.js';

describe('chain-id helpers', () => {
  it('extracts the CAIP-2 namespace', () => {
    expect(namespaceOf('eip155:1')).toBe('eip155');
    expect(namespaceOf('tron:mainnet')).toBe('tron');
    expect(namespaceOf('solana:mainnet')).toBe('solana');
  });

  it('parses the eip155 numeric chain id (and rejects non-eip155)', () => {
    expect(evmChainId('eip155:1')).toBe(1);
    expect(evmChainId('eip155:8453')).toBe(8453);
    expect(() => evmChainId('tron:mainnet')).toThrow(/expected an eip155 network/);
  });

  it('refuses an eip155 chain id above the EIP-2294 maximum', () => {
    // The bound itself, so a drift in the constant cannot pass while the message keeps quoting it.
    expect(MAX_EVM_CHAIN_ID).toBe(9007199254740991);
    // Last accepted, first refused. The pair is what a `>` that slipped to `>=` would break, and
    // the Go mirror asserts the same two values.
    expect(evmChainId('eip155:9007199254740991')).toBe(9007199254740991);
    expect(() => evmChainId('eip155:9007199254740992')).toThrow(/exceeds the EIP-2294 maximum/);
    // `Number` reads this one as 9007199254740992, so the signed domain would commit to a chain
    // id the identifier does not name.
    expect(() => evmChainId('eip155:9007199254740993')).toThrow(/exceeds the EIP-2294 maximum/);
    // Past int64, where Go's parse fails first. Both report the range, not a bad namespace.
    expect(() => evmChainId('eip155:99999999999999999999999999')).toThrow(
      /exceeds the EIP-2294 maximum/,
    );
  });

  it('maps Tron networks to numeric chain ids', () => {
    expect(tronNumericChainId('tron:mainnet')).toBe(728126428);
    expect(tronNumericChainId('tron:shasta')).toBe(2494104990);
    expect(() => tronNumericChainId('tron:unknown')).toThrow(/unsupported Tron network/);
  });

  it('refuses a non-tron network rather than reading its cluster name', () => {
    // The cluster name alone does not identify a chain, so these must not resolve to Tron
    // mainnet. The Go mirror refuses the same inputs.
    expect(() => tronNumericChainId('eip155:mainnet')).toThrow(/expected a tron network/);
    expect(() => tronNumericChainId('solana:mainnet')).toThrow(/expected a tron network/);
    expect(() => tronNumericChainId(':mainnet')).toThrow(/expected a tron network/);
    expect(() => tronNumericChainId('mainnet')).toThrow(/expected a tron network/);
    // Namespace is right, segment count is not.
    expect(() => tronNumericChainId('tron:mainnet:extra')).toThrow(/unsupported Tron network/);
  });

  it('refuses an inherited object member as a cluster or a Permit2 address', () => {
    // A plain index read reaches Object.prototype; Go's map lookup does not, so refusing here
    // keeps the two bindings equivalent.
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(() => tronNumericChainId(`tron:${name}`)).toThrow(/unsupported Tron network/);
      expect(() => resolveTronPermit2(name)).toThrow(/no Permit2 address known/);
    }
  });

  it('reads a supplied Tron chain id only where the table has none, and never against it', () => {
    // The Go mirror asserts the same inputs.
    const localnet = { localnet: 3360022319 };
    expect(tronNumericChainId('tron:localnet', localnet)).toBe(3360022319);
    // Nothing supplied for the cluster: refused exactly as without the option.
    expect(() => tronNumericChainId('tron:localnet')).toThrow(/unsupported Tron network/);
    expect(() => tronNumericChainId('tron:localnet', {})).toThrow(/unsupported Tron network/);
    expect(() => tronNumericChainId('tron:localnet', { nile: 3360022319 })).toThrow(
      /unsupported Tron network/,
    );
    // The table is authoritative: an entry may repeat its id, never replace it.
    expect(tronNumericChainId('tron:mainnet', { mainnet: 728126428 })).toBe(728126428);
    expect(() => tronNumericChainId('tron:mainnet', { mainnet: 3360022319 })).toThrow(
      new TronChainIdError(
        'the Tron chain id supplied for cluster "mainnet" is 3360022319, but the built-in table has 728126428',
      ),
    );
    expect(() => tronNumericChainId('tron:shasta', { shasta: 728126428 })).toThrow(
      new TronChainIdError(
        'the Tron chain id supplied for cluster "shasta" is 728126428, but the built-in table has 2494104990',
      ),
    );
    // Only the source's own cluster is read, so an unusable entry for another changes nothing.
    expect(tronNumericChainId('tron:mainnet', { localnet: 0, shasta: 1 })).toBe(728126428);
  });

  it('refuses a supplied Tron chain id that the table gives another cluster', () => {
    // A built-in id under a new name would make that name an alias of the built-in network, so a
    // permit signed for mainnet would verify there. The Go mirror asserts the same inputs.
    expect(() => tronNumericChainId('tron:localnet', { localnet: 728126428 })).toThrow(
      new TronChainIdError(
        'the Tron chain id supplied for cluster "localnet" is 728126428, which the built-in table gives cluster "mainnet"',
      ),
    );
    expect(() => tronNumericChainId('tron:localnet', { localnet: 2494104990 })).toThrow(
      new TronChainIdError(
        'the Tron chain id supplied for cluster "localnet" is 2494104990, which the built-in table gives cluster "shasta"',
      ),
    );
    // The non-canonical alias of mainnet stays refused when an entry names it.
    expect(() => tronNumericChainId('tron:0x2b6653dc', { '0x2b6653dc': 728126428 })).toThrow(
      new TronChainIdError(
        'the Tron chain id supplied for cluster "0x2b6653dc" is 728126428, which the built-in table gives cluster "mainnet"',
      ),
    );
    // Only an id the table uses is refused, not its neighbours.
    expect(tronNumericChainId('tron:localnet', { localnet: 728126429 })).toBe(728126429);
    expect(tronNumericChainId('tron:localnet', { localnet: 2494104989 })).toBe(2494104989);
  });

  it('quotes supplied cluster names in error details exactly as the Go binding does', () => {
    // These literals pin the output independently of the production quoteValue helper. Go
    // asserts the same cases, including a control character (which %q renders differently).
    for (const { cluster, quoted } of [
      { cluster: 'local"quote', quoted: '"local\\"quote"' },
      { cluster: 'local\\slash', quoted: '"local\\\\slash"' },
      { cluster: 'local\nline', quoted: '"local\\u000aline"' },
    ]) {
      expect(() => tronNumericChainId(`tron:${cluster}`, { [cluster]: 0 })).toThrow(
        new TronChainIdError(
          `the Tron chain id supplied for cluster ${quoted} is not an integer in 1..4294967295`,
        ),
      );
      expect(() => tronNumericChainId(`tron:${cluster}`, { [cluster]: 728126428 })).toThrow(
        new TronChainIdError(
          `the Tron chain id supplied for cluster ${quoted} is 728126428, which the built-in table gives cluster "mainnet"`,
        ),
      );
    }
  });

  it('exports TronChainIdError from the package entry', async () => {
    // A caller validating its own configuration tells a misconfiguration from an unsupported
    // network by class, as it can for the other errors the public functions throw.
    const entry: Record<string, unknown> = await import('./index.js');
    expect(entry['TronChainIdError']).toBe(TronChainIdError);
    expect(() => tronNumericChainId('tron:localnet', { localnet: 0 })).toThrow(TronChainIdError);
    expect(() => tronNumericChainId('tron:localnet', {})).not.toThrow(TronChainIdError);
  });

  it('accepts a supplied Tron chain id only in 1..MAX_TRON_CHAIN_ID', () => {
    // TIP712.sol refuses a chain id above uint32, and the Go mirror uses the same bound.
    expect(MAX_TRON_CHAIN_ID).toBe(4294967295);
    // First and last accepted, then the first refused on each side: the pairs a slipped bound breaks.
    expect(tronNumericChainId('tron:localnet', { localnet: 1 })).toBe(1);
    expect(tronNumericChainId('tron:localnet', { localnet: 4294967295 })).toBe(4294967295);
    const outOfRange =
      'the Tron chain id supplied for cluster "localnet" is not an integer in 1..4294967295';
    for (const id of [0, -1, 4294967296]) {
      expect(() => tronNumericChainId('tron:localnet', { localnet: id }), String(id)).toThrow(
        new TronChainIdError(outOfRange),
      );
    }
    // Values only a JavaScript caller can pass.
    for (const id of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
      expect(
        () => tronNumericChainId('tron:localnet', { localnet: id as number }),
        String(id),
      ).toThrow(new TronChainIdError(outOfRange));
    }
  });

  it('keeps the namespace, segment and own-key rules when ids are supplied', () => {
    const supplied = { localnet: 3360022319, '': 5 };
    expect(() => tronNumericChainId('eip155:localnet', supplied)).toThrow(
      /expected a tron network/,
    );
    expect(() => tronNumericChainId('tron:localnet:extra', supplied)).toThrow(
      /unsupported Tron network/,
    );
    // An empty cluster names no network, even when an entry is keyed by the empty string.
    expect(() => tronNumericChainId('tron:', supplied)).toThrow(/unsupported Tron network/);
    // An inherited member is not an entry, as a Go map has none.
    expect(() =>
      tronNumericChainId(
        'tron:localnet',
        Object.create({ localnet: 3360022319 }) as Record<string, number>,
      ),
    ).toThrow(/unsupported Tron network/);
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(() => tronNumericChainId(`tron:${name}`, {})).toThrow(/unsupported Tron network/);
    }
  });

  it('refuses supplied Tron chain ids that are not an object, for a Tron network only', () => {
    // Go's type system rules these out, so they are refused rather than read as none.
    for (const ids of [null, [], 'localnet', 3360022319]) {
      expect(() => tronNumericChainId('tron:mainnet', ids as never), String(ids)).toThrow(
        new TronChainIdError('the supplied Tron chain ids are not an object keyed by cluster'),
      );
    }
    expect(() => tronNumericChainId('eip155:1', null as never)).toThrow(/expected a tron network/);
  });

  it('resolves Tron Permit2 only from the pinned map', () => {
    expect(resolveTronPermit2('tron:mainnet')).toBe('TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m');
    expect(resolveTronPermit2('tron:shasta')).toBe('TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp');
    expect(() => resolveTronPermit2('tron:unknown')).toThrow(/no Permit2 address known/);
  });

  it('clusterIdFromName right-pads to 32 bytes and rejects oversize', () => {
    const id = clusterIdFromName('devnet');
    expect(id.length).toBe(32);
    expect(id[0]).toBe('devnet'.charCodeAt(0));
    expect(() => clusterIdFromName('x'.repeat(33))).toThrow(/too long/);
  });
});
