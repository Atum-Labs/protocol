// The Permit2 deposit must be signed for max_source_amount (the authorized ceiling
// the escrow actually deposits), NOT fulfillment_amount. Exercises the REAL
// chain adapters (no getChainAdapter mock) end-to-end through preparePaymentRequest.
import { PaymentGatewayClient } from './index';
import type { ChainDefaults } from './chain-adapters';

const evmDefaults: ChainDefaults = {
  escrowContract: '0x0000000000000000000000000000000000000001',
  fulfillmentProxy: '0x0000000000000000000000000000000000000002',
  quoteSelector: '0x0000000000000000000000000000000000000003',
  fulfillmentVerifierAccount: '0x0000000000000000000000000000000000000004',
  fulfillmentVerifierEndpoint: 'https://verifier.example',
};

class TestClient extends PaymentGatewayClient {
  async fetchChainDefaults(_chainId: string): Promise<ChainDefaults> {
    return evmDefaults;
  }
}

const FULFILLMENT = '100000';
const MAX_SOURCE = '103000'; // fulfillment + 3% markup — the authorized ceiling

describe('preparePaymentRequest signs the deposit for max_source_amount (EVM)', () => {
  it('permit.permitted.amount == max_source_amount, not fulfillment_amount', async () => {
    const client = new TestClient({ BASE: 'https://gateway.example' });
    const pr = await client.preparePaymentRequest({
      depositor: '0x0000000000000000000000000000000000000005',
      fulfillmentAmount: FULFILLMENT,
      maxSourceAmount: MAX_SOURCE,
      sourceAsset: 'eip155:1/erc20:0x0000000000000000000000000000000000000006',
      destinationAccount: '0x0000000000000000000000000000000000000007',
      destinationAsset: 'eip155:2/erc20:0x0000000000000000000000000000000000000008',
      requestId: 'req-permit-amount',
    });

    expect(pr.max_source_amount).toBe(MAX_SOURCE);

    const prehash = JSON.parse(pr.sender_auth!.signed_messages![0].message_prehash!);
    // The signed Permit2 deposit must authorize the ceiling, not the fulfillment amount.
    expect(prehash.message.permitted.amount).toBe(MAX_SOURCE);
  });

  it('carries a cap past 2^53 through to the permit without rounding', async () => {
    // A uint256 amount routinely exceeds Number.MAX_SAFE_INTEGER (18-decimal tokens); any detour
    // through a JS number would silently sign for a different ceiling than the one requested.
    const bigCap = '1000000000000000001';
    const client = new TestClient({ BASE: 'https://gateway.example' });
    const pr = await client.preparePaymentRequest({
      depositor: '0x0000000000000000000000000000000000000005',
      fulfillmentAmount: FULFILLMENT,
      maxSourceAmount: bigCap,
      sourceAsset: 'eip155:1/erc20:0x0000000000000000000000000000000000000006',
      destinationAccount: '0x0000000000000000000000000000000000000007',
      destinationAsset: 'eip155:2/erc20:0x0000000000000000000000000000000000000008',
      requestId: 'req-permit-amount-big',
    });

    expect(pr.max_source_amount).toBe(bigCap);
    const prehash = JSON.parse(pr.sender_auth!.signed_messages![0].message_prehash!);
    expect(prehash.message.permitted.amount).toBe(bigCap);
  });
});
