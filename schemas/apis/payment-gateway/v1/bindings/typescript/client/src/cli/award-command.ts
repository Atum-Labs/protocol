/**
 * What `award-quote` does, as a function that returns the exit code, so it runs in-process under
 * test with a scripted terminal.
 */

import { readFileSync } from 'fs';
import type { PaymentGatewayClient } from '../index';
import type { CreateQuoteRequest } from '../generated/types.gen';
import { parseAssetIdentifier } from '../asset-identifier';
import { sameAccount } from '../award-quote';
import { getChainAdapter } from '../chain-adapters';
import type { ChainDefaults } from '../chain-adapters/types';
import { EXIT_ERROR } from './payment-outcome';
import {
  alreadyAwardedMessage,
  assertSelfSelected,
  awardableQuotes,
  payQuote,
  pickQuote,
  quoteHeader,
  type PayOptions,
} from './pay-quote';
import { awardOf, shortAccount } from './quote-table';
import { printCliError, type Terminal } from './terminal';
import { tokenInfos } from './token-amount';

const QUOTE_ID = /^0x[0-9a-fA-F]{64}$/;

export const SCRIPT_NEEDS_FROM =
  'from a script, award with --from <request-quote output>, so the award pays the quote request ' +
  'you opened. award-quote <quote_request_id> [quote_id] is for a terminal, where you confirm ' +
  'what is paid.';

export interface AwardCommandParams extends PayOptions {
  client: PaymentGatewayClient;
  terminal: Terminal;
  /** The positional arguments: `<quote_request_id> [quote_id]`, or `[quote_id]` with `from`. */
  args: string[];
  /** The file request-quote printed from a script, holding the body it sent. */
  from?: string;
  requestId?: string;
  readFile?: (path: string) => string;
}

/** The quote request a `request-quote` run opened, as it printed it for a script. */
export function readRequestQuoteOutput(
  from: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): { quoteRequestId: string; quoteRequest: CreateQuoteRequest } {
  let saved: { quote_request_id?: unknown; quote_request?: Partial<CreateQuoteRequest> } | null;
  try {
    saved = JSON.parse(readFile(from));
  } catch (e) {
    throw new Error(`cannot read ${from}: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  const body = saved?.quote_request;
  if (
    typeof saved?.quote_request_id !== 'string' ||
    typeof body !== 'object' ||
    body === null ||
    typeof body.source?.account !== 'string' ||
    typeof body.source?.asset_identifier !== 'string' ||
    !Array.isArray(body.destination)
  ) {
    throw new Error(
      `${from} is not request-quote output: it needs quote_request_id and the quote_request ` +
        `request-quote sent. Save it with: request-quote … > ${from}`,
    );
  }
  return { quoteRequestId: saved.quote_request_id, quoteRequest: body as CreateQuoteRequest };
}

/**
 * The quote request as the quote carries it. The settler signed this copy, and the gateway checks
 * it against the request it stored before it lists or awards the quote. Only a person at a
 * terminal awards from it, after reading the pay line.
 */
function quoteRequestOf(fulfillmentQuote: unknown): CreateQuoteRequest {
  const json = (fulfillmentQuote as { payment_request_json?: unknown } | null)
    ?.payment_request_json;
  let body: Partial<CreateQuoteRequest> | null = null;
  if (typeof json === 'string') {
    try {
      body = JSON.parse(json) as Partial<CreateQuoteRequest> | null;
    } catch {
      body = null;
    }
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    typeof body.source?.account !== 'string' ||
    typeof body.source?.asset_identifier !== 'string' ||
    !Array.isArray(body.destination)
  ) {
    throw new Error('the quote carries no readable payment_request_json, so it cannot be awarded');
  }
  return body as CreateQuoteRequest;
}

/**
 * How the quote request's escrow, fulfillment verifier and fulfillment proxy differ from the
 * gateway's `/v1/defaults` for its source and destination chains, or `undefined` when they match.
 * request-quote always opens a quote request with these, so a person awarding by ids only signs
 * for them.
 */
export function contractsProblem(
  quoteRequest: CreateQuoteRequest,
  sourceDefaults: ChainDefaults,
  destinationDefaults: ChainDefaults,
): string | undefined {
  const source = parseAssetIdentifier(quoteRequest.source.asset_identifier);
  const destination = parseAssetIdentifier(quoteRequest.destination[0]?.asset_identifier);
  const verifier = getChainAdapter(source.chainId).resolveContractOverrides?.(sourceDefaults)
    ?.fulfillment_verifier ?? {
    account: sourceDefaults.fulfillmentVerifierAccount,
    endpoint: sourceDefaults.fulfillmentVerifierEndpoint,
  };
  const named = quoteRequest.fulfillment_verifier as
    { account?: unknown; endpoint?: unknown } | undefined;
  const differs: string[] = [];
  /** An account compares as its chain spells it (EVM case, Tron base58 or hex); a URL exactly. */
  const check = (
    field: string,
    value: unknown,
    expected: string,
    on: { chainId: string; namespace: string },
    asAccount = true,
  ) => {
    const same = asAccount
      ? typeof value === 'string' && sameAccount(on.namespace, value, expected)
      : value === expected;
    if (!same) {
      differs.push(`${field} is ${String(value)}, the gateway's on ${on.chainId} is ${expected}`);
    }
  };
  check(
    'escrow_contract_address',
    quoteRequest.escrow_contract_address,
    sourceDefaults.escrowContract,
    source,
  );
  check('fulfillment_verifier.account', named?.account, verifier.account, source);
  check('fulfillment_verifier.endpoint', named?.endpoint, verifier.endpoint, source, false);
  check(
    'fulfillment_proxy',
    quoteRequest.fulfillment_proxy,
    destinationDefaults.fulfillmentProxy,
    destination,
  );
  return differs.length ? `its ${differs.join('; its ')}` : undefined;
}

