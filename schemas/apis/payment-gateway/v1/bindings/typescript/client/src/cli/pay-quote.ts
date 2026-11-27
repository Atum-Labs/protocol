/**
 * Choosing and paying a quote from the command line, shared by `request-quote` (pick and pay in one
 * run at a terminal) and `award-quote`. Returns exit codes rather than exiting, so the whole path
 * runs in-process under test.
 */

import type { PaymentGatewayClient } from '../index';
import type {
  AwardedQuote,
  CreateQuoteRequest,
  CreateQuoteRequestResponse,
  Quote,
} from '../generated/types.gen';
import { getErrorResponse } from '../errors';
import { parseAssetIdentifier } from '../asset-identifier';
import { quoteSelectorOf, readAwardInputs, sameAccount } from '../award-quote';
import { normalizeAddress } from '../sender_auth_schemes/tron';
import { createSenderSigner } from '../signers';
import type { SenderSigner } from '../signers';
import { EXIT_ERROR } from './payment-outcome';
import { reportPayment } from './submit-and-report';
import { promptPrivateKey } from './prompt-private-key';
import { loadTurnkeyConfigFromEnv } from './turnkey-env';
import { verifyFulfillmentQuote } from '../quote-verify';
import {
  awardOf,
  describeDelivery,
  describePayment,
  formatQuoteTable,
  shortAccount,
  sortQuotes,
} from './quote-table';
import { printCliError, type Terminal } from './terminal';
import { createQuoteSelector } from './quote-selector';
import type { TokenInfos } from './token-amount';

/** How the depositor signs and how long to follow the payment: the same options as send-payment. */
export interface PayOptions {
  /** `raw` (PRIVATE_KEY or a hidden prompt) or `turnkey`. Defaults to `raw`. */
  provider?: string;
  solanaRpcUrl?: string;
  wait?: boolean;
  waitFor?: 'finalizing' | 'completed';
  waitSeconds?: number;
  pollIntervalMs?: number;
  /** Reads the raw key. Defaults to PRIVATE_KEY, then a hidden prompt. */
  readPrivateKey?: () => Promise<string>;
  /** Where the payment JSON goes for a script. Defaults to stdout. */
  writeOut?: (line: string) => void;
  now?: () => number;
}

export interface PayQuoteParams extends PayOptions {
  client: PaymentGatewayClient;
  terminal: Terminal;
  quoteRequestId: string;
  /** The quote request body the deposit commits. */
  quoteRequest: CreateQuoteRequest;
  quote: Quote | AwardedQuote;
  /** Show what is paid and ask before anything is signed. */
  confirm: boolean;
  /** The award's idempotency key. Defaults to `award-<quote_id hex>`, so a re-run is a replay. */
  requestId?: string;
  /** The command that runs this award again. Defaults to `award-quote <qr> <quote_id>`. */
  retryCommand?: string;
  /** The listed tokens, so amounts read as tokens. */
  tokens?: TokenInfos;
}

/** The award default key: one quote, one award, so re-running the same award replays it. */
export function defaultAwardRequestId(quoteId: string): string {
  return `award-${quoteId.slice(2).toLowerCase()}`;
}

/**
 * Refuses a quote request whose reserve another account signs: one CLI run holds one key.
 */
export function assertSelfSelected(quoteRequest: CreateQuoteRequest): void {
  const { namespace } = parseAssetIdentifier(quoteRequest.source.asset_identifier);
  const depositor = quoteRequest.source.account;
  const selector = quoteSelectorOf(quoteRequest);
  if (!sameAccount(namespace, selector, depositor)) {
    throw new Error(
      `this quote request names quote_selector ${selector}, which signs the reserve for ` +
        `${depositor}. Awarding for another account needs the SDK: awardQuote with selectorSigner`,
    );
  }
}

/**
 * Why `quote` cannot be awarded for `quoteRequest`, or `undefined` when it can: it quotes that
 * request, its award_deadline is ahead, its settler signature verifies with `quote_id` its hash,
 * and the request's `settler_requirements` admit its signer. Needs no key.
 */
export async function quoteProblem(
  quoteRequestId: string,
  quoteRequest: CreateQuoteRequest,
  quote: Quote | AwardedQuote,
  now: number,
): Promise<string | undefined> {
  try {
    readAwardInputs({ quoteRequestId, quoteRequest, quote, now });
  } catch (e) {
    return e instanceof Error ? e.message.replace(/^payment-gateway-client: /, '') : String(e);
  }
  const check = await verifyFulfillmentQuote(quote);
  return check.valid ? settlerProblem(quoteRequest, check.signerDID!) : check.reason;
}

