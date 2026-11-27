#!/usr/bin/env node

import { Command } from 'commander';
import { PaymentGatewayClient } from '../index';
import { PACKAGE_VERSION } from '../version';
import { formatQuoteStatus } from './quote-table';
import { tokenInfos } from './token-amount';
import { printCliError, processTerminal } from './terminal';
import { loadCliEnv } from './load-env';
import { runCli } from './run-cli';

// Load an optional .env from the working directory before anything reads the
// environment. CLI-only: see load-env.ts for why the SDK must not do this.
loadCliEnv();

/**
 * `quote-status` — read a quote request and its quotes (GET /v1/payments/quote-requests/{id}).
 * At a terminal it prints a table; from a script, the response JSON on stdout. Signs nothing.
 */
const program = new Command();

program
  .name('quote-status')
  .description('Fetch the status of a quote-request batch (no signing required)')
  .version(PACKAGE_VERSION)
  .argument('<quoteRequestId>', 'The quote_request_id (qr_...) returned by request-quote')
  .option(
    '--gateway <url>',
    'Payment gateway URL (overrides GATEWAY_URL env; default: production-testnet)',
  )
  .addHelpText(
    'after',
    `
Example:
  quote-status --gateway http://localhost:8080 qr_019f27b9-420d-7353-8263-0cf310670a77

Status values: collecting | ready | awarded | expired

Output:
  At a terminal: a table of the quotes, cheapest first
  From a script: response JSON -> stdout (for parsing/automation, e.g. | jq)`,
  )
  .action(async (quoteRequestId, options) => {
    const terminal = processTerminal();
    try {
      const client = new PaymentGatewayClient({ BASE: options.gateway });
      const response = await client.quoteRequests.getQuoteRequestStatus({ quoteRequestId });

      if (!terminal.interactive) {
        console.log(JSON.stringify(response, null, 2));
        process.exit(0);
      }
      const sources = (response.quotes ?? []).map(
        (q) => (q.fulfillment_quote as { source?: { id?: unknown } } | null)?.source?.id,
      );
      const tokens = await tokenInfos(
        client,
        [...new Set(sources)].filter((id): id is string => typeof id === 'string'),
      );
      for (const line of formatQuoteStatus(quoteRequestId, response, Date.now(), tokens)) {
        terminal.write(line);
      }
      process.exit(0);
    } catch (error) {
      printCliError(error, terminal);
      process.exit(1);
    }
  });

runCli(program);
