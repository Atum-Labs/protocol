#!/usr/bin/env node

import { Command, Option } from 'commander';
import {
  PaymentGatewayClient,
  DEFAULT_QUOTE_DEADLINE_SECONDS,
  DEFAULT_FULFILLMENT_DEADLINE_SECONDS,
} from '../index';
import { DEFAULT_WAIT_SECONDS } from '../payment-tracking';
import { EXIT_ERROR } from './payment-outcome';
import { parseSeconds } from './parse-seconds';
import { attributeNameOf } from './option-groups';
import { batchQuoteRequest, offerQuotes } from './pay-quote';
import { tokenInfos } from './token-amount';
import { describeDelivery } from './quote-table';
import { printCliError, processTerminal } from './terminal';
import { runCli } from './run-cli';
import { PACKAGE_VERSION } from '../version';
import { loadCliEnv } from './load-env';

// Load an optional .env from the working directory before anything reads the
// environment. CLI-only: see load-env.ts for why the SDK must not do this.
loadCliEnv();

/**
 * `request-quote` — open a quote request and collect quotes. Opening one signs nothing.
 *
 * At a terminal it lists the quotes, asks which to award, and pays it in the same run. From a
 * script (stdout or stdin not a terminal) it prints the response JSON with the body it sent, and
 * signs nothing; the script awards with `award-quote --from`.
 */

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** Options that only act on paying, which happens only at a terminal. */
const PAY_OPTIONS = ['--provider', '--wait', '--wait-for', '--wait-seconds', '--solana-rpc-url'];

const program = new Command();