/** `did:pkh:<namespace>:<reference>:<account>`, its chain lowercased, as the gateway compares it. */
function parseDIDPKH(did: string): { chain: string; account: string } | undefined {
  const match = /^did:pkh:([^:]+:[^:]+):(.+)$/i.exec(did);
  return match ? { chain: match[1].toLowerCase(), account: match[2] } : undefined;
}

/** The quote's signer as an account on `chainId`, or `undefined` when its key is for another. */
function signerAccount(signerDID: string, chainId: string, namespace: string): string | undefined {
  const signer = parseDIDPKH(signerDID);
  if (!signer) return undefined;
  if (namespace === 'solana') {
    return signer.chain === chainId.toLowerCase() ? signer.account : undefined;
  }
  if (namespace !== 'eip155' && namespace !== 'tron') return undefined;
  // EVM and Tron share secp256k1 keys, so either DID names the same signer.
  if (signer.chain.startsWith('eip155:')) return signer.account;
  if (!signer.chain.startsWith('tron:')) return undefined;
  try {
    return normalizeAddress(signer.account);
  } catch {
    return undefined;
  }
}

/**
 * Why the quote request's `settler_requirements` refuse the quote's signer, or `undefined` when
 * they admit it. The signer reads as the gateway reads it, `did:pkh:<source chain>:<its account
 * there>`, so a list entry names the source chain.
 */
export function settlerProblem(
  quoteRequest: CreateQuoteRequest,
  signerDID: string,
): string | undefined {
  const whitelist = quoteRequest.settler_requirements?.whitelist ?? [];
  const blacklist = quoteRequest.settler_requirements?.blacklist ?? [];
  if (whitelist.length === 0 && blacklist.length === 0) return undefined;
  const { chainId, namespace } = parseAssetIdentifier(quoteRequest.source.asset_identifier);
  const signer = signerAccount(signerDID, chainId, namespace);
  if (signer === undefined) {
    return `its signer ${signerDID} has no account on ${chainId} for settler_requirements to match`;
  }
  const listed = (entries: readonly string[]) =>
    entries.some((entry) => {
      const listedDID = parseDIDPKH(entry);
      return (
        listedDID?.chain === chainId.toLowerCase() &&
        sameAccount(namespace, listedDID.account, signer)
      );
    });
  if (whitelist.length > 0 && !listed(whitelist)) {
    return `its signer ${signerDID} is not in settler_requirements.whitelist`;
  }
  if (listed(blacklist)) return `its signer ${signerDID} is in settler_requirements.blacklist`;
  return undefined;
}

/** The quotes that can be awarded, cheapest first, and why each other one cannot. */
export async function awardableQuotes<T extends Quote | AwardedQuote>(
  quoteRequestId: string,
  quoteRequest: CreateQuoteRequest,
  quotes: readonly T[],
  now: number,
): Promise<{ awardable: T[]; leftOut: { quote: T; reason: string }[] }> {
  const awardable: T[] = [];
  const leftOut: { quote: T; reason: string }[] = [];
  for (const quote of sortQuotes(quotes)) {
    const reason = await quoteProblem(quoteRequestId, quoteRequest, quote, now);
    if (reason === undefined) awardable.push(quote);
    else leftOut.push({ quote, reason });
  }
  return { awardable, leftOut };
}

/**
 * Checks the quote, asks the person when `confirm` is set, signs the deposit and the reserve with
 * the depositor's signer, awards, and reports the payment as send-payment does.
 *
 * @returns the exit code, or `undefined` when the person declined and nothing was signed
 */
