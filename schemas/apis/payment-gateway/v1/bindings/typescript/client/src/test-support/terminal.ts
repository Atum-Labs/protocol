// The quote selector driven by scripted keys, as a person at a terminal would drive it.
import type { ListedQuote } from '../cli/quote-table';
import type { QuoteSelector, SelectorKey } from '../cli/quote-selector';

/**
 * A `Terminal.choose` that presses `keys` in order. `screens` collects what the person saw before
 * the first key. Throws when the keys run out with the selector still open.
 */
export function scriptedChoose(keys: SelectorKey[], screens: string[][] = []) {
  return async <T extends ListedQuote>(selector: QuoteSelector<T>): Promise<void> => {
    screens.push(selector.render(Date.now()));
    for (const key of keys) {
      if (selector.state !== 'open') break;
      selector.press(key, Date.now());
    }
    if (selector.state === 'open') throw new Error('the keys ran out with the selector open');
  };
}
