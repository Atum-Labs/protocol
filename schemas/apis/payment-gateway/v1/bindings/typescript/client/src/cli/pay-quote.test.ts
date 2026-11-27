// Picking and paying a quote at a terminal, in-process: a scripted terminal, the real client and
// signers, and the contract-checked fake gateway.
import { ethers } from 'ethers';
import { PaymentGatewayClient } from '../index';
import type { AwardedQuote, CreateQuoteRequest, CreateQuoteRequestResponse } from '../index';
import { startFakeGateway, type FakeGateway, type Responder } from '../test-support/fake-gateway';
import { signedQuoteFor, TEST_SETTLER, tronBase58 } from '../test-support/quotes';
import { EXIT_ERROR, EXIT_PENDING } from './payment-outcome';
import {
  batchQuoteRequest,
  offerQuotes,
  payQuote,
  quoteProblem,
  settlerProblem,
} from './pay-quote';
import type { SelectorKey } from './quote-selector';
import type { Terminal } from './terminal';
import { tokenKey, type TokenInfos } from './token-amount';
import { scriptedChoose } from '../test-support/terminal';

const depositor = new ethers.Wallet(ethers.id('pay-quote test depositor'));
const other = new ethers.Wallet(ethers.id('pay-quote test other account'));
const SOURCE_ASSET = 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const DEST_ASSET = 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RECEIVER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

/** What happened at the terminal, in order: questions asked, lines written, keys read. */
type Event = { ask: string } | { write: string } | { key: true };

/**
 * Answers in order; an Error is a question cancelled (closed stdin or Ctrl-C). With `keys`, the
 * terminal reads keys one at a time and the quotes are picked with them.
 */
