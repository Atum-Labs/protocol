// award-quote in-process: from a script with --from, and at a terminal with ids, against the
// contract-checked fake gateway with settler-signed quotes.
import { ethers } from 'ethers';
import { PaymentGatewayClient } from '../index';
import type { AwardedQuote, CreateQuoteRequest } from '../index';
import { startFakeGateway, type FakeGateway, type Responder } from '../test-support/fake-gateway';
import { signedQuoteFor, tronBase58 } from '../test-support/quotes';
import { contractsProblem, runAwardQuote, SCRIPT_NEEDS_FROM } from './award-command';
import { EXIT_ERROR, EXIT_PENDING } from './payment-outcome';
import type { SelectorKey } from './quote-selector';
import type { Terminal } from './terminal';
import { scriptedChoose } from '../test-support/terminal';

const depositor = new ethers.Wallet(ethers.id('award-command test depositor'));
const SOURCE_ASSET = 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const DEST_ASSET = 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RECEIVER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const STRANGER = '0x' + '66'.repeat(20);
const FILE = 'quotes.json';
const QUOTE_ID = '0x' + 'cd'.repeat(32);

let gateway: FakeGateway;
let client: PaymentGatewayClient;
/** What the gateway lists for qr_test. */
let listed: { quotes: AwardedQuote[]; payments?: { quote_id: string; payment_id: string }[] };
let lines: string[];
let asked: string[];
let keysRead: number;

async function start(responders: Record<string, Responder> = {}, servesErrors = false) {
  gateway = await startFakeGateway({
    allowInvalidResponses: servesErrors,
    responders: {
      'GET /v1/payments/quote-requests/{quoteRequestId}': () => ({
        body: {
          quote_request_id: 'qr_test',
          status: listed.payments ? 'awarded' : 'ready',
          ...listed,
        },
      }),
      ...responders,
    },
  });
  client = new PaymentGatewayClient({ BASE: gateway.url });
}

beforeEach(() => {
  listed = { quotes: [] };
  lines = [];
  asked = [];
  keysRead = 0;
  screens = [];
});

afterEach(async () => {
  await gateway?.close();
});

/** What the person saw when the selector opened, one entry per selector. */
let screens: string[][];

