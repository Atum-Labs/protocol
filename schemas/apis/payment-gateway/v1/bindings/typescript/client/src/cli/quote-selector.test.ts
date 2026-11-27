import type { AwardedQuote } from '../generated/types.gen';
import { createQuoteSelector, type SelectorKey } from './quote-selector';
import { tokenKey } from './token-amount';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const SOURCE = 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

function quote(id: string, amount: string, deadlineInSeconds: number, awarded?: string) {
  return {
    quote_id: '0x' + id.repeat(32),
    awarded_payment_id: awarded ?? null,
    fulfillment_quote: {
      source_amount: amount,
      source: { id: SOURCE },
      settler_address: '0x5A1100000000000000000000000000000000Ab02',
      award_deadline: new Date(NOW + deadlineInSeconds * 1000).toISOString(),
    },
  } as AwardedQuote;
}

const A = quote('aa', '100150', 60);
const B = quote('bb', '100420', 30);
const C = quote('cc', '100980', 90);

function pressAll(keys: SelectorKey[], quotes = [A, B, C], at = NOW) {
  const selector = createQuoteSelector(quotes, NOW);
  for (const key of keys) selector.press(key, at);
  return selector;
}

const cursorRow = (lines: string[]) => lines.findIndex((line) => line.startsWith('  ▶'));

describe('the quote selector', () => {
  it('starts on the first quote, and Enter awards it', () => {
    const selector = pressAll(['enter']);

    expect(selector.state).toBe('chosen');
    expect(selector.chosen).toBe(A);
  });

  it('moves with ↓ and ↑, and stops at either end', () => {
    expect(pressAll(['down', 'enter']).chosen).toBe(B);
    expect(pressAll(['down', 'down', 'down', 'down', 'enter']).chosen).toBe(C);
    expect(pressAll(['up', 'enter']).chosen).toBe(A);
    expect(pressAll(['down', 'down', 'up', 'enter']).chosen).toBe(B);
  });

  it('jumps to a row by its number, and ignores a number with no row', () => {
    expect(pressAll(['3', 'enter']).chosen).toBe(C);
    expect(pressAll(['2', '9', 'enter']).chosen).toBe(B);
  });

  it('quits with nothing chosen, and takes no key after', () => {
    const selector = pressAll(['quit', 'enter']);

    expect(selector.state).toBe('quit');
    expect(selector.chosen).toBeUndefined();
  });

  it('skips an expired quote when moving, and refuses to jump to one', () => {
    const later = NOW + 45_000; // B expired, A and C open
    expect(pressAll(['down', 'enter'], undefined, later).chosen).toBe(C);
    expect(pressAll(['2', 'enter'], undefined, later).chosen).toBe(A);
  });

  it('moves the cursor off a quote that expires under it, to the next one, else the one before', () => {
    const toNext = createQuoteSelector([A, B, C], NOW);
    toNext.press('down', NOW);
    toNext.tick(NOW + 45_000);
    toNext.press('enter', NOW + 45_000);
    expect(toNext.chosen).toBe(C);

    const toPrevious = createQuoteSelector([C, B], NOW);
    toPrevious.press('down', NOW);
    toPrevious.tick(NOW + 45_000);
    toPrevious.press('enter', NOW + 45_000);
    expect(toPrevious.chosen).toBe(C);
  });

  it('ignores an Enter that lands after the highlighted quote expired, until the new row is shown', () => {
    const selector = createQuoteSelector([A, B, C], NOW);
    selector.press('down', NOW);

    selector.press('enter', NOW + 45_000);
    expect(selector.state).toBe('open');
    expect(cursorRow(selector.render(NOW + 45_000))).toBe(3);

    selector.press('enter', NOW + 45_000);
    expect(selector.chosen).toBe(C);
  });

  it('ends when every quote has expired, and Enter then awards nothing', () => {
    const selector = createQuoteSelector([A, B], NOW);
    selector.press('enter', NOW + 61_000);

    expect(selector.state).toBe('all-expired');
    expect(selector.chosen).toBeUndefined();
    expect(createQuoteSelector([A], NOW + 61_000).state).toBe('all-expired');
  });

  it('keeps an awarded quote open past its deadline, as the retry of its award', () => {
    const awarded = quote('dd', '100150', -60, '0x' + '77'.repeat(32));

    expect(pressAll(['enter'], [awarded]).chosen).toBe(awarded);
  });

  it('draws the cursor, the countdown, the selected quote_id and the keys', () => {
    const selector = createQuoteSelector([A, B, C], NOW);
    selector.press('down', NOW);
    const lines = selector.render(NOW + 31_000);

    expect(lines[0].trim().split(/\s{2,}/)).toEqual(['you pay', 'settler', 'award within']);
    expect(cursorRow(lines)).toBe(2);
    expect(
      lines.slice(1, 4).map((line) =>
        line
          .trim()
          .split(/\s{2,}/)
          .at(-1),
      ),
    ).toEqual(['29s', 'expired', '59s']);
    // B expired at render time; the cursor moves on the next tick or key, not while drawing.
    expect(lines).toContain(`  quote ${B.quote_id}`);
    expect(lines.at(-1)).toBe('  ↑/↓ move · 1-3 jump · Enter award · q quit');
  });

  it('cuts every line to the terminal width, so a redraw never wraps', () => {
    const lines = createQuoteSelector([A, B], NOW).render(NOW, 30);

    expect(Math.max(...lines.map((line) => line.length))).toBe(29);
  });

  it('shows amounts as tokens where the token is listed', () => {
    const tokens = new Map([[tokenKey(SOURCE), { symbol: 'USDC', decimals: 6 }]]);
    const lines = createQuoteSelector([A], NOW, tokens).render(NOW);

    expect(lines[1]).toContain('0.10015 USDC (100150 units)');
    expect(lines.at(-1)).toBe('  ↑/↓ move · Enter award · q quit');
  });

  it('shows control characters in quote fields as ?', () => {
    const odd = quote('ee', '100150', 60);
    (odd.fulfillment_quote as Record<string, unknown>).settler_address = '\u001b[2J0x5A11';
    odd.quote_id = '0xee\u001b[1A';

    const lines = createQuoteSelector([odd], NOW).render(NOW).join('\n');

    expect(lines).not.toContain('\u001b');
    expect(lines).toContain('quote 0xee?[1A');
  });
});