function scriptedTerminal(
  answers: (string | Error)[],
  keys?: SelectorKey[],
  screens: string[][] = [],
): { terminal: Terminal; events: Event[] } {
  const events: Event[] = [];
  return {
    events,
    terminal: {
      ...(keys ? { choose: scriptedChoose(keys, screens) } : {}),
      interactive: true,
      write: (line) => events.push({ write: line }),
      ask: async (question) => {
        events.push({ ask: question });
        const answer = answers.shift();
        if (answer === undefined) throw new Error(`unexpected question: ${question}`);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

const written = (events: Event[]) =>
  events.flatMap((e) => ('write' in e ? [e.write] : [])).join('\n');
const asked = (events: Event[]) => events.flatMap((e) => ('ask' in e ? [e.ask] : []));

describe('paying a quote at a terminal', () => {
  let gateway: FakeGateway;
  let client: PaymentGatewayClient;
  /** Settler-signed quotes for the test's quote request, the cheap one first. */
  let cheap: AwardedQuote;
  let dear: AwardedQuote;

  // An error body is not the route's success schema, so a test serving one opts out of the check.
  async function start(responders: Record<string, Responder> = {}, servesErrors = false) {
    gateway = await startFakeGateway({ responders, allowInvalidResponses: servesErrors });
    client = new PaymentGatewayClient({ BASE: gateway.url });
  }

  afterEach(async () => {
    await gateway?.close();
  });

  async function quoteRequest(quoteSelector?: string): Promise<CreateQuoteRequest> {
    const body = await client.prepareQuoteRequest({
      depositor: depositor.address,
      fulfillmentAmount: '98000',
      sourceAsset: SOURCE_ASSET,
      destinationAccount: RECEIVER,
      destinationAsset: DEST_ASSET,
      maxSourceAmount: '100000',
      requestId: 'pay-quote-test',
      quoteSelector,
    });
    cheap = await signedQuoteFor(body, { sourceAmount: '99000' });
    dear = await signedQuoteFor(body, { sourceAmount: '99500' });
    return body;
  }

  /** A collected response holding a dearer quote first, as a gateway may list them. */
  function collected(quotes: AwardedQuote[] = [dear, cheap]): CreateQuoteRequestResponse {
    return { quote_request_id: 'qr_test', status: 'ready', idempotent_replay: false, quotes };
  }

  function offer(
    body: CreateQuoteRequest,
    answers: (string | Error)[],
    response = collected(),
    picker: { keys?: SelectorKey[]; screens?: string[][]; tokens?: TokenInfos } = {},
  ) {
    const { terminal, events } = scriptedTerminal(answers, picker.keys, picker.screens);
    const run = offerQuotes({
      client,
      terminal,
      quoteRequest: body,
      response,
      tokens: picker.tokens,
      readPrivateKey: async () => {
        events.push({ key: true });
        return depositor.privateKey;
      },
    });
    return { run, events };
  }

  const awards = () =>
    gateway.received('POST', '/v1/payments/awards') as Array<{
      body: {
        quote_id: string;
        sender_auth: { signed_messages: { message: string; signature: string }[] };
      };
      violation?: string;
    }>;

  it('Enter awards the cheapest quote, signed by the depositor', async () => {
    await start();
    const body = await quoteRequest();

    const { run } = offer(body, ['', 'y']);

    await expect(run).resolves.toBe(EXIT_PENDING);
    expect(awards()).toHaveLength(1);
    expect(awards()[0].violation).toBeUndefined();
    expect(awards()[0].body.quote_id).toBe(cheap.quote_id);
    const deposit = awards()[0].body.sender_auth.signed_messages[0];
    expect(ethers.recoverAddress(deposit.message, deposit.signature)).toBe(depositor.address);
  });

  it('a number picks that row of the table, and an out-of-range one is asked again', async () => {
    await start();
    const body = await quoteRequest();

    const { run, events } = offer(body, ['7', '2', 'y']);

    await expect(run).resolves.toBe(EXIT_PENDING);
    expect(awards()[0].body.quote_id).toBe(dear.quote_id);
    expect(written(events)).toContain('Type a number from 1 to 2, or q.');
  });

  it('q signs nothing, posts no award, and says how to award later', async () => {
    await start();
    const body = await quoteRequest();

    const { run, events } = offer(body, ['q']);

    await expect(run).resolves.toBe(0);
    expect(awards()).toHaveLength(0);
    expect(events).not.toContainEqual({ key: true });
    expect(written(events)).toContain('Nothing signed. Award later with: award-quote qr_test');
  });

  describe('with the arrow keys', () => {
    it('shows the quotes cheapest first and awards the one the person moves to', async () => {
      await start();
      const body = await quoteRequest();
      const screens: string[][] = [];

      const { run, events } = offer(body, ['y'], collected(), {
        keys: ['down', 'enter'],
        screens,
      });

      await expect(run).resolves.toBe(EXIT_PENDING);
      expect(awards()[0].body.quote_id).toBe(dear.quote_id);
      expect(screens[0][1]).toMatch(/^ {2}▶ +99000 units/);
      expect(screens[0][2]).toMatch(/^ {5}99500 units/);
      expect(asked(events)).toHaveLength(1);
      expect(asked(events)[0]).toContain(`to ${RECEIVER}, refundable if not delivered by `);
      expect(written(events)).not.toContain('Award which?');
    });

    it('reads amounts as tokens in the header, the table and the pay line', async () => {
      await start();
      const body = await quoteRequest();
      const usdc = { symbol: 'USDC', decimals: 6 };
      const tokens = new Map([
        [tokenKey(SOURCE_ASSET), usdc],
        [tokenKey(DEST_ASSET), usdc],
      ]);
      const screens: string[][] = [];

      const { run, events } = offer(body, ['n'], collected(), {
        keys: ['enter'],
        screens,
        tokens,
      });

      await expect(run).resolves.toBe(0);
      expect(written(events)).toContain(
        `2 quotes (qr_test) for 0.098 USDC (98000 units) on eip155:8453 to ${RECEIVER}`,
      );
      expect(screens[0][1]).toContain('0.099 USDC (99000 units)');
      expect(asked(events)[0]).toMatch(/^Pay 0\.099 USDC \(99000 units\) on eip155:42161 → /);
    });

    it('q signs nothing and says how to award later', async () => {
      await start();
      const body = await quoteRequest();

      const { run, events } = offer(body, [], collected(), { keys: ['quit'] });

      await expect(run).resolves.toBe(0);
      expect(awards()).toHaveLength(0);
      expect(events).not.toContainEqual({ key: true });
      expect(written(events)).toContain('Nothing signed. Award later with: award-quote qr_test');
    });

    it('says so when every quote expired before one was picked, and signs nothing', async () => {
      await start();
      const body = await quoteRequest();
      const soon = await signedQuoteFor(body, { sourceAmount: '99000', awardWithinSeconds: 1 });
      const { terminal, events } = scriptedTerminal([]);
      terminal.choose = async (selector) => selector.tick(Date.now() + 2_000);

      const code = await offerQuotes({
        client,
        terminal,
        quoteRequest: body,
        response: collected([soon]),
      });

      expect(code).toBe(0);
      expect(written(events)).toContain('All quotes expired. Nothing signed.');
      expect(written(events)).toContain('Request new quotes to pay.');
      expect(awards()).toHaveLength(0);
    });
  });

  it.each([
    ['no', 'n'],
    ['an empty answer', ''],
  ])('%s at the confirm posts no award and never asks for a key', async (_label, answer) => {
    await start();
    const body = await quoteRequest();

    const { run, events } = offer(body, ['', answer]);

    await expect(run).resolves.toBe(0);
    expect(awards()).toHaveLength(0);
    expect(events).not.toContainEqual({ key: true });
    expect(written(events)).toContain('Nothing signed.');
  });

  it('a question cancelled by a closed stdin or Ctrl-C signs nothing', async () => {
    await start();
    const body = await quoteRequest();
    const cancelled = () => new Error('cancelled before an answer: nothing signed');

    const atPick = offer(body, [cancelled()]);
    await expect(atPick.run).rejects.toThrow('nothing signed');

    const atConfirm = offer(body, ['', cancelled()]);
    await expect(atConfirm.run).resolves.toBe(EXIT_ERROR);
    expect(written(atConfirm.events)).not.toContain('Retry');

    expect(awards()).toHaveLength(0);
    expect([...atPick.events, ...atConfirm.events]).not.toContainEqual({ key: true });
  });

  it('leaves out a quote whose settler signature does not verify', async () => {
    await start();
    const body = await quoteRequest();
    const forged = {
      ...cheap,
      fulfillment_quote: { ...cheap.fulfillment_quote, source_amount: '98500' },
    };

    const { run, events } = offer(body, ['', 'y'], collected([forged, dear, cheap]));

    await expect(run).resolves.toBe(EXIT_PENDING);
    expect(written(events)).toContain(`Left out quote 0x${cheap.quote_id.slice(2, 6)}…`);
    expect(written(events)).toContain('2 quotes (qr_test)');
    expect(awards()[0].body.quote_id).toBe(cheap.quote_id);
  });

  it('refuses a quote whose quote_id is not its hash, before asking anything', async () => {
    await start();
    const body = await quoteRequest();
    const { terminal, events } = scriptedTerminal([]);

    const code = await payQuote({
      client,
      terminal,
      quoteRequestId: 'qr_test',
      quoteRequest: body,
      quote: { ...cheap, quote_id: dear.quote_id },
      confirm: true,
      readPrivateKey: async () => {
        events.push({ key: true });
        return depositor.privateKey;
      },
    });

    expect(code).toBe(EXIT_ERROR);
    expect(asked(events)).toEqual([]);
    expect(events).not.toContainEqual({ key: true });
    expect(written(events)).toContain(`quote ${dear.quote_id} cannot be awarded`);
    expect(awards()).toHaveLength(0);
  });

  it('asks for the key only after the person confirmed what is paid', async () => {
    await start();
    const body = await quoteRequest();

    const { run, events } = offer(body, ['', 'y']);
    await run;

    const confirm = events.findIndex((e) => 'ask' in e && e.ask.startsWith('Pay '));
    expect(confirm).toBeGreaterThan(-1);
    expect(events.findIndex((e) => 'key' in e)).toBeGreaterThan(confirm);
    const line = asked(events)[1];
    const prefix =
      `Pay 99000 units of 0xaf88…5831 on eip155:42161 → 98000 units of 0x8335…2913 on ` +
      `eip155:8453 to ${RECEIVER}, refundable if not delivered by ${body.fulfillment_deadline} (in `;
    expect(line.slice(0, prefix.length)).toBe(prefix);
    expect(line.slice(prefix.length)).toMatch(/^\d+m \d+s\)\? \[y\/N\] $/);
  });

  it('says there are no quotes, with the reasons settlers gave', async () => {
    await start();
    const body = await quoteRequest();

    const { run, events } = offer(body, [], {
      ...collected([]),
      decline_summary: [{ reason: 'INSUFFICIENT_LIQUIDITY', count: 2 }],
    });

    await expect(run).resolves.toBe(0);
    expect(written(events)).toBe(
      'No quotes for qr_test. Declined: INSUFFICIENT_LIQUIDITY (2). Try again, or raise --max-source-amount.',
    );
  });

  it('says why there are no quotes when the quote request names a reason, and does not say to try again', async () => {
    await start();
    const body = await quoteRequest();
    const message =
      'No settlement provider currently serves this source and destination pair. This request_id is spent, so a new attempt needs a new one, and it will not succeed until a provider covers the pair.';

    const { run, events } = offer(body, [], {
      ...collected([]),
      requested_count: 0,
      error: { code: 'NO_SETTLER_FOR_CORRIDOR', message },
    });

    await expect(run).resolves.toBe(0);
    expect(written(events)).toBe(`No quotes for qr_test: NO_SETTLER_FOR_CORRIDOR. ${message}`);
  });

  it('points to quote-status while quotes are still being collected', async () => {
    await start();
    const body = await quoteRequest();

    const { run, events } = offer(body, [], {
      quote_request_id: 'qr_test',
      status: 'collecting',
      idempotent_replay: false,
    });

    await expect(run).resolves.toBe(0);
    expect(written(events)).toContain('quote-status qr_test');
  });

  it("refuses a quote whose signer the quote request's settler_requirements do not admit", async () => {
    await start();
    const signer = `did:pkh:eip155:1:${TEST_SETTLER.address.toLowerCase()}`;
    const withList = async (whitelist: string[]) => {
      const body = { ...(await quoteRequest()), settler_requirements: { whitelist } };
      const quote = await signedQuoteFor(body, { sourceAmount: '99000' });
      return quoteProblem('qr_test', body, quote, Date.now());
    };

    await expect(
      withList([`did:pkh:eip155:42161:${TEST_SETTLER.address}`]),
    ).resolves.toBeUndefined();
    await expect(withList([`did:pkh:eip155:42161:${other.address}`])).resolves.toBe(
      `its signer ${signer} is not in settler_requirements.whitelist`,
    );
  });

  it('refuses a quote request that names another account as selector, before asking anything', async () => {
    await start();
    const body = await quoteRequest(other.address);
    const { terminal, events } = scriptedTerminal([]);

    const code = await payQuote({
      client,
      terminal,
      quoteRequestId: 'qr_test',
      quoteRequest: body,
      quote: cheap,
      confirm: true,
      readPrivateKey: async () => {
        events.push({ key: true });
        return depositor.privateKey;
      },
    });

    expect(code).toBe(EXIT_ERROR);
    expect(asked(events)).toEqual([]);
    expect(events).not.toContainEqual({ key: true });
    expect(written(events)).toContain('Awarding for another account needs the SDK');
    expect(awards()).toHaveLength(0);
  });

  it('an already awarded quote request names its payment and offers no retry', async () => {
    const paid = '0x' + '77'.repeat(32);
    await start(
      {
        'POST /v1/payments/awards': () => ({
          status: 409,
          body: { code: 'QUOTE_REQUEST_ALREADY_AWARDED', message: 'already awarded' },
        }),
        'GET /v1/payments/quote-requests/{quoteRequestId}': () => ({
          body: {
            quote_request_id: 'qr_test',
            status: 'awarded',
            quotes: [],
            payments: [{ quote_id: dear.quote_id, payment_id: paid }],
          },
        }),
      },
      true,
    );
    const body = await quoteRequest();

    const { run, events } = offer(body, ['', 'y']);

    await expect(run).resolves.toBe(EXIT_ERROR);
    expect(written(events)).toContain(
      `qr_test already awarded quote ${dear.quote_id} (payment ${paid}). Open a new quote request to pay again.`,
    );
    expect(written(events)).not.toContain('Retry');
  });

  it('a failed send says how to retry the same award', async () => {
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

    const { run, events } = offer(body, ['', 'y']);

    await expect(run).resolves.toBe(EXIT_ERROR);
    expect(written(events)).toContain('SERVICE_UNAVAILABLE: try again');
    expect(written(events)).toContain(
      `Retry this same award with: award-quote qr_test ${cheap.quote_id}`,
    );
  });

  it('prints the payment JSON for a script, and only the summary for a person', async () => {
    await start();
    const body = await quoteRequest();
    const out: string[] = [];
    const pay = (interactive: boolean) =>
      payQuote({
        client,
        terminal: { ...scriptedTerminal(['y']).terminal, interactive },
        quoteRequestId: 'qr_test',
        quoteRequest: body,
        quote: cheap,
        confirm: interactive,
        readPrivateKey: async () => depositor.privateKey,
        writeOut: (line) => out.push(line),
      });

    await pay(true);
    expect(out).toEqual([]);
    await pay(false);
    expect(JSON.parse(out.join('\n')).payment_id).toBe('0xpayment');
  });
});

describe('batchQuoteRequest', () => {
  const sent = {
    request_id: 'quote-again',
    quote_deadline: '2026-11-09T12:10:05.000Z',
    fulfillment_deadline: '2026-11-09T12:20:05.000Z',
    fulfillment_amount: '98000',
  } as CreateQuoteRequest;
  const reply = (fields: Partial<CreateQuoteRequestResponse>) =>
    ({ quote_request_id: 'qr_test', status: 'ready', ...fields }) as CreateQuoteRequestResponse;

  it('keeps the body this run sent when the batch is new', () => {
    const response = reply({
      idempotent_replay: false,
      quote_deadline: '2026-11-09T12:00:05Z',
      fulfillment_deadline: '2026-11-09T12:10:05Z',
    });

    expect(batchQuoteRequest(sent, response)).toBe(sent);
  });

  it("takes the batch's own deadlines on a re-sent request_id, and keeps every other field", () => {
    const response = reply({
      idempotent_replay: true,
      quote_deadline: '2026-11-09T12:00:05Z',
      fulfillment_deadline: '2026-11-09T12:10:05Z',
    });

    expect(batchQuoteRequest(sent, response)).toEqual({
      ...sent,
      quote_deadline: '2026-11-09T12:00:05Z',
      fulfillment_deadline: '2026-11-09T12:10:05Z',
    });
  });

  it.each([
    ['gives no deadlines', {}, 'the reply does not give its deadlines'],
    [
      'gives a deadline that is not a timestamp',
      { quote_deadline: 'soon', fulfillment_deadline: '2026-11-09T12:10:05Z' },
      'the reply does not give its deadlines',
    ],
    [
      'gives a fulfillment_deadline later than this run would set',
      { quote_deadline: '2026-11-09T12:00:05Z', fulfillment_deadline: '2026-11-09T12:20:06Z' },
      'its deadlines are later than this run would set',
    ],
    [
      'gives a quote_deadline later than this run would set',
      { quote_deadline: '2026-11-09T12:10:06Z', fulfillment_deadline: '2026-11-09T12:10:07Z' },
      'its deadlines are later than this run would set',
    ],
  ])('refuses a re-sent request_id whose reply %s', (_name, deadlines, reason) => {
    expect(() => batchQuoteRequest(sent, reply({ idempotent_replay: true, ...deadlines }))).toThrow(
      `request_id quote-again already opened quote request qr_test, and ${reason}. ` +
        'Award its quotes at a terminal with: award-quote qr_test',
    );
  });
});

describe('settlerProblem', () => {
  const settler = TEST_SETTLER.address;
  const another = '0x5A1100000000000000000000000000000000Ab02';
  const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  const SOLANA_SETTLER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const sources = {
    evm: SOURCE_ASSET,
    tron: 'tron:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    solana: `${SOLANA}/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`,
  };
  const evmSigner = `did:pkh:eip155:1:${settler.toLowerCase()}`;
  const tronSigner = `did:pkh:tron:mainnet:${tronBase58(settler)}`;
  const solanaSigner = `did:pkh:${SOLANA}:${SOLANA_SETTLER}`;
  const body = (
    source: keyof typeof sources,
    lists: { readonly whitelist?: readonly string[]; readonly blacklist?: readonly string[] },
  ) =>
    ({
      source: { asset_identifier: sources[source], account: depositor.address },
      settler_requirements: lists,
    }) as CreateQuoteRequest;

  it.each([
    ['no lists', 'evm', evmSigner, {}],
    ['empty lists', 'evm', evmSigner, { whitelist: [], blacklist: [] }],
    [
      'the signer on the source chain, checksummed',
      'evm',
      evmSigner,
      { whitelist: [`did:pkh:eip155:42161:${settler}`] },
    ],
    [
      'the signer, namespace in capitals',
      'evm',
      evmSigner,
      { whitelist: [`did:pkh:EIP155:42161:${settler.toLowerCase()}`] },
    ],
    [
      'a blacklist naming another settler',
      'evm',
      evmSigner,
      { blacklist: [`did:pkh:eip155:42161:${another}`] },
    ],
    [
      'a Tron signer on an EVM source',
      'evm',
      tronSigner,
      { whitelist: [`did:pkh:eip155:42161:${settler}`] },
    ],
    [
      'an EVM signer on a Tron source, listed in base58',
      'tron',
      evmSigner,
      { whitelist: [`did:pkh:tron:mainnet:${tronBase58(settler)}`] },
    ],
    [
      'a Tron signer listed in hex',
      'tron',
      tronSigner,
      { whitelist: [`did:pkh:tron:mainnet:${settler}`] },
    ],
    ['a Solana signer on its own cluster', 'solana', solanaSigner, { whitelist: [solanaSigner] }],
  ] as const)('admits %s', (_name, source, signer, lists) => {
    expect(settlerProblem(body(source, lists), signer)).toBeUndefined();
  });

  it.each([
    [
      'another settler',
      'evm',
      evmSigner,
      { whitelist: [`did:pkh:eip155:42161:${another}`] },
      'is not in settler_requirements.whitelist',
    ],
    [
      'the signer on another chain',
      'evm',
      evmSigner,
      { whitelist: [`did:pkh:eip155:1:${settler}`] },
      'is not in settler_requirements.whitelist',
    ],
    [
      'a blacklisted signer',
      'evm',
      evmSigner,
      { blacklist: [`did:pkh:eip155:42161:${settler.toLowerCase()}`] },
      'is in settler_requirements.blacklist',
    ],
    [
      'a blacklisted Tron signer in hex',
      'tron',
      evmSigner,
      { blacklist: [`did:pkh:tron:mainnet:${settler}`] },
      'is in settler_requirements.blacklist',
    ],
    [
      'a Solana signer of another cluster',
      'solana',
      `did:pkh:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${SOLANA_SETTLER}`,
      { whitelist: [solanaSigner] },
      `has no account on ${SOLANA} for settler_requirements to match`,
    ],
    [
      'an EVM signer on a Solana source',
      'solana',
      evmSigner,
      { blacklist: [`did:pkh:${SOLANA}:${another}`] },
      `has no account on ${SOLANA} for settler_requirements to match`,
    ],
  ] as const)('refuses %s', (_name, source, signer, lists, reason) => {
    expect(settlerProblem(body(source, lists), signer)).toBe(`its signer ${signer} ${reason}`);
  });
});