function terminal(interactive: boolean, answers: string[] = [], keys?: SelectorKey[]): Terminal {
  return {
    ...(keys ? { choose: scriptedChoose(keys, screens) } : {}),
    interactive,
    write: (line) => lines.push(line),
    ask: async (question) => {
      asked.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected question: ${question}`);
      return answer;
    },
  };
}

function quoteRequest(
  receiver = RECEIVER,
  requestId = 'award-command-test',
  /** `null`: no cap. */
  cap: string | null = '100000',
) {
  return client.prepareQuoteRequest({
    depositor: depositor.address,
    fulfillmentAmount: '98000',
    sourceAsset: SOURCE_ASSET,
    destinationAccount: receiver,
    destinationAsset: DEST_ASSET,
    maxSourceAmount: cap ?? undefined,
    requestId,
  });
}

/** What request-quote printed from a script, holding the body it sent. */
function requestQuoteOutput(body: CreateQuoteRequest): string {
  return JSON.stringify({ quote_request_id: 'qr_test', status: 'ready', quote_request: body });
}

function award(
  args: string[],
  options: {
    from?: string;
    file?: string;
    interactive?: boolean;
    answers?: string[];
    keys?: SelectorKey[];
  } = {},
) {
  return runAwardQuote({
    client,
    terminal: terminal(options.interactive ?? false, options.answers, options.keys),
    args,
    from: options.from,
    readFile: () => options.file ?? '',
    writeOut: () => undefined,
    readPrivateKey: async () => {
      keysRead++;
      return depositor.privateKey;
    },
  });
}

const awards = () =>
  gateway.received('POST', '/v1/payments/awards') as Array<{
    body: { quote_id: string };
    violation?: string;
  }>;

describe('award-quote from a script', () => {
  it('refuses bare ids before reading anything', async () => {
    await start();

    const code = await award(['qr_test', '0x' + 'cd'.repeat(32)]);

    expect(code).toBe(EXIT_ERROR);
    expect(lines.join('\n')).toContain(SCRIPT_NEEDS_FROM);
    expect(gateway.requests).toHaveLength(0);
  });

  it('--from awards the cheapest quote that can be awarded, committing the body request-quote sent', async () => {
    await start();
    const body = await quoteRequest();
    const cheap = await signedQuoteFor(body, { sourceAmount: '99000' });
    const dear = await signedQuoteFor(body, { sourceAmount: '99500' });
    const expired = await signedQuoteFor(body, { sourceAmount: '98000', awardWithinSeconds: -5 });
    // Its amount was changed after the settler signed, so quote_id is no longer its hash.
    const forged = {
      ...cheap,
      quote_id: '0x' + 'ab'.repeat(32),
      fulfillment_quote: { ...cheap.fulfillment_quote, source_amount: '98500' },
    };
    listed = { quotes: [dear, expired, forged, cheap] };

    const code = await award([], { from: FILE, file: requestQuoteOutput(body) });

    expect(code).toBe(EXIT_PENDING);
    expect(awards()).toHaveLength(1);
    expect(awards()[0].violation).toBeUndefined();
    expect(awards()[0].body.quote_id).toBe(cheap.quote_id);
    expect(lines).toContain(
      `Chose quote ${cheap.quote_id}, the cheapest of 2 that can be awarded.`,
    );
    expect(asked).toEqual([]);
  });

  it('--from with no quote_id refuses a quote request with no max_source_amount, before a key is read', async () => {
    await start();
    const body = await quoteRequest(RECEIVER, 'no-cap', null);
    expect(body.max_source_amount).toBeUndefined();
    listed = { quotes: [await signedQuoteFor(body, { sourceAmount: '99000' })] };

    const code = await award([], { from: FILE, file: requestQuoteOutput(body) });

    expect(code).toBe(EXIT_ERROR);
    expect(lines.join('\n')).toContain(
      'with no quote_id, --from from a script needs a quote request with max_source_amount',
    );
    expect(keysRead).toBe(0);
    expect(awards()).toHaveLength(0);
  });

  it('with no max_source_amount, still awards a named quote, and lets a person at a terminal pick', async () => {
    await start();
    const body = await quoteRequest(RECEIVER, 'no-cap', null);
    expect(body.max_source_amount).toBeUndefined();
    const quote = await signedQuoteFor(body, { sourceAmount: '99000' });
    listed = { quotes: [quote] };

    const named = await award([quote.quote_id], { from: FILE, file: requestQuoteOutput(body) });
    const picked = await award([], {
      from: FILE,
      file: requestQuoteOutput(body),
      interactive: true,
      answers: ['y'],
      keys: ['enter'],
    });

    expect([named, picked]).toEqual([EXIT_PENDING, EXIT_PENDING]);
    expect(awards()).toHaveLength(2);
  });

  it('--from with a quote_id awards that quote', async () => {
    await start();
    const body = await quoteRequest();
    const cheap = await signedQuoteFor(body, { sourceAmount: '99000' });
    const dear = await signedQuoteFor(body, { sourceAmount: '99500' });
    listed = { quotes: [dear, cheap] };

    const code = await award([dear.quote_id], { from: FILE, file: requestQuoteOutput(body) });

    expect(code).toBe(EXIT_PENDING);
    expect(awards()[0].body.quote_id).toBe(dear.quote_id);
  });

  // Anyone can open a quote request naming your account; --from pays only the one you opened.
  it('--from refuses the quotes of a quote request someone else opened for the same account, before reading a key', async () => {
    await start();
    const mine = await quoteRequest();
    const theirs = await quoteRequest(STRANGER, 'someone-else');
    const quote = await signedQuoteFor(theirs, { sourceAmount: '99000' });
    listed = { quotes: [quote] };

    const cheapest = await award([], { from: FILE, file: requestQuoteOutput(mine) });
    const named = await award([quote.quote_id], { from: FILE, file: requestQuoteOutput(mine) });

    expect([cheapest, named]).toEqual([EXIT_ERROR, EXIT_ERROR]);
    expect(lines.join('\n')).toContain('no quote of qr_test can be awarded');
    expect(lines.join('\n')).toContain(
      `quote ${quote.quote_id} cannot be awarded: the quote is not for this quote request`,
    );
    expect(keysRead).toBe(0);
    expect(awards()).toHaveLength(0);
  });

  it('--from re-awards the awarded quote, which the gateway answers as a replay', async () => {
    await start();
    const body = await quoteRequest();
    const cheap = await signedQuoteFor(body, { sourceAmount: '99000' });
    const dear = await signedQuoteFor(body, { sourceAmount: '99500' });
    listed = {
      quotes: [cheap, dear],
      payments: [{ quote_id: dear.quote_id, payment_id: '0xpayment' }],
    };

    const code = await award([], { from: FILE, file: requestQuoteOutput(body) });

    expect(code).toBe(EXIT_PENDING);
    expect(awards()[0].body.quote_id).toBe(dear.quote_id);
  });

  it("--from re-awards the awarded quote after its award_deadline, so the gateway's replay is reached", async () => {
    await start();
    const body = await quoteRequest();
    const expired = await signedQuoteFor(body, { sourceAmount: '99000', awardWithinSeconds: -5 });
    listed = {
      quotes: [expired],
      payments: [{ quote_id: expired.quote_id, payment_id: '0xpayment' }],
    };

    const code = await award([], { from: FILE, file: requestQuoteOutput(body) });

    expect(code).toBe(EXIT_PENDING);
    expect(awards()).toHaveLength(1);
    expect(awards()[0].body.quote_id).toBe(expired.quote_id);
  });

  it.each<[string, (body: CreateQuoteRequest) => Parameters<typeof award>, string]>([
    [
      'two ids with --from',
      (body) => [['qr_test', QUOTE_ID], { from: FILE, file: requestQuoteOutput(body) }],
      'with --from, pass at most the quote_id',
    ],
    [
      'no ids at a terminal',
      () => [[], { interactive: true }],
      'pass <quote_request_id> [quote_id], or --from <request-quote output>',
    ],
    [
      'three ids at a terminal',
      () => [['qr_test', QUOTE_ID, QUOTE_ID], { interactive: true }],
      'pass <quote_request_id> [quote_id], or --from <request-quote output>',
    ],
    [
      'a malformed quote_id with --from',
      (body) => [['0x12'], { from: FILE, file: requestQuoteOutput(body) }],
      '<quoteId> must be a 0x-prefixed 32-byte hex value, got 0x12',
    ],
  ])('refuses %s before reading anything', async (_name, args, message) => {
    await start();
    const body = await quoteRequest();
    const before = gateway.requests.length;

    const code = await award(...args(body));

    expect(code).toBe(EXIT_ERROR);
    expect(lines.join('\n')).toContain(message);
    expect(gateway.requests).toHaveLength(before);
    expect(keysRead).toBe(0);
  });

  it.each([
    ['not JSON', 'cannot read quotes.json'],
    ['{"quote_request_id":"qr_test","status":"ready"}', 'quotes.json is not request-quote output'],
  ])('--from refuses a file that is %s', async (file, message) => {
    await start();

    const code = await award([], { from: FILE, file });

    expect(code).toBe(EXIT_ERROR);
    expect(lines.join('\n')).toContain(message);
    expect(gateway.requests).toHaveLength(0);
  });

  it('a failed send after --from says how to retry with the same file and quote', async () => {
    await start(
      {
        'POST /v1/payments/awards': () => ({
          status: 503,
          body: { code: 'SERVICE_UNAVAILABLE', message: 'try again' },
        }),
      },
      true,
    );
    const body = await quoteRequest();
    const cheap = await signedQuoteFor(body, { sourceAmount: '99000' });
    listed = { quotes: [cheap] };

    const code = await award([], { from: FILE, file: requestQuoteOutput(body) });

    expect(code).toBe(EXIT_ERROR);
    expect(lines).toContain(
      `Retry this same award with: award-quote --from ${FILE} ${cheap.quote_id}`,
    );

    lines = [];
    await award([], { from: "my quotes/it's.json", file: requestQuoteOutput(body) });
    expect(lines).toContain(
      `Retry this same award with: award-quote --from 'my quotes/it'\\''s.json' ${cheap.quote_id}`,
    );
  });
});

