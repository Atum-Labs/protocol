import type { AwardedQuote, CreateQuoteRequest } from '../generated/types.gen';
import { describePayment, formatQuoteStatus, formatQuoteTable, sortQuotes } from './quote-table';
import { tokenKey } from './token-amount';

const NOW = Date.parse('2026-11-09T12:00:00Z');

function quote(id: string, amount: string, deadlineInSeconds: number, awarded?: string) {
  return {
    quote_id: '0x' + id.repeat(32),
    awarded_payment_id: awarded ?? null,
    fulfillment_quote: {
      source_amount: amount,
      settler_address: '0x5A1100000000000000000000000000000000Ab02',
      award_deadline: new Date(NOW + deadlineInSeconds * 1000).toISOString(),
    },
  } as AwardedQuote;
}

const rows = (table: string) => table.split('\n').map((line) => line.trim().split(/\s{2,}/));

describe('the quote table', () => {
  it('lists the cheapest first, and quotes with an amount signing refuses last', () => {
    const sorted = sortQuotes([
      quote('aa', '100980', 60),
      quote('bb', 'not a number', 60),
      quote('cc', '100150', 60),
      quote('dd', '0x10', 60),
      quote('ee', '100420', 60),
      quote('ff', ' 5 ', 60),
    ]);

    expect(sorted.map((q) => q.fulfillment_quote.source_amount)).toEqual([
      '100150',
      '100420',
      '100980',
      'not a number',
      '0x10',
      ' 5 ',
    ]);
  });

  it('puts the quote held longer first at the same price', () => {
    const sorted = sortQuotes([
      quote('aa', '100150', 30),
      quote('bb', '100150', 90),
      quote('cc', '100100', 10),
    ]);

    expect(sorted.map((q) => q.quote_id.slice(2, 4))).toEqual(['cc', 'bb', 'aa']);
  });

  it('numbers the rows, shows amounts in units, and keeps the full quote_id', () => {
    const table = rows(formatQuoteTable([quote('e2', '100150', 117)], NOW));

    expect(table[0]).toEqual(['#', 'you pay', 'settler', 'award within', 'quote']);
    expect(table[1]).toEqual([
      '1',
      '100150 units',
      '0x5A11…Ab02',
      '1m 57s',
      '0x' + 'e2'.repeat(32),
    ]);
  });

  it('counts the award window down, and says expired once it has passed', () => {
    const table = rows(
      formatQuoteTable(
        [quote('a1', '1', 45), quote('a2', '1', 3725), quote('a3', '1', 0), quote('a4', '1', -5)],
        NOW,
      ),
    );

    expect(table.slice(1).map((row) => row[3])).toEqual(['45s', '1h 2m', 'expired', 'expired']);
  });

  it('marks the awarded quote instead of its window', () => {
    const table = rows(formatQuoteTable([quote('a1', '1', 60, '0x' + '99'.repeat(32))], NOW));

    expect(table[1][3]).toBe('awarded');
  });
});

describe('quote-status at a terminal', () => {
  it('shows the status, the quotes cheapest first, and how to award one', () => {
    const lines = formatQuoteStatus(
      'qr_test',
      {
        quote_request_id: 'qr_test',
        status: 'ready',
        quotes: [quote('dd', '100420', 60), quote('cc', '100150', 60)],
      },
      NOW,
    );

    expect(lines[0]).toBe('ready · 2 quotes');
    expect(rows(lines[2]).map((row) => row[1])).toEqual([
      'you pay',
      '100150 units',
      '100420 units',
    ]);
    expect(lines.at(-1)).toBe('Award one with: award-quote qr_test');
  });

  it('names the payment of an awarded quote request and offers no award', () => {
    const paid = '0x' + '77'.repeat(32);
    const lines = formatQuoteStatus(
      'qr_test',
      {
        quote_request_id: 'qr_test',
        status: 'awarded',
        quotes: [quote('cc', '100150', 60, paid)],
        payments: [{ quote_id: '0x' + 'cc'.repeat(32), payment_id: paid }],
      },
      NOW,
    );

    expect(lines[0]).toBe(`awarded · 1 quote · awarded to payment ${paid}`);
    expect(rows(lines[2])[1][3]).toBe('awarded');
    expect(lines.join('\n')).not.toContain('Award one with');
  });

  it('shows only the status while no quote has arrived', () => {
    expect(
      formatQuoteStatus(
        'qr_test',
        { quote_request_id: 'qr_test', status: 'collecting', quotes: [] },
        NOW,
      ),
    ).toEqual(['collecting · 0 quotes']);
  });

  it("puts the quote request's error under an empty batch's header", () => {
    const message =
      'No capacity was available to start an auction for this request. This request_id is spent, so a new attempt needs a new one.';
    expect(
      formatQuoteStatus(
        'qr_test',
        {
          quote_request_id: 'qr_test',
          status: 'ready',
          quotes: [],
          error: { code: 'SERVICE_BUSY', message },
        },
        NOW,
      ),
    ).toEqual(['ready · 0 quotes · SERVICE_BUSY', message]);
  });
});

describe('the payment a person confirms', () => {
  const receiver = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
  const request = {
    source: {
      asset_identifier: 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    },
    destination: [
      {
        asset_identifier: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        account: receiver,
      },
    ],
    fulfillment_amount: '100000',
    fulfillment_deadline: '2026-11-09T12:10:00Z',
  } as CreateQuoteRequest;

  it('names both amounts in units, both chains as CAIP-2, the receiver in full, and when it refunds', () => {
    expect(describePayment(request, quote('e2', '100150', 60), NOW)).toBe(
      `Pay 100150 units of 0xaf88…5831 on eip155:42161 → 100000 units of 0x8335…2913 on ` +
        `eip155:8453 to ${receiver}, refundable if not delivered by 2026-11-09T12:10:00Z (in 10m 0s)`,
    );
  });

  it.each([
    ['weeks away, in days', '2026-11-30T13:00:00Z', 'by 2026-11-30T13:00:00Z (in 21d 1h)'],
    ['already passed', '2026-11-09T11:59:59Z', 'by 2026-11-09T11:59:59Z (passed)'],
    ['not a timestamp', 'soon', 'by soon'],
  ])('shows a fulfillment_deadline %s', (_name, deadline, shown) => {
    const line = describePayment(
      { ...request, fulfillment_deadline: deadline },
      quote('e2', '100150', 60),
      NOW,
    );

    expect(line.endsWith(`, refundable if not delivered ${shown}`)).toBe(true);
  });

  it('reads both amounts as tokens where they are listed, keeping the units', () => {
    const tokens = new Map([
      [tokenKey(request.source.asset_identifier), { symbol: 'USDC', decimals: 6 }],
      [tokenKey(request.destination[0].asset_identifier), { symbol: 'USDC', decimals: 6 }],
    ]);

    expect(describePayment(request, quote('e2', '100150', 60), NOW, tokens)).toBe(
      'Pay 0.10015 USDC (100150 units) on eip155:42161 → 0.1 USDC (100000 units) on ' +
        `eip155:8453 to ${receiver}, refundable if not delivered by 2026-11-09T12:10:00Z (in 10m 0s)`,
    );
  });

  it('shows control characters in the receiver as ?', () => {
    const odd = {
      ...request,
      destination: [{ ...request.destination[0], account: `${receiver}\r\u001b[2K0x1234` }],
    };

    expect(describePayment(odd, quote('e2', '100150', 60), NOW)).toContain(
      `to ${receiver}??[2K0x1234, refundable`,
    );
  });
});