/** A path as a shell reads it back as one argument. */
function shellArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function readableQuoteRequestOf(fulfillmentQuote: unknown): CreateQuoteRequest | undefined {
  try {
    return quoteRequestOf(fulfillmentQuote);
  } catch {
    return undefined;
  }
}

/**
 * Awards one quote. With `from`, the deposit commits the body that request-quote sent. Without it,
 * only at a terminal, the body comes from the quotes and the person confirms what is paid. With no
 * quote_id, a person at a terminal picks the quote; a script gets the cheapest that can be awarded.
 *
 * @returns the exit code
 */
export async function runAwardQuote(params: AwardCommandParams): Promise<number> {
  try {
    return await awardQuoteFromArgs(params);
  } catch (error) {
    printCliError(error, params.terminal);
    return EXIT_ERROR;
  }
}

async function awardQuoteFromArgs(params: AwardCommandParams): Promise<number> {
  const { client, terminal, args, from, readFile: _readFile, ...pay } = params;
  const now = params.now ?? Date.now;

  let quoteRequestId: string;
  let quoteRequest: CreateQuoteRequest | undefined;
  let quoteId: string | undefined;
  if (from !== undefined) {
    if (args.length > 1) {
      throw new Error('with --from, pass at most the quote_id: the file names the quote request');
    }
    ({ quoteRequestId, quoteRequest } = readRequestQuoteOutput(from, params.readFile));
    assertSelfSelected(quoteRequest);
    quoteId = args[0];
  } else {
    if (!terminal.interactive) throw new Error(SCRIPT_NEEDS_FROM);
    if (args.length < 1 || args.length > 2) {
      throw new Error('pass <quote_request_id> [quote_id], or --from <request-quote output>');
    }
    [quoteRequestId, quoteId] = args;
  }
  if (quoteId !== undefined && !QUOTE_ID.test(quoteId)) {
    throw new Error(`<quoteId> must be a 0x-prefixed 32-byte hex value, got ${quoteId}`);
  }

  const batch = await client.quoteRequests.getQuoteRequestStatus({ quoteRequestId });
  const quotes = batch.quotes ?? [];
  const award = awardOf(batch);
  // Re-awarding the awarded quote is a retry and replays; any other quote is refused.
  const wanted = quoteId ?? award?.quoteId;
  let quote = wanted
    ? quotes.find((q) => q.quote_id.toLowerCase() === wanted.toLowerCase())
    : undefined;
  if (wanted && !quote) {
    throw new Error(
      award && !quoteId
        ? alreadyAwardedMessage(quoteRequestId, award)
        : `quote request ${quoteRequestId} holds no quote ${wanted} (status ${batch.status}, ` +
            `${quotes.length} quotes). \`quote-status ${quoteRequestId}\` lists them.`,
    );
  }
  if (quote && award && award.quoteId.toLowerCase() !== quote.quote_id.toLowerCase()) {
    throw new Error(alreadyAwardedMessage(quoteRequestId, award));
  }
  const nothingToAward = () =>
    new Error(
      `no quote of ${quoteRequestId} can be awarded (status ${batch.status}, ${quotes.length} quotes)`,
    );

  if (quoteRequest === undefined) {
    // By ids, at a terminal: the body as the quotes carry it, checked against the gateway's
    // escrow and verifier before the person is shown anything to confirm.
    if (quote) {
      quoteRequest = quoteRequestOf(quote.fulfillment_quote);
    } else {
      quoteRequest = quotes
        .map((q) => readableQuoteRequestOf(q.fulfillment_quote))
        .find((body) => body !== undefined);
      if (quoteRequest === undefined) throw nothingToAward();
    }
    const [sourceDefaults, destinationDefaults] = await Promise.all(
      [quoteRequest.source.asset_identifier, quoteRequest.destination[0]?.asset_identifier].map(
        (asset) => client.fetchChainDefaults(parseAssetIdentifier(asset).chainId),
      ),
    );
    const problem = contractsProblem(quoteRequest, sourceDefaults, destinationDefaults);
    if (problem !== undefined) {
      throw new Error(`quote request ${quoteRequestId} cannot be awarded here: ${problem}`);
    }
  }
  const tokens = terminal.interactive
    ? await tokenInfos(client, [
        quoteRequest.source.asset_identifier,
        quoteRequest.destination[0]?.asset_identifier ?? '',
      ])
    : undefined;

  if (!quote) {
    // With no one to read the price, the request's cap is what bounds it.
    if (!terminal.interactive && quoteRequest.max_source_amount === undefined) {
      throw new Error(
        'with no quote_id, --from from a script needs a quote request with max_source_amount, so ' +
          'the price it pays is bounded. Name the quote_id, or open the quote request with ' +
          'request-quote --max-source-amount',
      );
    }
    const { awardable, leftOut } = await awardableQuotes(
      quoteRequestId,
      quoteRequest,
      quotes,
      now(),
    );
    if (!awardable.length) {
      const error = nothingToAward();
      error.message += leftOut
        .map((l) => `\n  ${shortAccount(l.quote.quote_id)}: ${l.reason}`)
        .join('');
      throw error;
    }
    if (terminal.interactive) {
      for (const { quote: left, reason } of leftOut) {
        terminal.write(`Left out quote ${shortAccount(left.quote_id)}: ${reason}`);
      }
      terminal.write(quoteHeader(awardable.length, quoteRequestId, quoteRequest, tokens));
      terminal.write('');
      const picked = await pickQuote(terminal, awardable, now, tokens);
      if (!picked.quote) {
        if (!picked.expired) terminal.write('Nothing signed.');
        return EXIT_ERROR;
      }
      quote = picked.quote;
    } else {
      quote = awardable[0];
      terminal.write(
        `Chose quote ${quote.quote_id}, the cheapest of ${awardable.length} that can be awarded.`,
      );
    }
  }
  if (award) {
    // Retrying the award: the gateway replays it, also past the quote's award_deadline.
    quote = { ...quote, awarded_payment_id: award.paymentId };
  }

  const code = await payQuote({
    ...pay,
    client,
    terminal,
    quoteRequestId,
    quoteRequest,
    quote,
    tokens,
    confirm: terminal.interactive,
    retryCommand:
      from !== undefined
        ? `award-quote --from ${shellArg(from)} ${quote.quote_id}`
        : `award-quote ${quoteRequestId} ${quote.quote_id}`,
  });
  // Declining at the prompt did nothing, which is exit 1 for a command that pays.
  return code ?? EXIT_ERROR;
}
