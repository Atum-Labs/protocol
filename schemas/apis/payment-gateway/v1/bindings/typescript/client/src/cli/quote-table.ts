import { POSITIVE_DECIMAL_UINT } from '@atum-labs/payment-request-sender-auth';
import type {
  AwardedQuote,
  CreateQuoteRequest,
  Quote,
  QuoteRequestStatusResponse,
} from '../generated/types.gen';
import { formatAmount, type TokenInfos } from './token-amount';
import { printable } from './terminal';

export type ListedQuote = Quote | AwardedQuote;

/** The fields of a settler's quote the table reads. The quote is opaque, so each may be absent. */
function quoted(quote: ListedQuote): Record<string, unknown> {
  const fq = quote.fulfillment_quote as unknown;
  return typeof fq === 'object' && fq !== null ? (fq as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? printable(value) : '?';
}

/** `0x90F79bf6EB2c4f870365E785982E1f101E93b906` → `0x90F7…b906`. */
export function shortAccount(account: string): string {
  return account.length > 13 ? `${account.slice(0, 6)}…${account.slice(-4)}` : account;
}

/** The amount as signing reads it: `BigInt` alone would also take `0x10` or ` 5 `. */
function amountOf(quote: ListedQuote): bigint | undefined {
  const amount = text(quoted(quote).source_amount);
  return POSITIVE_DECIMAL_UINT.test(amount) ? BigInt(amount) : undefined;
}

/** When the quote's award_deadline passes, in ms; NaN when it carries none. */
export function awardDeadlineOf(quote: ListedQuote): number {
  const deadline = quoted(quote).award_deadline;
  return typeof deadline === 'string' ? Date.parse(deadline) : Number.NaN;
}

/**
 * Cheapest first, so the default pick is the lowest price; at the same price, the one held longer
 * first. Unreadable amounts go last.
 */
export function sortQuotes<T extends ListedQuote>(quotes: readonly T[]): T[] {
  return [...quotes].sort((a, b) => {
    const x = amountOf(a);
    const y = amountOf(b);
    if (x === undefined || y === undefined) return x === undefined ? (y === undefined ? 0 : 1) : -1;
    if (x !== y) return x < y ? -1 : 1;
    return (awardDeadlineOf(b) || 0) - (awardDeadlineOf(a) || 0);
  });
}

export function timeLeft(quote: ListedQuote, now: number): string {
  if ('awarded_payment_id' in quote && quote.awarded_payment_id) return 'awarded';
  const deadline = awardDeadlineOf(quote);
  if (Number.isNaN(deadline)) return '?';
  const seconds = Math.floor((deadline - now) / 1000);
  return seconds <= 0 ? 'expired' : duration(seconds);
}

/** `90061` → `1d 1h`, `3725` → `1h 2m`, `65` → `1m 5s`. */
function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** A quote's `you pay`, `settler` and `award within` cells. */
export function quoteCells(quote: ListedQuote, now: number, tokens?: TokenInfos): string[] {
  const fq = quoted(quote);
  const source = fq.source as { id?: unknown } | undefined;
  return [
    formatAmount(text(fq.source_amount), text(source?.id), tokens, { nameUnlisted: false }),
    shortAccount(text(fq.settler_address)),
    timeLeft(quote, now),
  ];
}

/** Rows as aligned lines, two spaces between columns, the last column unpadded. */
export function alignRows(rows: readonly string[][]): string[] {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  return rows.map(
    (row) =>
      '  ' +
      row.map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]))).join('  '),
  );
}

/**
 * The quotes as a table, numbered in the order given, with each full quote_id. Amounts read as
 * tokens where `tokens` lists the source token, else in smallest units.
 */
export function formatQuoteTable(
  quotes: readonly ListedQuote[],
  now: number,
  tokens?: TokenInfos,
): string {
  return alignRows([
    ['#', 'you pay', 'settler', 'award within', 'quote'],
    ...quotes.map((quote, i) => [
      String(i + 1),
      ...quoteCells(quote, now, tokens),
      text(quote.quote_id),
    ]),
  ]).join('\n');
}

/** `eip155:42161/erc20:0xaf88…5831` → `eip155:42161`. */
function chainOf(assetIdentifier: string): string {
  const slash = assetIdentifier.indexOf('/');
  return slash < 0 ? assetIdentifier : assetIdentifier.slice(0, slash);
}

/**
 * What the receiver gets, e.g. `0.1 USDC (100000 units) on eip155:8453 to 0x90F7…`. The receiver
 * is printed in full: it is the one value a shortened form could hide a lookalike in.
 */
export function describeDelivery(quoteRequest: CreateQuoteRequest, tokens?: TokenInfos): string {
  const to = quoteRequest.destination[0];
  const asset = text(to?.asset_identifier);
  return (
    `${formatAmount(text(quoteRequest.fulfillment_amount), asset, tokens)} on ${chainOf(asset)} ` +
    `to ${text(to?.account)}`
  );
}

/**
 * What awarding `quote` pays, for the person to confirm, with the fulfillment_deadline: a deposit
 * that is not delivered is refundable only after it.
 */
export function describePayment(
  quoteRequest: CreateQuoteRequest,
  quote: ListedQuote,
  now: number,
  tokens?: TokenInfos,
): string {
  const asset = text(quoteRequest.source.asset_identifier);
  const deadline = text(quoteRequest.fulfillment_deadline);
  const seconds = Math.floor((Date.parse(deadline) - now) / 1000);
  const within = Number.isNaN(seconds)
    ? ''
    : seconds > 0
      ? ` (in ${duration(seconds)})`
      : ' (passed)';
  return (
    `Pay ${formatAmount(text(quoted(quote).source_amount), asset, tokens)} on ${chainOf(asset)} → ` +
    `${describeDelivery(quoteRequest, tokens)}, refundable if not delivered by ${deadline}${within}`
  );
}

/** The quote a quote request awarded and its payment, when it has one. */
export function awardOf(
  batch: QuoteRequestStatusResponse,
): { quoteId: string; paymentId: string } | undefined {
  const paid = batch.payments?.[0];
  if (paid) return { quoteId: paid.quote_id, paymentId: paid.payment_id };
  const quote = batch.quotes?.find((q) => q.awarded_payment_id);
  return quote?.awarded_payment_id
    ? { quoteId: quote.quote_id, paymentId: quote.awarded_payment_id }
    : undefined;
}

/** What `quote-status` shows a person: a header, the quotes cheapest first, and how to award. */
export function formatQuoteStatus(
  quoteRequestId: string,
  batch: QuoteRequestStatusResponse,
  now: number,
  tokens?: TokenInfos,
): string[] {
  const quotes = sortQuotes(batch.quotes ?? []);
  const award = awardOf(batch);
  const lines = [
    `${batch.status} · ${quotes.length} ${quotes.length === 1 ? 'quote' : 'quotes'}` +
      (award ? ` · awarded to payment ${award.paymentId}` : '') +
      (batch.error ? ` · ${batch.error.code}` : ''),
  ];
  if (batch.error) lines.push(batch.error.message);
  if (!quotes.length) return lines;
  lines.push('', formatQuoteTable(quotes, now, tokens));
  if (!award) lines.push('', `Award one with: award-quote ${quoteRequestId}`);
  return lines;
}
