import { PaymentGatewayClient } from '../index';
import { startFakeGateway, type FakeGateway } from '../test-support/fake-gateway';
import { tronBase58 } from '../test-support/quotes';
import { formatAmount, tokenInfos, tokenKey } from './token-amount';

const USDC_ARB = 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const WETH_ETH = 'eip155:1/erc20:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const TRON_TOKEN = '0x' + 'a6'.repeat(20);
const USDT_TRON = `tron:mainnet/trc20:${tronBase58(TRON_TOKEN)}`;
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_SOL = `${SOLANA}/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`;

/** Tokens per chain, as /v1/defaults lists them: EVM addresses lowercase, Tron and Solana base58. */
const LISTED: Record<string, unknown[]> = {
  'eip155:42161': [
    { symbol: 'USDC', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },
  ],
  'eip155:1': [
    { symbol: 'WETH', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18 },
  ],
  'tron:mainnet': [{ symbol: 'USDT', address: tronBase58(TRON_TOKEN), decimals: 6 }],
  [SOLANA]: [
    { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  ],
};

let gateway: FakeGateway;
let client: PaymentGatewayClient;

async function serving(listed: Record<string, unknown[]>, failing: string[] = []) {
  gateway = await startFakeGateway({
    allowInvalidResponses: true,
    responders: {
      'GET /v1/defaults': (req) => {
        const chainId = String(req.query.chain_id);
        if (failing.includes(chainId)) {
          return { status: 503, body: { code: 'SERVICE_UNAVAILABLE', message: 'down' } };
        }
        return {
          body: {
            chain_id: chainId,
            quote_selector: '0xd0f080E23F95571D26eEb1FAD24a5F3d66835195',
            escrow_contract: '0xa61a0C025943Aa79B73D8D07E3aDbEe1873738b4',
            fulfillment_proxy: '0x09A5a0d6955E5394A661Cd9E7007076fa63B4158',
            fulfillment_verifier: {
              account: '0x27050EE47befC43F4dF7807a7AA8073039e5fa89',
              endpoint: 'https://v.test',
            },
            ...(listed[chainId] ? { tokens: listed[chainId] } : {}),
          },
        };
      },
    },
  });
  client = new PaymentGatewayClient({ BASE: gateway.url });
}

afterEach(async () => {
  await gateway?.close();
});

describe('formatAmount', () => {
  const usdc = new Map([[tokenKey(USDC_ARB), { symbol: 'USDC', decimals: 6 }]]);

  it.each([
    ['100150', '0.10015 USDC (100150 units)'],
    ['100000', '0.1 USDC (100000 units)'],
    ['50000000', '50 USDC (50000000 units)'],
    ['1', '0.000001 USDC (1 units)'],
  ])('reads %s units of a listed 6-decimal token as %s', (units, shown) => {
    expect(formatAmount(units, USDC_ARB, usdc)).toBe(shown);
  });

  it('names the token address when the token is not listed, or only the units in a table', () => {
    expect(formatAmount('100150', USDC_ARB)).toBe('100150 units of 0xaf88…5831');
    expect(formatAmount('100150', USDC_ARB, new Map(), { nameUnlisted: false })).toBe(
      '100150 units',
    );
  });

  it('shows an amount signing would refuse as given, in units', () => {
    expect(formatAmount('0x10', USDC_ARB, usdc)).toBe('0x10 units of 0xaf88…5831');
  });

  it('finds the token whatever the case of the asset identifier', () => {
    expect(formatAmount('100000', USDC_ARB.toLowerCase(), usdc)).toBe('0.1 USDC (100000 units)');
  });
});

describe('tokenInfos', () => {
  it('matches each asset to its listed token on EVM, Tron and Solana', async () => {
    await serving(LISTED);

    const tokens = await tokenInfos(client, [USDC_ARB, WETH_ETH, USDT_TRON, USDC_SOL]);

    expect(formatAmount('100150', USDC_ARB, tokens)).toBe('0.10015 USDC (100150 units)');
    expect(formatAmount('1500000000000000000', WETH_ETH, tokens)).toBe(
      '1.5 WETH (1500000000000000000 units)',
    );
    expect(formatAmount('2000000', USDT_TRON, tokens)).toBe('2 USDT (2000000 units)');
    expect(formatAmount('250000', USDC_SOL, tokens)).toBe('0.25 USDC (250000 units)');
    // One /v1/defaults read per chain.
    expect(gateway.received('GET', '/v1/defaults')).toHaveLength(4);
  });

  it('leaves out a token the chain does not list, and a chain whose defaults cannot be read', async () => {
    await serving({ 'eip155:42161': [] }, ['eip155:1']);

    const tokens = await tokenInfos(client, [USDC_ARB, WETH_ETH, 'not an asset']);

    expect(tokens.size).toBe(0);
  });

  it.each([
    ['a symbol with a control character', { symbol: 'USD\u001b[2JC', decimals: 6 }],
    ['a symbol longer than 16 characters', { symbol: 'U'.repeat(17), decimals: 6 }],
    ['decimals that are not an integer', { symbol: 'USDC', decimals: 6.5 }],
    ['decimals above 36', { symbol: 'USDC', decimals: 37 }],
  ])('leaves out a listed token with %s', async (_name, entry) => {
    await serving({
      'eip155:42161': [{ address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', ...entry }],
    });

    expect((await tokenInfos(client, [USDC_ARB])).size).toBe(0);
  });
});