describe('award-quote --from at a terminal', () => {
  it.each([
    ['y', EXIT_PENDING, 1, 1],
    ['n', EXIT_ERROR, 0, 0],
  ])(
    'lets the person pick, asks before paying, and %s exits %i',
    async (answer, exitCode, keys, sent) => {
      await start();
      const body = await quoteRequest();
      const cheap = await signedQuoteFor(body, { sourceAmount: '99000' });
      const dear = await signedQuoteFor(body, { sourceAmount: '99500' });
      listed = { quotes: [dear, cheap] };

      const code = await award([], {
        from: FILE,
        file: requestQuoteOutput(body),
        interactive: true,
        answers: [answer],
        keys: ['down', 'enter'],
      });

      expect(code).toBe(exitCode);
      expect(screens).toHaveLength(1);
      expect(lines.join('\n')).not.toContain('Chose quote');
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain(`to ${RECEIVER}, refundable if not delivered by `);
      expect(keysRead).toBe(keys);
      expect(awards()).toHaveLength(sent);
      if (sent) expect(awards()[0].body.quote_id).toBe(dear.quote_id);
    },
  );

  it('with a quote_id, goes straight to the pay line', async () => {
    await start();
    const body = await quoteRequest();
    const quote = await signedQuoteFor(body, { sourceAmount: '99000' });
    listed = { quotes: [quote] };

    const code = await award([quote.quote_id], {
      from: FILE,
      file: requestQuoteOutput(body),
      interactive: true,
      answers: ['y'],
      keys: [],
    });

    expect(code).toBe(EXIT_PENDING);
    expect(screens).toHaveLength(0);
  });
});

