#!/usr/bin/env node

import { Command } from 'commander';
import { PaymentGatewayClient } from '../index';
import { ApiError } from '../generated/core/ApiError';
import { PACKAGE_VERSION } from '../version';
import { loadCliEnv } from './load-env';
import { runCli } from './run-cli';
import { describePaymentOutcome } from './payment-outcome';

// Load an optional .env from the working directory before anything reads the
// environment. CLI-only: see load-env.ts for why the SDK must not do this.
loadCliEnv();

/**
 * `payment-status` — read the current state of a payment
 * (GET /v1/payments/{id}/status). The status counterpart to `send-payment`
 * (which today only prints a status URL). Works for a payment_id from either
 * flow: the existing `send-payment` submit, or a Quote-API award. No signing
 * / private key needed.
 *
 * Output mirrors send-payment: the response is printed as JSON to stdout (for
 * parsing/automation, e.g. `| jq`), with a line on stderr saying what the status
 * means for a re-attempt.
 *
 * Unlike send-payment, the exit code reports whether the *query* succeeded, not
 * what the payment did — a failed payment read successfully is exit 0. That keeps
 * `payment-status <id> | jq` working and keeps "the gateway is unreachable"
 * distinct from "the payment failed", which are different problems.
 */
const program = new Command();

program
  .name('payment-status')
  .description('Fetch the status of a payment (no signing required)')
  .version(PACKAGE_VERSION)
  .argument('<paymentId>', 'The payment_id returned by send-payment (or a Quote-API award)')
  .option(
    '--gateway <url>',
    'Payment gateway URL (overrides GATEWAY_URL env; default: production-testnet)',
  )
  .addHelpText(
    'after',
    `
Example:
  payment-status --gateway http://localhost:8080 0x<payment_id>

Status values: pending | finalizing | completed | failed | refunding | refund_available | refunded

Output:
  Response JSON     -> stdout (for parsing/automation, e.g. | jq)
  What it means     -> stderr

Exit code reports whether the lookup worked (0) or not (1), not the payment's
outcome — read \`status\` for that, or use send-payment's exit code.`,
  )
  .action(async (paymentId, options) => {
    try {
      const client = new PaymentGatewayClient({ BASE: options.gateway });
      const response = await client.payments.getPaymentStatus({ paymentId });

      // Response JSON -> stdout for parsing/automation (mirrors send-payment).
      console.log(JSON.stringify(response, null, 2));

      // Say what the status means for a re-attempt. The exit code deliberately does not carry it:
      // this command reports whether the lookup worked.
      console.error(
        describePaymentOutcome({
          status: response.status,
          paymentId: response.payment_id ?? paymentId,
          errorCode: response.error?.code,
          payoutTransaction: response.transactions?.fulfillment?.transaction_hash,
        }).summary,
      );

      process.exit(0);
    } catch (error) {
      if (error instanceof ApiError && error.body) {
        console.log(JSON.stringify(error.body, null, 2));
      } else {
        console.error('\n❌ Error:', error instanceof Error ? error.message : String(error));
      }
      process.exit(1);
    }
  });

runCli(program);
