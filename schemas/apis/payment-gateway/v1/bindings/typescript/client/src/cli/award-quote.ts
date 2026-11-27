#!/usr/bin/env node

import { Command, Option } from 'commander';
import { PaymentGatewayClient } from '../index';
import { PACKAGE_VERSION } from '../version';
import { DEFAULT_WAIT_SECONDS } from '../payment-tracking';
import { parseSeconds } from './parse-seconds';
import { runAwardQuote } from './award-command';
import { processTerminal } from './terminal';
import { loadCliEnv } from './load-env';
import { runCli } from './run-cli';

// Load an optional .env from the working directory before anything reads the
// environment. CLI-only: see load-env.ts for why the SDK must not do this.
loadCliEnv();

const program = new Command();

program
  .name('award-quote')
  .description(
    [
      'Award one quote from a quote request: sign the deposit for its source_amount and the',
      '  reserve naming its settler, and send both to the Atum Payment Gateway.',
      '',
      '  --from <file> [quote_id]       the quote request request-quote opened and printed.',
      '                                 Scripts use this; with no quote_id, the cheapest quote',
      '                                 (needs request-quote --max-source-amount).',
      '  <quote_request_id> [quote_id]  at a terminal only: with no quote_id, pick one with the',
      '                                 arrow keys. Shows what you pay and asks first.',
    ].join('\n'),
  )
  .version(PACKAGE_VERSION)
  .usage('[options] --from <file> [quote_id] | <quote_request_id> [quote_id]')
  .argument(
    '[ids...]',
    'With --from: the quote_id, optional. Without: the quote_request_id, then the quote_id (optional at a terminal)',
  )
  .option(
    '--from <file>',
    'The JSON request-quote printed from a script; the award signs the quote request it sent',
  )
  .option(
    '--gateway <url>',
    'Payment gateway URL (overrides GATEWAY_URL env; default: production-testnet)',
  )
  .option(
    '--request-id <id>',
    'Idempotency key of the award; seeds the deposit nonce. Defaults to award-<quote_id hex>, so a re-run of the same award resolves to the same payment',
  )
  .addOption(
    new Option('--provider <provider>', 'Depositor signing provider')
      .choices(['raw', 'turnkey'])
      .default('raw'),
  )
  .option(
    '--wait',
    'After awarding, keep checking the payment until its payout is on chain (finalizing) or it fails',
  )
  .addOption(
    new Option(
      '--wait-for <state>',
      'What --wait waits for: finalizing (default, payout on chain) or completed (payout final, minutes on some chains; raise --wait-seconds). Implies --wait',
    )
      .choices(['finalizing', 'completed'])
      .implies({ wait: true }),
  )
  .option(
    '--wait-seconds <n>',
    `How long --wait keeps checking (default: ${DEFAULT_WAIT_SECONDS}). A convenience bound only — giving up does not affect the payment`,
    parseSeconds('--wait-seconds'),
  )
  .option(
    '--solana-rpc-url <url>',
    'Solana RPC used to read the cluster clock for issued_at (falls back to the SOLANA_RPC_URL env var, then the public endpoint for the cluster)',
  )
  .addHelpText(
    'after',
    `
Signing (the quote request's sender signs the deposit and the reserve):
  raw (default)  PRIVATE_KEY=0x... (or prompted securely if unset)
  turnkey        --provider turnkey, with TURNKEY_ORGANIZATION_ID, TURNKEY_WALLET_ID,
                 TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY
  A quote request that names another account as quote_selector is awarded with the SDK.

Script:
  request-quote <sender> <amount> <sourceAsset> <receiver> <destinationAsset> --max-source-amount <cap> > quotes.json
  PRIVATE_KEY=0x... award-quote --from quotes.json --wait

At a terminal:
  award-quote <quote_request_id>   pick a quote with ↑/↓ and Enter, then confirm what you pay

With --from the deposit commits the quote request you sent, so a quote of a quote request
someone else opened cannot be awarded with it. Every quote's settler signature, and its signer
against the quote request's settler_requirements, is checked first.

Output (from a script):
  AwardRequest JSON    → stderr (for debugging/logging)
  PaymentResponse JSON → stdout (for parsing/automation)
  Outcome summary      → stderr

Exit codes (as send-payment):
  0  completed  — settled and final
  2  pending    — accepted, no result yet; follow it with payment-status <payment_id>, or use --wait
  3  failed     — failed or refunded, terminal; the quote request is spent, so open a new one
  4  refund_available — not delivered, funds still in escrow; submit refund_signature
  5  finalizing — paid on chain, not yet final; normally becomes completed
  1  no outcome obtained (refused, declined, unreachable gateway, bad arguments)

Exit 1 after the award was sent means unknown, not "nothing happened". Run the award again
as the error says (with the quote_id): it resolves to the payment if the award was made, and
makes it if not.`,
  )
  .action(async (ids: string[], options) => {
    const terminal = processTerminal();
    process.exit(
      await runAwardQuote({
        client: new PaymentGatewayClient({ BASE: options.gateway }),
        terminal,
        args: ids,
        from: options.from,
        requestId: options.requestId,
        provider: options.provider,
        solanaRpcUrl: options.solanaRpcUrl,
        wait: options.wait,
        waitFor: options.waitFor,
        waitSeconds: options.waitSeconds,
      }),
    );
  });

runCli(program);
