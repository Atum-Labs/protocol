/**
 * The quote picker a person drives with the arrow keys, as a state machine with no I/O: the
 * terminal feeds it keys and the clock and draws what `render` returns, and tests do the same.
 */

import type { TokenInfos } from './token-amount';
import { alignRows, awardDeadlineOf, quoteCells, type ListedQuote } from './quote-table';
import { printable } from './terminal';

/** `up`, `down`, `enter`, `quit`, or a digit `1`-`9` that moves to that row. */
export type SelectorKey = 'up' | 'down' | 'enter' | 'quit' | `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export type SelectorState = 'open' | 'chosen' | 'quit' | 'all-expired';

export interface QuoteSelector<T extends ListedQuote> {
  readonly state: SelectorState;
  /** The quote awarded with Enter, once `state` is `chosen`. */
  readonly chosen: T | undefined;
  press(key: SelectorKey, now: number): void;
  /** Moves the cursor off a quote that has expired, and ends the pick when none is left. */
  tick(now: number): void;
  /** The table with the cursor, the selected quote_id and the keys, each line cut to `columns`. */
  render(now: number, columns?: number): string[];
}

/**
 * A picker over `quotes` in the order given, the cursor on the first one that can still be
 * awarded. A quote that expires keeps its row, so the rows never move under the cursor.
 */
export function createQuoteSelector<T extends ListedQuote>(
  quotes: readonly T[],
  now: number,
  tokens?: TokenInfos,
): QuoteSelector<T> {
  let state: SelectorState = 'open';
  let chosen: T | undefined;
  let cursor = -1;

  const open = (i: number, at: number) => {
    const quote = quotes[i];
    if (quote === undefined) return false;
    // An awarded quote is the retry of its award, which the gateway replays after the deadline.
    if ('awarded_payment_id' in quote && quote.awarded_payment_id) return true;
    const deadline = awardDeadlineOf(quote);
    return !Number.isNaN(deadline) && deadline > at;
  };
  const nearest = (from: number, step: 1 | -1, at: number) => {
    for (let i = from; i >= 0 && i < quotes.length; i += step) if (open(i, at)) return i;
    return -1;
  };
  const settle = (at: number) => {
    if (state !== 'open' || open(cursor, at)) return;
    const next = nearest(cursor + 1, 1, at);
    cursor = next >= 0 ? next : nearest(cursor - 1, -1, at);
    if (cursor < 0) state = 'all-expired';
  };
  settle(now);

  return {
    get state() {
      return state;
    },
    get chosen() {
      return chosen;
    },
    press(key, at) {
      if (state !== 'open') return;
      const highlighted = cursor;
      settle(at);
      if (state !== 'open') return;
      // The highlighted quote expired since the last draw: show the new row before Enter awards it.
      if (key === 'enter' && cursor !== highlighted) return;
      if (key === 'quit') {
        state = 'quit';
      } else if (key === 'up' || key === 'down') {
        const step = key === 'up' ? -1 : 1;
        const next = nearest(cursor + step, step, at);
        if (next >= 0) cursor = next;
      } else if (key === 'enter') {
        chosen = quotes[cursor];
        state = 'chosen';
      } else if (open(Number(key) - 1, at)) {
        cursor = Number(key) - 1;
      }
    },
    tick(at) {
      settle(at);
    },
    render(at, columns) {
      const lines = alignRows([
        ['', 'you pay', 'settler', 'award within'],
        ...quotes.map((quote, i) => [i === cursor ? '▶' : '', ...quoteCells(quote, at, tokens)]),
      ]);
      const selected = quotes[cursor];
      lines.push('');
      if (selected) lines.push(`  quote ${printable(selected.quote_id)}`);
      const jump = quotes.length > 1 ? ` · 1-${Math.min(quotes.length, 9)} jump` : '';
      lines.push(`  ↑/↓ move${jump} · Enter award · q quit`);
      return columns && columns > 1 ? lines.map((line) => line.slice(0, columns - 1)) : lines;
    },
  };
}