export async function payQuote(params: PayQuoteParams): Promise<number | undefined> {
  const { client, terminal, quoteRequestId, quoteRequest, quote } = params;
  const now = params.now ?? Date.now;
  const requestId = params.requestId ?? defaultAwardRequestId(quote.quote_id);
  const provider = params.provider ?? 'raw';
  let sent = false;
  try {
    if (provider !== 'raw' && provider !== 'turnkey') {
      throw new Error(`Unknown --provider '${provider}' (expected 'raw' or 'turnkey')`);
    }
    const { chainId } = parseAssetIdentifier(quoteRequest.source.asset_identifier);
    const depositor = quoteRequest.source.account;
    assertSelfSelected(quoteRequest);
    // Every check that needs no key runs before the person is asked for one.
    const problem = await quoteProblem(quoteRequestId, quoteRequest, quote, now());
    if (problem !== undefined) {
      throw new Error(`quote ${quote.quote_id} cannot be awarded: ${problem}`);
    }

    if (params.confirm) {
      const answer = await terminal.ask(
        `${describePayment(quoteRequest, quote, now(), params.tokens)}? [y/N] `,
      );
      if (!['y', 'yes'].includes(answer.toLowerCase())) {
        terminal.write('Nothing signed.');
        return undefined;
      }
    }

    let depositorSigner: SenderSigner;
    if (provider === 'turnkey') {
      depositorSigner = createSenderSigner(chainId, {
        provider: 'turnkey',
        ...loadTurnkeyConfigFromEnv(),
        pinnedAddress: depositor,
      });
    } else {
      // `||` not `??`: an empty PRIVATE_KEY="" should still prompt.
      const readKey =
        params.readPrivateKey ?? (async () => process.env.PRIVATE_KEY || promptPrivateKey());
      depositorSigner = createSenderSigner(chainId, {
        provider: 'raw',
        privateKey: await readKey(),
        pinnedAddress: depositor,
      });
    }

    sent = true;
    const result = await client.awardQuote({
      requestId,
      quoteRequestId,
      quoteRequest,
      quote,
      depositorSigner,
      solanaRpcUrl: params.solanaRpcUrl || process.env.SOLANA_RPC_URL,
      now: params.now,
    });

    if (terminal.interactive) {
      terminal.write(
        `Awarded quote ${shortAccount(quote.quote_id)} → payment ${result.response.payment_id ?? result.paymentId}`,
      );
    } else {
      terminal.write(JSON.stringify(result.request, null, 2));
      terminal.write(`request_id: ${requestId}`);
    }
    // A replay answers with the payment the award key already made, which this run's signature
    // did not create when the first run signed a different deposit (Solana stamps issued_at).
    if (
      result.response.payment_id !== undefined &&
      result.response.payment_id.toLowerCase() !== result.paymentId.toLowerCase()
    ) {
      terminal.write(
        `this award key already holds payment ${result.response.payment_id}; the deposit signed ` +
          `by this run (${result.paymentId}) was not used.`,
      );
    }

    return await reportPayment({
      client,
      response: result.response,
      requestId,
      wait: params.wait,
      waitFor: params.waitFor,
      waitSeconds: params.waitSeconds,
      pollIntervalMs: params.pollIntervalMs,
      // A person reads the summary line; the JSON is for scripts.
      writeOut: terminal.interactive ? () => undefined : params.writeOut,
      writeErr: (line) => terminal.write(line),
    });
  } catch (error) {
    printCliError(error, terminal);
    if (getErrorResponse(error)?.code === 'QUOTE_REQUEST_ALREADY_AWARDED') {
      // Retrying cannot help: the quote request is spent.
      terminal.write(await alreadyAwardedAdvice(client, quoteRequestId));
    } else if (sent) {
      const flag =
        requestId === defaultAwardRequestId(quote.quote_id) ? '' : ` --request-id ${requestId}`;
      const command = params.retryCommand ?? `award-quote ${quoteRequestId} ${quote.quote_id}`;
      terminal.write(`Retry this same award with: ${command}${flag}`);
    }
    return EXIT_ERROR;
  }
}

export function alreadyAwardedMessage(
  quoteRequestId: string,
  award: { quoteId: string; paymentId: string } | undefined,
): string {
  const which = award ? ` quote ${award.quoteId} (payment ${award.paymentId})` : '';
  return `${quoteRequestId} already awarded${which}. Open a new quote request to pay again.`;
}

async function alreadyAwardedAdvice(
  client: PaymentGatewayClient,
  quoteRequestId: string,
): Promise<string> {
  try {
    const batch = await client.quoteRequests.getQuoteRequestStatus({ quoteRequestId });
    return alreadyAwardedMessage(quoteRequestId, awardOf(batch));
  } catch {
    return alreadyAwardedMessage(quoteRequestId, undefined);
  }
}

/** `3 quotes (qr_…) for 0.1 USDC (100000 units) on eip155:8453 to 0x90F7…`. */
export function quoteHeader(
  count: number,
  quoteRequestId: string,
  quoteRequest: CreateQuoteRequest,
  tokens?: TokenInfos,
): string {
  return (
    `${count} ${count === 1 ? 'quote' : 'quotes'} (${quoteRequestId}) for ` +
    describeDelivery(quoteRequest, tokens)
  );
}

/**
 * Shows `quotes` and lets the person pick one: with the arrow keys where the terminal reads keys
 * one at a time, else by number. No `quote` means the person quit, or every quote expired first.
 */
export async function pickQuote<T extends Quote | AwardedQuote>(
  terminal: Terminal,
  quotes: readonly T[],
  now: () => number,
  tokens?: TokenInfos,
): Promise<{ quote?: T; expired: boolean }> {
  if (terminal.choose) {
    const selector = createQuoteSelector(quotes, now(), tokens);
    await terminal.choose(selector);
    const expired = selector.state === 'all-expired';
    if (expired) terminal.write('All quotes expired. Nothing signed.');
    return { quote: selector.chosen, expired };
  }
  terminal.write(formatQuoteTable(quotes, now(), tokens));
  terminal.write('');
  for (;;) {
    const answer = (await terminal.ask('Award which? [Enter = 1, q = quit] ')).toLowerCase();
    if (answer === '') return { quote: quotes[0], expired: false };
    if (answer === 'q') return { expired: false };
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= quotes.length) {
      return { quote: quotes[n - 1], expired: false };
    }
    terminal.write(`Type a number from 1 to ${quotes.length}, or q.`);
  }
}

