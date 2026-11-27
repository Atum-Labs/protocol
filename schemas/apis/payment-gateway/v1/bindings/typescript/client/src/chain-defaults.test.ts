import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { PaymentGatewayClient } from './index';

// The success path of fetchChainDefaults: what the gateway puts on the wire (snake_case, with a
// nested fulfillment_verifier) versus the flat camelCase `ChainDefaults` callers receive. Served
// from a real loopback server so the body is parsed by the generated transport, the same way a
// live call is.
//
// The wire bodies below are shaped after the live production-testnet response.
const WIRE_EVM = {
  chain_id: 'eip155:84532',
  quote_selector: '0xd0f080E23F95571D26eEb1FAD24a5F3d66835195',
  escrow_contract: '0xa61a0C025943Aa79B73D8D07E3aDbEe1873738b4',
  fulfillment_proxy: '0x09A5a0d6955E5394A661Cd9E7007076fa63B4158',
  fulfillment_verifier: {
    account: '0x27050EE47befC43F4dF7807a7AA8073039e5fa89',
    endpoint: 'https://veri-fill.example.com',
  },
};

let next: { status: number; body: unknown };

describe('fetchChainDefaults', () => {
  let server: Server;
  let baseUrl: string;
  let lastUrl: string | undefined;

  beforeAll((done) => {
    server = createServer((req, res) => {
      lastUrl = req.url;
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  function serving(body: unknown): PaymentGatewayClient {
    next = { status: 200, body };
    return new PaymentGatewayClient({ BASE: baseUrl, timeoutMs: 5_000 });
  }

  it('sends chain_id as a query parameter on the contract path', async () => {
    await serving(WIRE_EVM).fetchChainDefaults('eip155:84532');

    // Percent-encoded because the generated transport builds the query, not string concatenation.
    expect(lastUrl).toBe('/v1/defaults?chain_id=eip155%3A84532');
  });

  it('maps the wire shape onto the flat camelCase ChainDefaults', async () => {
    const defaults = await serving(WIRE_EVM).fetchChainDefaults('eip155:84532');

    expect(defaults).toEqual({
      escrowContract: WIRE_EVM.escrow_contract,
      quoteSelector: WIRE_EVM.quote_selector,
      fulfillmentProxy: WIRE_EVM.fulfillment_proxy,
      // The nested object is flattened into two sibling fields.
      fulfillmentVerifierAccount: WIRE_EVM.fulfillment_verifier.account,
      fulfillmentVerifierEndpoint: WIRE_EVM.fulfillment_verifier.endpoint,
      permit2Contract: undefined,
      svmSignatureClusterId: undefined,
      svmSignatureDomainVersion: undefined,
    });
  });

  it('carries the Solana domain fields through when the chain publishes them', async () => {
    const defaults = await serving({
      ...WIRE_EVM,
      chain_id: 'solana:etwtrabzayq6imfeykouru166vu2xqa1',
      svm_signature_cluster_id: 'devnet',
      svm_signature_domain_version: 2,
    }).fetchChainDefaults('solana:etwtrabzayq6imfeykouru166vu2xqa1');

    expect(defaults.svmSignatureClusterId).toBe('devnet');
    expect(defaults.svmSignatureDomainVersion).toBe(2);
  });

  // The version preparePaymentRequest signs; absent is 1, so it is left absent rather than defaulted.
  it('carries the depositRequestHash version when the chain publishes one', async () => {
    const published = await serving({
      ...WIRE_EVM,
      deposit_request_hash_version: 2,
    }).fetchChainDefaults('eip155:84532');
    expect(published.depositRequestHashVersion).toBe(2);

    const absent = await serving(WIRE_EVM).fetchChainDefaults('eip155:84532');
    expect(absent.depositRequestHashVersion).toBeUndefined();
  });

  it('carries the depositRequestHash versions when the chain publishes them', async () => {
    const published = await serving({
      ...WIRE_EVM,
      deposit_request_hash_version: 2,
      deposit_request_hash_versions: [2],
    }).fetchChainDefaults('eip155:84532');
    expect(published.depositRequestHashVersions).toEqual([2]);

    const absent = await serving(WIRE_EVM).fetchChainDefaults('eip155:84532');
    expect(absent.depositRequestHashVersions).toBeUndefined();
  });

  // The version a direct deposit's id is derived at, which prepareDirectDepositRequest follows when
  // no version is passed. Absent on a gateway that predates it, and left absent, never defaulted.
  it.each([1, 2] as const)('carries a published direct-deposit version %d', async (version) => {
    const defaults = await serving({
      ...WIRE_EVM,
      direct_deposit_request_hash_version: version,
    }).fetchChainDefaults('eip155:84532');

    expect(defaults.directDepositRequestHashVersion).toBe(version);
  });

  it('leaves the direct-deposit version absent when the chain publishes none', async () => {
    const defaults = await serving(WIRE_EVM).fetchChainDefaults('eip155:84532');

    expect(defaults.directDepositRequestHashVersion).toBeUndefined();
  });

  // A version this build does not know is carried as published, never dropped: read as absent, it
  // would let a version passed by the caller build a deposit the gateway names no payment for.
  // prepareDirectDepositRequest refuses it instead.
  it.each([3, 0, '2', 1.5])(
    'carries a direct-deposit version of %p as published',
    async (version) => {
      const defaults = await serving({
        ...WIRE_EVM,
        direct_deposit_request_hash_version: version,
      }).fetchChainDefaults('eip155:84532');

      expect(defaults.directDepositRequestHashVersion).toBe(version);
    },
  );

  // JSON null publishes nothing, as for every other optional member.
  it('reads a null direct-deposit version as not published', async () => {
    const defaults = await serving({
      ...WIRE_EVM,
      direct_deposit_request_hash_version: null,
    }).fetchChainDefaults('eip155:84532');

    expect(defaults.directDepositRequestHashVersion).toBeUndefined();
  });

  // Every deployed escrow uses the four-member deposit witness, the only one the SDK builds, so
  // the gateway's deposit_witness_version is not carried.
  it('does not carry the deposit witness version', async () => {
    const defaults = await serving({ ...WIRE_EVM, deposit_witness_version: 4 }).fetchChainDefaults(
      'eip155:84532',
    );

    expect(defaults).not.toHaveProperty('depositWitnessVersion');
  });

  // The gateway publishes deposit-allowlisted tokens for browser clients. The SDK does not need
  // them to build a payment, so they are not part of `ChainDefaults` — a caller that wants them
  // reads them off the typed call directly. Pinned so dropping them stays a decision, not a
  // regression noticed later.
  it('ignores tokens rather than failing on them, and exposes them on the typed call', async () => {
    const wire = { ...WIRE_EVM, tokens: [{ symbol: 'USDC', address: '0x036c', decimals: 6 }] };
    const client = serving(wire);

    const defaults = await client.fetchChainDefaults('eip155:84532');
    expect(defaults).not.toHaveProperty('tokens');

    serving(wire);
    const raw = await client.chainDefaults.getDefaults({ chainId: 'eip155:84532' });
    expect(raw).toMatchObject({ tokens: [{ symbol: 'USDC', decimals: 6 }] });
  });

  describe('permit2_contract', () => {
    // Absence is a valid answer, not a missing value: the gateway omits the key unless the
    // chain's escrow verifies against a NON-canonical Permit2, and the signing adapters then
    // resolve the canonical address themselves. Failing here would break every chain.
    it('accepts its absence and leaves permit2Contract undefined', async () => {
      const defaults = await serving(WIRE_EVM).fetchChainDefaults('eip155:84532');

      expect(defaults.permit2Contract).toBeUndefined();
    });

    it('carries a published address through', async () => {
      const permit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
      const defaults = await serving({ ...WIRE_EVM, permit2_contract: permit2 }).fetchChainDefaults(
        'eip155:84532',
      );

      expect(defaults.permit2Contract).toBe(permit2);
    });

    // A blank value would be built into an EIP-712 domain that recovers to nothing, and the
    // signature would fail on-chain with nothing pointing back here. The contract declares
    // minLength 1, so a blank is a broken gateway, not a chain without Permit2.
    it.each([
      ['empty', ''],
      ['whitespace-only', '   '],
    ])('refuses a present-but-%s value', async (_label, value) => {
      await expect(
        serving({ ...WIRE_EVM, permit2_contract: value }).fetchChainDefaults('eip155:84532'),
      ).rejects.toThrow('defaults returned an empty permit2_contract');
    });
    // A gateway sending JSON null must neither crash the SDK nor leak a null into a field
    // the type declares as `string | undefined` — a consumer testing `!== undefined` would
    // otherwise build a signing domain around it.
    it('normalises a null value to undefined', async () => {
      const defaults = await serving({ ...WIRE_EVM, permit2_contract: null }).fetchChainDefaults(
        'eip155:84532',
      );

      expect(defaults.permit2Contract).toBeUndefined();
    });
  });

  describe('required corridor fields', () => {
    // A corridor address the SDK would otherwise pass to a signing adapter as `undefined`,
    // producing a signature bound to nothing. Named here instead.
    it.each([
      ['escrow_contract', 'defaults missing escrow_contract'],
      ['fulfillment_proxy', 'defaults missing fulfillment_proxy'],
      ['quote_selector', 'defaults missing quote_selector'],
      ['fulfillment_verifier', 'defaults missing fulfillment_verifier'],
    ])('names %s when the gateway omits it', async (field, message) => {
      const wire: Record<string, unknown> = { ...WIRE_EVM };
      delete wire[field];

      await expect(serving(wire).fetchChainDefaults('eip155:84532')).rejects.toThrow(message);
    });

    it.each([
      ['account', 'defaults missing fulfillment_verifier.account'],
      ['endpoint', 'defaults missing fulfillment_verifier.endpoint'],
    ])('names fulfillment_verifier.%s when the gateway omits it', async (field, message) => {
      const verifier: Record<string, unknown> = { ...WIRE_EVM.fulfillment_verifier };
      delete verifier[field];

      await expect(
        serving({ ...WIRE_EVM, fulfillment_verifier: verifier }).fetchChainDefaults('eip155:84532'),
      ).rejects.toThrow(message);
    });
  });
});
