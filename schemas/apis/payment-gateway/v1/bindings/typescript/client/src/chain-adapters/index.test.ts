import { getChainAdapter, namespaceForTurnkeyAddressFormat } from './index';

describe('namespaceForTurnkeyAddressFormat', () => {
  // Round-trip each namespace through the format its adapter declares.
  it.each(['eip155', 'solana', 'tron'])(
    'maps %s adapter address format back to its namespace',
    (namespace) => {
      const format = getChainAdapter(`${namespace}:x`).turnkeyAddressFormat;
      expect(namespaceForTurnkeyAddressFormat(format!)).toBe(namespace);
    },
  );

  it('returns undefined for a format no adapter claims', () => {
    expect(namespaceForTurnkeyAddressFormat('ADDRESS_FORMAT_BITCOIN_P2PKH')).toBeUndefined();
  });
});

describe('getChainAdapter namespace casing', () => {
  // The reference is not part of the lookup, so a shouted or mixed-case cluster name still routes.
  // Whether it then resolves downstream is the reference rule's business, not the adapter's.
  it.each(['eip155:42161', 'EIP155:42161', 'Eip155:42161', 'TRON:MAINNET', 'tron:Shasta'])(
    'routes %s to an adapter',
    (chainId) => {
      expect(() => getChainAdapter(chainId)).not.toThrow();
    },
  );

  it('refuses a namespace no adapter claims', () => {
    expect(() => getChainAdapter('bip122:000000000019d6689c085ae165831e93')).toThrow(
      /Unsupported source chain/,
    );
  });
});