/**
 * The body the quote request's quotes commit. A re-sent request_id resolves onto the batch it
 * opened first, which keeps that attempt's deadlines, so its award must sign those; every other
 * field stays this run's, and the award's binding check compares them with what the quotes commit.
 */
export function batchQuoteRequest(
  sent: CreateQuoteRequest,
  response: CreateQuoteRequestResponse,
): CreateQuoteRequest {
  if (response.idempotent_replay !== true) return sent;
  const qr = response.quote_request_id;
  const quoteDeadline = response.quote_deadline;
  const fulfillmentDeadline = response.fulfillment_deadline;
  const at = (deadline: string | undefined) => (deadline ? Date.parse(deadline) : NaN);
  let problem: string | undefined;
  if (Number.isNaN(at(quoteDeadline)) || Number.isNaN(at(fulfillmentDeadline))) {
    problem = 'the reply does not give its deadlines';
  } else if (
    at(quoteDeadline) > at(sent.quote_deadline) ||
    at(fulfillmentDeadline) > at(sent.fulfillment_deadline)
  ) {
    problem = 'its deadlines are later than this run would set';
  }
  if (problem !== undefined) {
    throw new Error(
      `request_id ${sent.request_id} already opened quote request ${qr}, and ${problem}. ` +
        `Award its quotes at a terminal with: award-quote ${qr}`,
    );
  }
  return { ...sent, quote_deadline: quoteDeadline!, fulfillment_deadline: fulfillmentDeadline! };
}

/**
 * `request-quote` at a terminal: list what came back, let the person pick one, and pay it in the
 * same run.
 *
 * @returns the exit code: 0 when nothing was paid, else the payment's
 */
export async function offerQuotes(
  params: PayOptions & {
    client: PaymentGatewayClient;
    terminal: Terminal;
    quoteRequest: CreateQuoteRequest;
    response: CreateQuoteRequestResponse;
    tokens?: TokenInfos;
  },
): Promise<number> {
  const { terminal, quoteRequest, response, ...pay } = params;
  const quoteRequestId = response.quote_request_id;
  const now = params.now ?? Date.now;
  const quotes = 'quotes' in response ? response.quotes : undefined;
  if (response.status === 'collecting' || quotes === undefined) {
    terminal.write(`Still collecting quotes (${quoteRequestId}). List them with:`);
    terminal.write(`  quote-status ${quoteRequestId}`);
    return 0;
  }
  if (quotes.length === 0) {
    const failure = 'error' in response ? response.error : undefined;
    if (failure) {
      // The message already says what to do next, so no generic advice is added.
      terminal.write(`No quotes for ${quoteRequestId}: ${failure.code}. ${failure.message}`);
      return 0;
    }
    const declined = ('decline_summary' in response ? response.decline_summary : undefined) ?? [];
    const reasons = declined.length
      ? ` Declined: ${declined.map((d) => `${d.reason} (${d.count})`).join(', ')}.`
      : '';
    const cap = quoteRequest.max_source_amount ? ', or raise --max-source-amount' : '';
    terminal.write(`No quotes for ${quoteRequestId}.${reasons} Try again${cap}.`);
    return 0;
  }

  const { awardable: listed, leftOut } = await awardableQuotes(
    quoteRequestId,
    quoteRequest,
    quotes,
    now(),
  );
  for (const { quote, reason } of leftOut) {
    terminal.write(`Left out quote ${shortAccount(quote.quote_id)}: ${reason}`);
  }
  if (listed.length === 0) {
    terminal.write(`No quote for ${quoteRequestId} can be awarded. Try again.`);
    return 0;
  }
  terminal.write(quoteHeader(listed.length, quoteRequestId, quoteRequest, params.tokens));
  terminal.write('');
  const { quote: chosen, expired } = await pickQuote(terminal, listed, now, params.tokens);
  if (!chosen) {
    terminal.write(
      expired
        ? 'Request new quotes to pay.'
        : `Nothing signed. Award later with: award-quote ${quoteRequestId}`,
    );
    return 0;
  }
  const code = await payQuote({
    ...pay,
    terminal,
    quoteRequestId,
    quoteRequest,
    quote: chosen,
    confirm: true,
  });
  return code ?? 0;
}