describe('award-quote <quote_request_id> at a terminal', () => {
  it('lets the person pick a quote, cheapest first, then asks before paying', async () => {
    await start();
    const body = await quoteRequest();
    const cheap = await signedQuoteFor(body, { sourceAmount: '99000' });
    const dear = await signedQuoteFor(body, { sourceAmount: '99500' });
    listed = { quotes: [dear, cheap] };

    const code = await award(['qr_test'], { interactive: true, answers: ['y'], keys: ['enter'] });

    expect(code).toBe(EXIT_PENDING);
    expect(lines).toContain(
      `2 quotes (qr_test) for 98000 units of 0x8335…2913 on eip155:8453 to ${RECEIVER}`,
    );
    expect(screens[0][1]).toMatch(/^ {2}▶ +99000 units/);
    expect(asked[0]).toContain(`to ${RECEIVER}, refundable if not delivered by `);
    expect(awards()[0].body.quote_id).toBe(cheap.quote_id);
  });

  it('asks for a number where the terminal cannot read keys one at a time', async () => {
    await start();
    const body = await quoteRequest();
    const cheap = await signedQuoteFor(body, { sourceAmount: '99000' });
    const dear = await signedQuoteFor(body, { sourceAmount: '99500' });
    listed = { quotes: [dear, cheap] };

    const code = await award(['qr_test'], { interactive: true, answers: ['2', 'y'] });

    expect(code).toBe(EXIT_PENDING);
    expect(asked[0]).toBe('Award which? [Enter = 1, q = quit] ');
    expect(awards()[0].body.quote_id).toBe(dear.quote_id);
  });

  it('q exits 1 and signs nothing', async () => {
    await start();
    const body = await quoteRequest();
    listed = { quotes: [await signedQuoteFor(body, { sourceAmount: '99000' })] };

    const code = await award(['qr_test'], { interactive: true, keys: ['quit'] });

    expect(code).toBe(EXIT_ERROR);
    expect(lines).toContain('Nothing signed.');
    expect(keysRead).toBe(0);
    expect(awards()).toHaveLength(0);
  });

  it('re-awards the awarded quote without a pick, for the gateway to replay', async () => {
    await start();
    const body = await quoteRequest();
    const cheap = await signedQuoteFor(body, { sourceAmount: '99000' });
    const dear = await signedQuoteFor(body, { sourceAmount: '99500' });
    listed = {
      quotes: [cheap, dear],
      payments: [{ quote_id: dear.quote_id, payment_id: '0xpayment' }],
    };

    const code = await award(['qr_test'], { interactive: true, answers: ['y'], keys: [] });

    expect(code).toBe(EXIT_PENDING);
    expect(screens).toHaveLength(0);
    expect(awards()[0].body.quote_id).toBe(dear.quote_id);
  });
});

