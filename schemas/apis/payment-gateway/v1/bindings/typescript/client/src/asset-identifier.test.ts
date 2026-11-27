import { assetChainId, parseAssetIdentifier } from './asset-identifier';

// A real checksummed address and its all-lowercase form, so the checksum cases are about
// capitalization rather than about a wrong address.
const CHECKSUMMED = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const LOWERCASE = CHECKSUMMED.toLowerCase();

/** The whole message, so a case that grows a contradicting clause cannot pass a substring check. */
function messageOf(value: string): string {
  try {
    parseAssetIdentifier(value);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`expected ${value} to be refused`);
}

describe('parseAssetIdentifier', () => {
  it('splits a well-formed identifier and preserves what a signature covers', () => {
    const parsed = parseAssetIdentifier(`eip155:421614/erc20:${CHECKSUMMED}`);

    expect(parsed).toEqual({
      chainId: 'eip155:421614',
      namespace: 'eip155',
      reference: '421614',
      assetNamespace: 'erc20',
      tokenAddress: CHECKSUMMED,
      normalized: `eip155:421614/erc20:${CHECKSUMMED}`,
    });
  });

  it('lowercases only the namespace, since base58 references are case-sensitive', () => {
    const solana = parseAssetIdentifier(
      'SOLANA:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );

    expect(solana.namespace).toBe('solana');
    expect(solana.reference).toBe('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(solana.chainId).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(solana.tokenAddress).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  // The reference rule is per namespace, mirroring manifest.CanonicalizeCAIP2. A tron cluster name
  // folds, so a shouted corridor still routes. A solana reference must not fold: it is base58, and
  // its cluster name is UTF-8 encoded into the escrow's on-chain cluster_id.
  it.each([
    ['TRON:MAINNET', 'tron:mainnet'],
    ['tron:Shasta', 'tron:shasta'],
    ['tron:mainnet', 'tron:mainnet'],
  ])('folds the tron chain reference of %j', (value, expected) => {
    expect(parseAssetIdentifier(`${value}/TRC20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`).chainId).toBe(
      expected,
    );
  });

  it('leaves a solana reference alone, where case is part of the signing domain', () => {
    const mixed =
      'SOLANA:EtWTRABZaYq6iMfeYKouRU166VU2xqa1/spl:cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN';

    expect(parseAssetIdentifier(mixed).chainId).toBe('solana:EtWTRABZaYq6iMfeYKouRU166VU2xqa1');
  });

  it('accepts a Tron base58 token without imposing an EVM address shape on it', () => {
    const tron = parseAssetIdentifier('tron:shasta/trc20:TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs');

    expect(tron.namespace).toBe('tron');
    expect(tron.tokenAddress).toBe('TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs');
  });

  it.each(['pubnet', 'testnet'])(
    'accepts a Stellar SEP-41 token as stellar:%s/sep41:<C... contract id>, case preserved',
    (network) => {
      const contract = 'CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5';
      const stellar = parseAssetIdentifier(`stellar:${network}/sep41:${contract}`);

      expect(stellar.namespace).toBe('stellar');
      expect(stellar.reference).toBe(network);
      expect(stellar.assetNamespace).toBe('sep41');
      expect(stellar.tokenAddress).toBe(contract);
      expect(stellar.normalized).toBe(`stellar:${network}/sep41:${contract}`);
    },
  );

  // The chain half has to be a well-formed CAIP-2 id with a canonical namespace and reference.
  it.each([
    'eip155:421614',
    'eip155',
    '',
    '   ',
    'eip155:/erc20:0x0',
    ':421614/erc20:0x0',
    'eip155:421614:extra/erc20:0x0',
    ` eip155:421614/erc20:${LOWERCASE}`,
    `eip155:421614 /erc20:${LOWERCASE}`,
    `eip 155:421614/erc20:${LOWERCASE}`,
  ])('names the expected shape for %j', (value) => {
    expect(() => parseAssetIdentifier(value)).toThrow(
      /^Invalid asset identifier ".*": expected CAIP-19 "<chain>\/<type>:<address>", e\.g\. eip155:421614\/erc20:0x\.\.\.$/,
    );
  });

  it('reports a non-string identifier as a shape problem rather than crashing', () => {
    expect(() => parseAssetIdentifier(undefined)).toThrow(/expected CAIP-19/);
    expect(() => parseAssetIdentifier(42 as unknown as string)).toThrow(/expected CAIP-19/);
  });

  // Each of these has a chain part the parser accepts and an asset part it cannot use.
  it.each([
    ['empty token', 'eip155:421614/erc20:'],
    ['no asset namespace', 'eip155:421614/0x0'],
    ['extra slash', `eip155:421614//erc20:${LOWERCASE}`],
    ['leading slash in the asset namespace', `eip155:421614//${LOWERCASE}`],
    ['empty token id', `eip155:1/erc721:${LOWERCASE}/`],
    [
      'colon inside the token reference',
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:MINT:extra',
    ],
    ['asset namespace too short', `eip155:1/ec:${LOWERCASE}`],
    ['truncated address', 'eip155:1/erc20:0xabc'],
    ['not hex', 'eip155:1/erc20:0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
  ])('names the token address for a %s', (_label, value) => {
    expect(() => parseAssetIdentifier(value)).toThrow(`Invalid token address in asset "${value}".`);
  });

  describe('EIP-55 checksum', () => {
    it('reports a capitalization problem for a mixed-case address that fails the checksum', () => {
      // One character's case flipped, so the shape is right and only the checksum is wrong.
      const broken = CHECKSUMMED.replace('0xaf', '0xAf');

      expect(() => parseAssetIdentifier(`eip155:42161/erc20:${broken}`)).toThrow(
        `Token address "${broken}" has an invalid checksum. Fix the capitalization or use the all-lowercase form.`,
      );
    });

    // The message tells the caller to use the all-lowercase form, so all three single-case and
    // correctly-checksummed spellings have to be accepted for that advice to be true.
    it.each([
      ['checksummed', CHECKSUMMED],
      ['all lowercase', LOWERCASE],
      ['all uppercase', '0x' + LOWERCASE.slice(2).toUpperCase()],
    ])('accepts a %s address, which is what the message offers as the fix', (_label, address) => {
      expect(parseAssetIdentifier(`eip155:42161/erc20:${address}`).tokenAddress).toBe(address);
    });
  });
});

describe('eip155 chain reference', () => {
  it('accepts a decimal chain id', () => {
    expect(parseAssetIdentifier(`eip155:421614/erc20:${LOWERCASE}`).reference).toBe('421614');
  });

  // The caller's shape is already right, so the message names the decimal a numeric read would take
  // the hex for. Shouted namespace and shouted prefix included, since the rule applies to the
  // canonicalized namespace and `eth_chainId` capitalization is not the caller's fault.
  it.each([
    [`eip155:0x66eee/erc20:${LOWERCASE}`, '0x66eee', '421614'],
    [`EIP155:0x66eee/erc20:${LOWERCASE}`, '0x66eee', '421614'],
    [`eip155:0X66EEE/erc20:${LOWERCASE}`, '0X66EEE', '421614'],
    // Exact past 2^53, where rounding would name a chain id nobody has.
    [`eip155:0xffffffffffffffff/erc20:${LOWERCASE}`, '0xffffffffffffffff', '18446744073709551615'],
  ])('names the decimal chain id for %j', (value, reference, decimal) => {
    expect(messageOf(value)).toBe(
      `Invalid eip155 chain id "${reference}" in asset "${value}": use the decimal chain id (${decimal}), not hex.`,
    );
  });

  // No decimal is named for these: there is none to name, or it is past any real chain id.
  it.each([
    [`eip155:arbitrum/erc20:${LOWERCASE}`, 'arbitrum'],
    [`eip155:0xzz/erc20:${LOWERCASE}`, '0xzz'],
    [`eip155:0x/erc20:${LOWERCASE}`, '0x'],
    [`eip155:0x1ffffffffffffffff/erc20:${LOWERCASE}`, '0x1ffffffffffffffff'],
  ])('states the rule for %j', (value, reference) => {
    expect(messageOf(value)).toBe(
      `Invalid eip155 chain id "${reference}" in asset "${value}": an eip155 chain id is decimal, e.g. 421614.`,
    );
  });
});

describe('native asset', () => {
  // slip44 names a chain's own coin, so there is no contract to permit, escrow or pay out.
  it.each([
    'eip155:1/slip44:60',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/SLIP44:501',
    // The reference is beside the point when there is no contract, so these say so too rather than
    // falling through to the address message.
    'eip155:1/slip44:',
    'eip155:1/slip44:60/1',
  ])('names the native asset for %j rather than blaming its address', (value) => {
    expect(messageOf(value)).toBe(
      `Asset "${value}" is a native asset (slip44) and has no contract to deposit. Use the wrapped token's erc20 identifier.`,
    );
  });
});

describe('CAIP-19 token id', () => {
  it('accepts an asset carrying a token id and keeps it', () => {
    const parsed = parseAssetIdentifier(`eip155:1/erc721:${LOWERCASE}/1234`);

    expect(parsed.tokenAddress).toBe(LOWERCASE);
    expect(parsed.tokenId).toBe('1234');
    expect(parsed.normalized).toBe(`eip155:1/erc721:${LOWERCASE}/1234`);
  });
});

describe('normalization', () => {
  it('lowercases the namespace and leaves every other segment alone', () => {
    const parsed = parseAssetIdentifier(
      'SOLANA:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );

    // The PaymentRequest schema pins asset_identifier to lowercase namespaces, so this is the
    // spelling that can go on the wire.
    expect(parsed.normalized).toBe(
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
  });

  it('lowercases the asset namespace, which the schema also pins', () => {
    expect(parseAssetIdentifier(`eip155:42161/ERC20:${LOWERCASE}`).normalized).toBe(
      `eip155:42161/erc20:${LOWERCASE}`,
    );
  });

  // Every message echoes the value, so every message has to be bounded, not just the first one.
  it.each([
    ['token address', 'eip155:42161/erc20:0x' + 'a'.repeat(5000)],
    ['chain reference', 'eip155:' + 'e'.repeat(5000) + `/erc20:${LOWERCASE}`],
    ['native asset', 'solana:' + 'a'.repeat(5000) + '/slip44:501'],
  ])('truncates a very long %s rather than echoing all of it', (_label, long) => {
    const message = messageOf(long);

    expect(message).toContain('…');
    expect(message.length).toBeLessThan(300);
  });
});

describe('assetChainId', () => {
  it('returns the chain id with the namespace lowercased', () => {
    expect(assetChainId(`EIP155:421614/erc20:${LOWERCASE}`)).toBe('eip155:421614');
  });

  it('applies the same validation as the parser', () => {
    expect(() => assetChainId('eip155:421614')).toThrow(/expected CAIP-19/);
  });
});
