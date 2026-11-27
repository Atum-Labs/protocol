#!/usr/bin/env node

import { Command, Option } from 'commander';
import { readFileSync } from 'fs';
import {
  PaymentGatewayClient,
  DEFAULT_PAYMENT_QUOTE_DEADLINE_SECONDS,
  DEFAULT_FULFILLMENT_DEADLINE_SECONDS,
  assertRequestSignable,
} from '../index';
import { parseSeconds } from './parse-seconds';
import { runCli } from './run-cli';
import { ApiError } from '../generated/core/ApiError';
import { PACKAGE_VERSION } from '../version';
import type { PaymentRequest } from '../generated';
import { EXIT_COMPLETED, EXIT_ERROR } from './payment-outcome';
import { DEFAULT_WAIT_SECONDS } from '../payment-tracking';
import { submitAndReport } from './submit-and-report';
import {
  BUILD_ONLY_OPTIONS,
  HIDDEN_BUILD_ONLY_OPTIONS,
  SUBMIT_ONLY_OPTIONS,
  attributeNameOf,
} from './option-groups';
import { getChainAdapter as getSenderAuthAdapter } from '@atum-labs/payment-request-sender-auth';
import { createSenderSigner } from '../signers';
import { requirePinnedSender } from '../signers/pinned-address';
import { assetChainId } from '../asset-identifier';
import type { SenderSigner } from '../signers';
import { loadTurnkeyConfigFromEnv } from './turnkey-env';
import { promptPrivateKey } from './prompt-private-key';
import { isCanonicalPositiveInteger } from '../max-source-amount';
import { loadCliEnv } from './load-env';

// Load an optional .env from the working directory before anything reads the
// environment. CLI-only: see load-env.ts for why the SDK must not do this.
loadCliEnv();

// Helper function to collect multiple values for an option
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

const program = new Command();