describe('award-quote at a terminal', () => {
  it("awards by ids from the quote's copy of the request once the person confirms the receiver and refund time", async () => {
    await start();
    const body = await quoteRequest();
    const quote = await signedQuoteFor(body, { sourceAmount: '99000' });
    listed = { quotes: [quote] };

    const code = await award(['qr_test', quote.quote_id], { interactive: true, answers: ['y'] });

    expect(code).toBe(EXIT_PENDING);
    expect(asked[0]).toContain(
      `to ${RECEIVER}, refundable if not delivered by ${body.fulfillment_deadline} (in `,
    );
    expect(awards()[0].body.quote_id).toBe(quote.quote_id);
  });

  it('declining exits 1 and signs nothing', async () => {
    await start();
    const body = await quoteRequest();
    const quote = await signedQuoteFor(body, { sourceAmount: '99000' });
    listed = { quotes: [quote] };

    const code = await award(['qr_test', quote.quote_id], { interactive: true, answers: ['n'] });

    expect(code).toBe(EXIT_ERROR);
    expect(keysRead).toBe(0);
    expect(awards()).toHaveLength(0);
  });

  it('refuses a quote that carries no readable quote request', async () => {
    await start();
    const body = await quoteRequest();
    const quote = await signedQuoteFor(body, {
      sourceAmount: '99000',
      fields: { payment_request_json: 'not json' },
    });
    listed = { quotes: [quote] };

    const code = await award(['qr_test', quote.quote_id], { interactive: true });

    expect(code).toBe(EXIT_ERROR);
    expect(lines.join('\n')).toContain('no readable payment_request_json');
    expect(asked).toEqual([]);
  });

  it.each<[string, (body: CreateQuoteRequest) => CreateQuoteRequest, string]>([
    [
      'an escrow',
      (body) => ({ ...body, escrow_contract_address: STRANGER }),
      `its escrow_contract_address is ${STRANGER}`,
    ],
    [
      'a verifier account',
      (body) => ({
        ...body,
        fulfillment_verifier: { ...body.fulfillment_verifier, account: STRANGER },
      }),
      `its fulfillment_verifier.account is ${STRANGER}`,
    ],
    [
      'a verifier endpoint',
      (body) => ({
        ...body,
        fulfillment_verifier: { ...body.fulfillment_verifier, endpoint: 'https://other.test' },
      }),
      'its fulfillment_verifier.endpoint is https://other.test',
    ],
    [
      'a fulfillment proxy',
      (body) => ({ ...body, fulfillment_proxy: STRANGER }),
      `its fulfillment_proxy is ${STRANGER}, the gateway's on eip155:8453 is`,
    ],
  ])(
    "refuses a quote request naming %s other than the gateway's, before showing any quote",
    async (_name, change, message) => {
      await start();
      const quote = await signedQuoteFor(change(await quoteRequest()), { sourceAmount: '99000' });
      listed = { quotes: [quote] };

      const code = await award(['qr_test'], { interactive: true, keys: ['enter'] });

      expect(code).toBe(EXIT_ERROR);
      expect(lines.join('\n')).toContain('quote request qr_test cannot be awarded here: its ');
      expect(lines.join('\n')).toContain(message);
      expect(screens).toHaveLength(0);
      expect(asked).toEqual([]);
      expect(keysRead).toBe(0);
      expect(awards()).toHaveLength(0);
    },
  );
});

describe('contractsProblem on Tron, where /v1/defaults lists base58', () => {
  const TRON_SOURCE = 'tron:shasta/trc20:TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs';
  const evm = (byte: string) => '0x' + byte.repeat(20);

  beforeEach(() =>
    start({
      'GET /v1/defaults': (req) => ({
        body: {
          chain_id: req.query.chain_id,
          escrow_contract: tronBase58(evm('11')),
          quote_selector: tronBase58(evm('33')),
          fulfillment_proxy: tronBase58(evm('22')),
          fulfillment_verifier: {
            account: tronBase58(evm('44')),
            endpoint: 'https://verifier.test',
          },
        },
      }),
    }),
  );

  it('accepts the quote request request-quote opens, and the escrow in either form', async () => {
    const body = await client.prepareQuoteRequest({
      depositor: tronBase58(depositor.address),
      fulfillmentAmount: '98000',
      sourceAsset: TRON_SOURCE,
      destinationAccount: RECEIVER,
      destinationAsset: DEST_ASSET,
      requestId: 'tron-contracts',
    });
    const defaults = await client.fetchChainDefaults('tron:shasta');
    const destination = await client.fetchChainDefaults('eip155:8453');
    const toTron = {
      ...body,
      destination: [{ asset_identifier: TRON_SOURCE, account: tronBase58(evm('77')) }],
    };

    expect(body.fulfillment_verifier.account).toBe(evm('44'));
    expect(contractsProblem(body, defaults, destination)).toBeUndefined();
    expect(
      contractsProblem({ ...body, escrow_contract_address: evm('11') }, defaults, destination),
    ).toBeUndefined();
    expect(contractsProblem({ ...toTron, fulfillment_proxy: evm('22') }, defaults, defaults)).toBe(
      undefined,
    );
    expect(
      contractsProblem(
        { ...body, escrow_contract_address: tronBase58(STRANGER) },
        defaults,
        destination,
      ),
    ).toContain(`its escrow_contract_address is ${tronBase58(STRANGER)}`);
  });
});