program
  .name('request-quote')
  .description(
    [
      'Open a quote request on the Atum Payment Gateway and collect quotes. Opening one signs nothing.',
      '',
      '  At a terminal it lists the quotes, asks which to award, and pays it in the same run.',
      '  From a script it prints the quotes and the quote request it sent as JSON, and stops;',
      '  award one with award-quote --from.',
    ].join('\n'),
  )
  .version(PACKAGE_VERSION)
  .argument('<sender>', 'Depositor / originator address (e.g., 0xF0D0...) — the source account')
  .argument(
    '<amount>',
    "Amount the receiver gets, in the destination token's smallest units (e.g. 100000 for 0.10 USDC)",
  )
  .argument('<sourceAsset>', 'Source asset in CAIP-19 format')
  .argument('<receiver>', 'Destination account address')
  .argument('<destinationAsset>', 'Destination asset in CAIP-19 format')
  .option(
    '--gateway <url>',
    'Payment gateway URL (overrides GATEWAY_URL env; default: production-testnet)',
  )
  .option(
    '--request-id <id>',
    'Idempotency key. Re-run with the SAME id to recover one quote request — it resolves to the original instead of opening a second. Omitted, an id is generated and printed, which makes every bare re-run a SEPARATE quote request.',
  )
  .option('--request-id-prefix <prefix>', 'Custom request ID prefix (default: quote-gw-cli)')
  .option(
    '--max-source-amount <amount>',
    'Cap on what to spend from source (smallest units); quotes above it are filtered',
  )
  .option(
    '--quote-deadline-seconds <n>',
    `Collection window length in seconds (default: ${DEFAULT_QUOTE_DEADLINE_SECONDS})`,
    parseSeconds('--quote-deadline-seconds'),
  )
  .option(
    '--fulfillment-deadline-seconds <n>',
    `Seconds until the payout must be mined; pass more for large payments (default: ${DEFAULT_FULFILLMENT_DEADLINE_SECONDS})`,
    parseSeconds('--fulfillment-deadline-seconds'),
  )
  .option(
    '--allow-settler <did>',
    'Only take quotes from this settler DID (repeatable)',
    collect,
    [],
  )
  .addOption(new Option('--whitelistSettler <did>').argParser(collect).default([]).hideHelp())
  .addOption(
    new Option(
      '--provider <provider>',
      'Paying at a terminal: signing provider (default: raw)',
    ).choices(['raw', 'turnkey']),
  )
  .option(
    '--wait',
    'Paying at a terminal: keep checking the payment until its payout is on chain (finalizing) or it fails',
  )
  // After --wait: declared first, --no-wait would default wait to true.
  .option(
    '--no-wait',
    'Return the quote_request_id at once, before quotes are collected; list them later with quote-status',
  )
  .addOption(
    new Option(
      '--wait-for <state>',
      'Paying at a terminal: what --wait waits for, finalizing (default) or completed. Implies --wait',
    )
      .choices(['finalizing', 'completed'])
      .implies({ wait: true }),
  )
  .option(
    '--wait-seconds <n>',
    `Paying at a terminal: how long --wait keeps checking (default: ${DEFAULT_WAIT_SECONDS})`,
    parseSeconds('--wait-seconds'),
  )
  .option(
    '--solana-rpc-url <url>',
    'Paying at a terminal: Solana RPC used to read the cluster clock for issued_at (falls back to SOLANA_RPC_URL)',
  )
  .addHelpText(
    'after',
    `
CAIP-19 Examples:
  EVM ERC20:   eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831
  Tron TRC20:  tron:shasta/trc20:TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs
  Solana SPL:  solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

At a terminal: pick a quote with ↑/↓ and Enter, and pay it in one run. Signing as send-payment: PRIVATE_KEY
(or prompted securely if unset), or --provider turnkey with the TURNKEY_* variables.

  request-quote <sender> <amount> <sourceAsset> <receiver> <destinationAsset> --max-source-amount <cap> --wait

From a script: the response JSON on stdout, plus quote_request, the body it sent. Nothing is
signed. Award the cheapest quote (this needs --max-source-amount), or one quote_id, from that
output:

  request-quote <sender> <amount> <sourceAsset> <receiver> <destinationAsset> --max-source-amount <cap> > quotes.json
  award-quote --from quotes.json [quote_id]

Amounts you pass are in each token's smallest units, as the API carries them. At a terminal,
amounts are also shown as tokens (0.1 USDC) where the gateway lists the token.`,
  )
  .action(async (sender, amount, sourceAsset, receiver, destinationAsset, options) => {
    const terminal = processTerminal();
    try {
      if (!terminal.interactive) {
        // Typed flags only: --wait-for implies --wait, and --no-wait sets wait to false.
        const given = PAY_OPTIONS.filter((flag) => {
          const name = attributeNameOf(flag);
          return program.getOptionValueSource(name) === 'cli' && options[name] !== false;
        });
        if (given.length) {
          throw new Error(
            `${given.join(', ')} ${given.length === 1 ? 'acts' : 'act'} on paying, which ` +
              'request-quote does only at a terminal. From a script, pay with award-quote --from.',
          );
        }
      }
      const client = new PaymentGatewayClient({ BASE: options.gateway });

      // request_id is required by the library (no silent auto-gen). A CLI invocation is a
      // distinct one-shot request, so generate an id when --request-id isn't given; pass
      // --request-id <id> to make a re-run recover the SAME quote request (idempotent).
      const resolvedRequestId =
        options.requestId ??
        `${options.requestIdPrefix || 'quote-gw-cli'}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const allowed: string[] = [...options.allowSettler, ...options.whitelistSettler];

      // Read before the quote request is prepared, whose quote window starts then.
      const tokens = terminal.interactive
        ? await tokenInfos(client, [sourceAsset, destinationAsset])
        : undefined;
      const quoteRequest = await client.prepareQuoteRequest({
        depositor: sender,
        fulfillmentAmount: amount,
        sourceAsset,
        destinationAccount: receiver,
        destinationAsset,
        maxSourceAmount: options.maxSourceAmount,
        requestId: resolvedRequestId,
        quoteDeadlineSeconds: options.quoteDeadlineSeconds,
        fulfillmentDeadlineSeconds: options.fulfillmentDeadlineSeconds,
        settlerRequirements: allowed.length > 0 ? { whitelist: allowed } : undefined,
      });

      if (terminal.interactive) {
        terminal.write(`Collecting quotes: ${describeDelivery(quoteRequest, tokens)} …`);
      } else {
        console.error(JSON.stringify(quoteRequest, null, 2));
        console.error(
          `request_id: ${resolvedRequestId}  (re-run with --request-id ${resolvedRequestId} to recover this same quote request)`,
        );
      }

      // --no-wait sets wait to false; --wait (paying) and the default both collect first.
      const response = await client.quoteRequests.createQuoteRequest({
        requestBody: quoteRequest,
        wait: options.wait !== false,
      });
      const batchRequest = batchQuoteRequest(quoteRequest, response);
      if (batchRequest !== quoteRequest) {
        const note = `Recovered quote request ${response.quote_request_id}, opened earlier with this request_id.`;
        if (terminal.interactive) terminal.write(note);
        else console.error(note);
      }

      if (!terminal.interactive) {
        // award-quote --from signs this body: this run's fields, with the batch's own deadlines on a replay.
        console.log(JSON.stringify({ ...response, quote_request: batchRequest }, null, 2));
        process.exit(0);
      }
      process.exit(
        await offerQuotes({
          client,
          terminal,
          quoteRequest: batchRequest,
          response,
          tokens,
          provider: options.provider,
          solanaRpcUrl: options.solanaRpcUrl,
          wait: options.wait === true,
          waitFor: options.waitFor,
          waitSeconds: options.waitSeconds,
        }),
      );
    } catch (error) {
      printCliError(error, terminal);
      process.exit(EXIT_ERROR);
    }
  });

runCli(program);