program
  .name('send-payment')
  // Hard-wrapped and indented on purpose. Commander re-wraps a description unless it finds a line
  // break followed by a space (Help.wrap's `manualIndent`), so the indent below is what stops it
  // reflowing this into ragged lines -- and it doubles as the callout's visual offset.
  .description(
    [
      'Send a cross-chain payment through Atum Payment Gateway.',
      '',
      '  Normally this prepares, signs and submits in one step. To have the payment',
      '  approved before it is sent, split it in two: --prepare-only writes the signed',
      '  request out, --submit sends one back in.',
      '',
      '  PREREQUISITE: paying from an EVM or Tron chain needs a one-off ERC-20/TRC-20',
      '  approval of the source token for the Permit2 contract, made by the sender',
      '  before this runs. Without it the payment is built and signed correctly and',
      '  still fails to settle. Run `approve-permit2` to grant it; contract addresses',
      '  are at the end of this help.',
    ].join('\n'),
  )
  // The arguments below are declared optional so --submit can be used without them, but only one
  // of the two forms ever wants a given set. Commander would otherwise derive a usage line reading
  // "[sender] [amount] ..." -- which describes neither form honestly -- so both are spelled out
  // here and the action enforces the choice between them.
  .usage(
    '[options] <sender> <amount> <sourceAsset> <receiver> <destinationAsset>\n' +
      '   or: send-payment --submit <file> [options]',
  )
  .version(PACKAGE_VERSION)
  .argument('[sender]', 'Depositor address (e.g., 0xF0D0...)')
  .argument(
    '[amount]',
    "Amount the receiver gets, in the destination token's smallest units (e.g. 100000 for 0.10 USDC)",
  )
  .argument('[sourceAsset]', 'Source asset in CAIP-19 format')
  .argument('[receiver]', 'Destination account address')
  .argument('[destinationAsset]', 'Destination asset in CAIP-19 format')
  .option(
    '--gateway <url>',
    'Payment gateway URL (overrides GATEWAY_URL env; default: production-testnet)',
  )
  .option(
    '--request-id <id>',
    'Idempotency key; seeds the on-chain deposit nonce. Re-run with the SAME id to re-attempt one payment — it resolves to the original instead of paying twice. Omitted, an id is generated and printed, which makes every bare re-run a SEPARATE payment (a second charge).',
  )
  .option('--request-id-prefix <prefix>', 'Custom request ID prefix (default: pmt-gw-cli)')
  .option(
    '--max-source-amount <amount>',
    'Required to build: the most the payer authorizes from source, in smallest units (e.g. the quoted source_amount plus slippage). Signed into the Permit2; never derived',
  )
  .option(
    '--quote-deadline-seconds <n>',
    `Quote collection window in seconds (default: ${DEFAULT_PAYMENT_QUOTE_DEADLINE_SECONDS})`,
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
  .option('--provider <raw|turnkey>', 'Sender signing provider', 'raw')
  .option(
    '--auto-accept',
    'Award the first valid quote at or under max_source_amount instead of waiting for quote_deadline; faster, but gives up competitive pricing',
  )
  .option(
    '--wait',
    'After submitting, keep checking the payment until its payout is on chain (finalizing) or it fails',
  )
  .addOption(
    new Option(
      '--wait-for <state>',
      'What --wait waits for: finalizing (default, payout on chain) or completed (payout final, minutes on some chains; raise --wait-seconds). Implies --wait',
    )
      .choices(['finalizing', 'completed'])
      .implies({ wait: true })
      // Declared here as well as on --prepare-only, so the refusal names the flag that was typed
      // rather than the --wait it implies.
      .conflicts('prepareOnly'),
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
  .option(
    '--stellar-rpc-url <url>',
    'Stellar Soroban RPC used to read the ledger clock for issued_at and the delegate epoch (falls back to the STELLAR_RPC_URL env var, then the public testnet endpoint; other networks need one)',
  )
  .option(
    '--delegate-signer',
    "Stellar: PRIVATE_KEY is the seed of a delegate signer registered for <sender> (a G or C account), not <sender>'s own key, so the check that the key derives <sender> is skipped. A verifier that reads no chain refuses such a payment; without the flag the key must be <sender>'s own",
  )
  .option(
    '--stellar-delegate-epoch <n>',
    "Stellar: the epoch of the payer's delegate record, from the escrow's get_delegate. When omitted it is read through the Soroban RPC, which needs the @stellar/stellar-sdk package",
  )
  // Declared as a conflict rather than checked in the action so commander refuses the combination
  // before anything runs — in particular before the private-key prompt. Every submit-only option
  // has nothing to act on when nothing is submitted.
  .addOption(
    new Option(
      '--prepare-only',
      'Build and sign the payment request, print it, and stop without submitting. For inspecting an authorization, or for review before paying. Send it later with --submit',
    ).conflicts(SUBMIT_ONLY_OPTIONS.map(attributeNameOf)),
  )
  // The other half of --prepare-only. Declared as a conflict for the same reason: there is nothing
  // to prepare when the request already exists.
  //
  // It also conflicts with every option that only shapes a request being built. Commander checks a
  // conflict against the option's SOURCE, not its value, so an option left at its default does not
  // trigger one -- only a flag the caller actually typed. Without this the build-only flags would be
  // accepted here and silently ignored, which is at its worst with --request-id: a caller passing a
  // new one to force a separate payment would get the file's original id instead, and the gateway
  // would dedup the send onto the earlier payment.
  .addOption(
    new Option(
      '--submit <file>',
      'Submit a request built earlier by --prepare-only, instead of building one. Signs nothing and needs no private key. Use - to read stdin',
    ).conflicts(
      ['prepareOnly', ...BUILD_ONLY_OPTIONS, ...HIDDEN_BUILD_ONLY_OPTIONS].map(attributeNameOf),
    ),
  )
  .addHelpText(
    'after',
    `
CAIP-19 Examples:
  EVM ERC20:   eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831
  Tron TRC20:  tron:shasta/trc20:TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs
  Solana SPL:  solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  Stellar SEP-41: stellar:testnet/sep41:<C... token contract id>

Signing (default --provider raw):
  Private key: set PRIVATE_KEY=0x... send-payment ... (or prompted securely if unset)
  Turnkey:     --provider turnkey, with TURNKEY_ORGANIZATION_ID, TURNKEY_WALLET_ID,
               TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY.
               The <sender> arg is verified against the Turnkey wallet address.

Output:
  PaymentRequest JSON  → stderr (for debugging/logging)
  PaymentResponse JSON → stdout (for parsing/automation)
  Outcome summary      → stderr

With --wait the JSON is printed once the wait ends, reporting the payment's state
as of the last check rather than as of the submit.

--prepare-only:
  Builds and signs the request, prints it to stdout, and stops. Nothing is
  submitted and no payment exists. The document printed is exactly what would
  have been POSTed, so you can inspect it, have it reviewed, then send it with
  \`send-payment --submit <file>\` (or pipe it:
  \`send-payment --prepare-only ... | send-payment --submit -\`).

  It still contacts the gateway, which is where the corridor addresses come from,
  so it is not an offline mode.

  The file it writes is a signed authorization, not a draft. Anyone holding it can
  send it with --submit, which needs no key. Treat it like a signed cheque: keep it
  where you would keep a credential, and delete it once the payment is sent or the
  request is abandoned.

  Re-preparing with the same --request-id targets the same payment: the deposit nonce
  comes from the id, so it cannot pay twice. It does not reproduce the same bytes —
  the deadlines are stamped from the clock and the signature covers them.

  Intending to submit later? The document is only submittable while its quote
  window is open, and the default is ${DEFAULT_PAYMENT_QUOTE_DEADLINE_SECONDS}s, so widen it with
  --quote-deadline-seconds to leave room to read it. Raise --fulfillment-deadline-seconds
  by the same amount: the payout has to fit in what is left after the quote window.

  Widen it by tens of seconds, not minutes. The window is also the auction: the
  gateway waits it out before choosing a settler, and settler quotes expire on
  their own, so an over-long window ends in QUOTES_EXPIRED — which is terminal,
  and a fresh attempt then needs a NEW --request-id. --auto-accept can award
  before the window closes, but settlers still decline a window longer than they
  hold their price, so keep it short either way.

Exit codes:
  0  completed  — settled and final
  2  pending    — accepted, no result yet (also refunding); follow it with
                  payment-status <payment_id>, or use --wait
  3  failed     — failed or refunded, terminal; a fresh attempt needs a NEW --request-id
  4  refund_available — not delivered, funds still in escrow; submit refund_signature
                  from payment-status, and do not pay again under a new --request-id
  5  finalizing — paid on chain, not yet final; normally becomes completed
  1  no outcome obtained (rejected, unreachable gateway, bad arguments)

So \`send-payment ... && <next step>\` runs the next step only for a final payment. A
script that accepts a payment once it is paid on chain treats 5 as success too.

The table above describes a SUBMITTED payment, so it does not apply to
--prepare-only: there, 0 means the request was built and signed, not that anything
was paid. Do not chain a payment-conditional step off a --prepare-only run.

Exit 1 means unknown, not "nothing happened" — a request that timed out may still
have been accepted, and you may have no payment_id to look up. Re-run with the same
--request-id, which resolves to the payment if one was created and creates it if not.

After submission, you can check payment status at eg http://PAYMENT_GW/v1/payments/PAYMENT_ID/status

Permit2 contract addresses, for the approval named under PREREQUISITE above:
  EVM:          0x000000000022D473030F116dDEE9F6B43aC78BA3 (virtually all chains)
  Tron mainnet: TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m
  Tron Shasta:  TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp`,
  )
  .action(async (sender, amount, sourceAsset, receiver, destinationAsset, options) => {
    // Hoisted so the failure path (catch) can also surface it — a retry needs this exact id.
    let requestId: string | undefined;
    // Hoisted for the same reason as requestId: the failure path reads the document's deadline to
    // decide which recovery to advise.
    let submittedRequest: PaymentRequest | undefined;
    try {
      // Which of the two forms this is, settled before anything else runs. Commander cannot do it:
      // the arguments are optional so --submit can omit them, so "you gave neither / you gave both"
      // is ours to report. It comes first for the same reason the sender check below does -- a bad
      // invocation must never cost the user a secret.
      const corridor = [sender, amount, sourceAsset, receiver, destinationAsset];
      const supplied = corridor.filter((value) => value !== undefined).length;
      if (options.submit && supplied > 0) {
        throw new Error(
          '--submit sends a request that was already built, so the corridor arguments do not ' +
            'apply. Drop them, or drop --submit to build a new payment.',
        );
      }
      if (!options.submit && supplied < corridor.length) {
        throw new Error(
          'send-payment needs five arguments (sender, amount, sourceAsset, receiver, ' +
            `destinationAsset), or --submit <file> to send a request prepared earlier. Got ${supplied}.`,
        );
      }
      // Before the key prompt for the same reason: the cap is the payer's spend authorization, and
      // the library refuses to invent one, so a build without it can only fail later.
      if (!options.submit && options.maxSourceAmount === undefined) {
        throw new Error(
          'send-payment needs --max-source-amount <amount> to build a payment: the most the payer ' +
            "authorizes from source, in the source token's smallest units.",
        );
      }
      if (!options.submit && !isCanonicalPositiveInteger(options.maxSourceAmount)) {
        throw new Error(
          `--max-source-amount must be a positive base-10 integer in the source token's smallest ` +
            `units, got ${JSON.stringify(options.maxSourceAmount)}.`,
        );
      }

      // --submit: the authorization is already inside the document, so there is nothing to build
      // and no key to ask for. Everything from the POST onwards is shared with the form below.
      if (options.submit) {
        const prepared = await readPaymentRequest(options.submit);
        submittedRequest = prepared;
        requestId = prepared.request_id;
        warnIfQuoteWindowClosed(prepared);
        console.error(
          `submitting request_id ${requestId} (quote_deadline ${prepared.quote_deadline})`,
        );
        const submittedCode = await submitAndReport({
          client: new PaymentGatewayClient({ BASE: options.gateway }),
          paymentRequest: prepared,
          requestId,
          autoAccept: options.autoAccept,
          wait: options.wait,
          waitFor: options.waitFor,
          waitSeconds: options.waitSeconds,
        });
        process.exit(submittedCode);
      }

      // Both checks run before the key prompt below, in the order the arguments appear. Asking for
      // a private key first would cost the user a secret to learn about a bad argument.
      requirePinnedSender(sender);

      // Detect chain type from the CAIP-19 source asset. Parsing it here names a malformed
      // identifier before any key prompt or network call.
      const sourceChainId = assetChainId(sourceAsset);

      // Select the sender signer: private key (default) or Turnkey.
      let privateKey = '';
      let signer: SenderSigner;
      if (options.provider === 'turnkey') {
        // The <sender> arg is pinned so a wallet/address mismatch fails fast at init
        // rather than signing as the wrong depositor.
        signer = createSenderSigner(sourceChainId, {
          provider: 'turnkey',
          ...loadTurnkeyConfigFromEnv(),
          pinnedAddress: sender,
        });
      } else if (options.provider === 'raw') {
        // `||` not `??`: an empty PRIVATE_KEY="" should still prompt.
        privateKey = process.env.PRIVATE_KEY || (await promptPrivateKey());
        // Pin <sender> to the key so a wrong key/sender pair fails fast, matching
        // the Turnkey path above. A Stellar payer may sign with a separate delegate key, which
        // does not derive the sender, so that case is declared with --delegate-signer
        // and the pin is left off for it alone.
        if (options.delegateSigner && !sourceChainId.startsWith('stellar:')) {
          throw new Error('--delegate-signer applies only to a stellar: source asset');
        }
        signer = createSenderSigner(sourceChainId, {
          provider: 'raw',
          privateKey,
          ...(options.delegateSigner ? {} : { pinnedAddress: sender }),
        });
      } else {
        throw new Error(`Unknown --provider '${options.provider}' (expected 'raw' or 'turnkey')`);
      }

      // request_id is required by the library (no silent auto-gen). A CLI invocation is a distinct
      // one-shot payment, so generate an id when --request-id isn't given; pass --request-id <id>
      // to make a retry reproduce the SAME payment (idempotent).
      const resolvedRequestId =
        options.requestId ??
        `${options.requestIdPrefix || 'pmt-gw-cli'}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      requestId = resolvedRequestId;

      // The G strkey of the Stellar key that will sign, so the build can refuse a payer whose escrow
      // delegate is another key (the deposit would revert) before anything is signed.
      const stellarSigningKey =
        options.provider === 'raw' && sourceChainId.startsWith('stellar:')
          ? getSenderAuthAdapter(sourceChainId).deriveDelegateSigner?.(privateKey)
          : undefined;

      const client = new PaymentGatewayClient({ BASE: options.gateway });
      const allowed: string[] = [...options.allowSettler, ...options.whitelistSettler];
      const paymentRequest = await client.preparePaymentRequest({
        depositor: sender,
        fulfillmentAmount: amount,
        maxSourceAmount: options.maxSourceAmount,
        sourceAsset: sourceAsset,
        destinationAccount: receiver,
        destinationAsset: destinationAsset,
        requestId: resolvedRequestId,
        quoteDeadlineSeconds: options.quoteDeadlineSeconds,
        fulfillmentDeadlineSeconds: options.fulfillmentDeadlineSeconds,
        solanaRpcUrl: options.solanaRpcUrl || process.env.SOLANA_RPC_URL,
        stellarRpcUrl: options.stellarRpcUrl || process.env.STELLAR_RPC_URL,
        stellarDelegateEpoch: options.stellarDelegateEpoch,
        ...(stellarSigningKey !== undefined ? { stellarSigningKey } : {}),
        settlerRequirements: allowed.length > 0 ? { whitelist: allowed } : undefined,
      });

      // Sign via the selected provider (identical wire format either way).
      // delegateSigner is set only for Solana (ed25519 isn't recoverable) and is
      // attached as payload.delegate_signer for the on-chain verify.
      const signedMessage = paymentRequest.sender_auth.signed_messages[0];
      // A Stellar key signs 32 bytes as a transaction signature too: sign only a deposit digest.
      assertRequestSignable(paymentRequest, signer);
      // Raw: the CLI names no escrow scheme, and one carried in the request data is never used.
      const { signature, delegateSigner } = await signer.sign({
        ...signedMessage,
        svmMessageScheme: '',
      });
      signedMessage.signature = signature;
      if (delegateSigner) {
        signedMessage.payload = {
          ...(signedMessage.payload ?? {}),
          delegate_signer: delegateSigner,
        };
      }

      // --prepare-only stops here. The signed request is the result in this mode, so it goes to
      // stdout — where the stderr echo below would leave it unpipeable — and nothing is submitted.
      if (options.prepareOnly) {
        console.log(JSON.stringify(paymentRequest, null, 2));
        // Deliberately not "the same document". The deadlines are stamped from the clock on every
        // run and the signature covers them, so re-preparing produces different bytes. What it does
        // reproduce is the PAYMENT: the deposit nonce is derived from the request id and the gateway
        // dedups on it. Claiming "same document" would invite a byte comparison that fails on every
        // honest run, and teach the reader to ignore the difference.
        console.error(
          `request_id: ${requestId}  (re-preparing with this id targets the same payment, but stamps ` +
            'fresh deadlines and a fresh signature, so the document itself will differ)',
        );
        // The window is the thing that catches people out: the gateway refuses a request whose
        // quote deadline has passed, and the default is measured in seconds. Print the actual
        // instant rather than a rule of thumb, so "is this still submittable?" is answerable.
        console.error(
          `quote_deadline: ${paymentRequest.quote_deadline}  (the gateway refuses this document after that instant; pass --quote-deadline-seconds to widen it)`,
        );
        console.error(
          'prepared: nothing was submitted and no payment exists. Send it with `send-payment --submit <file>`.',
        );
        // The file is the authorization, not a draft of one. Said at the moment it lands on disk,
        // because that is when it starts being something worth protecting.
        console.error(
          'KEEP IT SAFE: this file is a signed authorization for this payment, not a draft. Anyone ' +
            'holding it can send it, with no key. Delete it once the payment is sent or the request ' +
            'is abandoned.',
        );
        process.exit(EXIT_COMPLETED);
      }

      // Output PaymentRequest to stderr as JSON
      console.error(JSON.stringify(paymentRequest, null, 2));
      console.error(
        `request_id: ${requestId}  (re-run with --request-id ${requestId} to retry this same payment)`,
      );

      const exitCode = await submitAndReport({
        client,
        paymentRequest,
        requestId,
        autoAccept: options.autoAccept,
        wait: options.wait,
        waitFor: options.waitFor,
        waitSeconds: options.waitSeconds,
      });
      process.exit(exitCode);
    } catch (error) {
      // If this is an API error, we have a JSON response - output it to stdout
      if (error instanceof ApiError && error.body) {
        console.log(JSON.stringify(error.body, null, 2));
      } else {
        // For non-API errors (network, parsing, etc.), use human-readable output
        console.error('\n❌ Error:', error instanceof Error ? error.message : String(error));
      }

      // The failure path is exactly when a retry matters — surface the id to reuse. (This is not
      // a claim the payment failed cleanly; a submit may have reached the gateway. Reusing the id
      // is safe: the gateway dedups on it and the deposit nonce is derived from it.)
      // The recovery differs by form, and under --submit it differs again by WHY the send failed.
      // A refused connection or a bad --gateway fails in milliseconds with the document still good,
      // so the file is reusable; a timeout outlasts the default quote window, so by the time it is
      // reported the document is spent and only a freshly prepared one can work. The deadline says
      // which case this is, so read it rather than assuming the expensive one.
      if (requestId) {
        // "may still be open" rather than "is open", in both directions of the hedge. A deadline this
        // machine cannot parse lands here too, and even a readable one is only open by THIS clock --
        // the gateway compares against its own, which is why an expired window is warned about
        // rather than refused. Suggesting the cheap recovery first is still right; claiming it will
        // work is not ours to say.
        const windowStillOpen = submittedRequest !== undefined && quoteWindowOpen(submittedRequest);
        console.error(
          options.submit
            ? windowStillOpen
              ? `request_id: ${requestId}  (the quote window on this file may still be open, so ` +
                `sending it again is the first thing to try)`
              : `request_id: ${requestId}  (this file's quote window has closed, so sending it again ` +
                `will be refused. Ask whoever holds the key to prepare a fresh request with ` +
                `--request-id ${requestId}: that targets this same payment, so it cannot pay twice)`
            : `request_id: ${requestId}  (re-run with --request-id ${requestId} to retry this same payment)`,
        );
      }

      process.exit(EXIT_ERROR);
    }
  });

/**
 * Read and sanity-check a prepared request.
 *
 * The checks are deliberately shallow: the gateway validates the document properly, and duplicating
 * its rules here would create a second, drifting definition of what is valid. What they do catch is
 * the handful of mistakes that would otherwise be reported as an opaque rejection — the wrong file,
 * a truncated one, or one that was never signed.
 *
 * @param file - path to a JSON file, or `-` for stdin
 * @returns the parsed request, ready to submit
 */
async function readPaymentRequest(file: string): Promise<PaymentRequest> {
  // Reading stdin when nothing is piped in would block on the terminal with no output, which reads
  // as a hang rather than a mistake, so refuse that up front.
  if (file === '-' && process.stdin.isTTY) {
    throw new Error('--submit - reads stdin, but nothing is piped in. Pass a file path instead');
  }
  const raw = file === '-' ? await readStdin() : readFileSync(file, 'utf8');
  if (raw.trim() === '') {
    throw new Error(
      file === '-'
        ? 'nothing arrived on stdin. Pipe a prepared request in, or pass a file path instead'
        : `${file} is empty`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${file === '-' ? 'stdin' : file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file === '-' ? 'stdin' : file} does not hold a PaymentRequest object`);
  }

  const request = parsed as PaymentRequest;
  if (!request.request_id) {
    throw new Error(
      'this does not look like a PaymentRequest: no request_id. Produce one with `send-payment --prepare-only`',
    );
  }

  // The whole point of this command is that the authorization is already in the file. Submitting an
  // unsigned request would be rejected remotely for a reason that reads like a gateway problem.
  const signature = request.sender_auth?.signed_messages?.[0]?.signature;
  if (!signature) {
    throw new Error(
      'this request carries no sender_auth signature, so it cannot be submitted. ' +
        '`send-payment --prepare-only` signs the request it prints; a request built with the SDK ' +
        'needs signPaymentRequest before it is submittable',
    );
  }

  return request;
}

/**
 * Read all of stdin.
 *
 * Streamed rather than read synchronously from fd 0. A shell leaves the read end of a pipe in
 * non-blocking mode, so a synchronous read fails outright with EAGAIN whenever the writer has not
 * produced anything yet — which is exactly the `--prepare-only | --submit -`
 * case, since the producer has a gateway round trip to make first.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Say so when the request's quote window looks to have closed already, which is the failure this
 * two-step flow invites: prepare, read it carefully, submit a minute later.
 *
 * A warning rather than a refusal, deliberately. The gateway compares against ITS clock, and this
 * one may be skewed; refusing locally would strand a request the payer already authorized and that
 * the gateway would have accepted. The gateway is the authority, so the request still goes.
 */
function quoteWindowOpen(request: PaymentRequest): boolean {
  const deadline = Date.parse(request.quote_deadline ?? '');
  // An unreadable deadline counts as open: the gateway is the authority on the window, and guessing
  // "closed" here would send the caller down the more expensive recovery for no reason.
  return Number.isNaN(deadline) || deadline > Date.now();
}

function warnIfQuoteWindowClosed(request: PaymentRequest): void {
  if (quoteWindowOpen(request)) return;
  console.error(
    `warning: this request's quote_deadline (${request.quote_deadline}) has passed by this machine's ` +
      'clock, and the gateway refuses a closed quote window. Sending anyway, since the gateway goes ' +
      'by its own clock. If it rejects this, prepare a fresh request — and give the next one a ' +
      'longer --quote-deadline-seconds, which is an option of the form that builds a request, not ' +
      'of --submit.',
  );
}

runCli(program);
