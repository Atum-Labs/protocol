#!/usr/bin/env node

import { Command } from 'commander';
import { Wallet, JsonRpcProvider, VoidSigner } from 'ethers';
import {
  ensureSourceApproval,
  isUnconfirmed,
  needsSourceApproval,
  parseAssetIdentifier,
  PERMIT2_CONTRACT_ADDRESS,
  type ApprovalParams,
} from '../index';
import { PACKAGE_VERSION } from '../version';
import { CliInputError } from './cli-input-error';
import { loadCliEnv } from './load-env';
import { createSenderSigner } from '../signers';
import { promptPrivateKey } from './prompt-private-key';
import { runCli } from './run-cli';

// Load an optional .env from the working directory before anything reads the
// environment. CLI-only: see load-env.ts for why the SDK must not do this.
loadCliEnv();

/**
 * The chain client the approval runs through: an ethers signer on EVM, a TronWeb instance on
 * Tron. `privateKey` is omitted for --check, which only reads.
 *
 * Both are built here rather than inside the SDK: the SDK takes a connected client and never
 * chooses an RPC endpoint, so picking one is exactly the CLI's job.
 */
type ChainClient = Pick<ApprovalParams, 'signer' | 'tronWeb'>;

function evmClient(rpcUrl: string, owner: string, privateKey?: string): ChainClient {
  const provider = new JsonRpcProvider(rpcUrl);
  // VoidSigner is a real signer bound to an address with no key: it can read the allowance and
  // would refuse to send, which is exactly the guarantee --check makes.
  return {
    signer: privateKey ? new Wallet(privateKey, provider) : new VoidSigner(owner, provider),
  };
}

async function tronClient(
  rpcUrl: string,
  owner: string,
  privateKey?: string,
): Promise<ChainClient> {
  let tronweb: typeof import('tronweb');
  try {
    tronweb = await import('tronweb');
  } catch {
    // tronweb is an OPTIONAL peer dependency: it is ~13 MB with its own deps, and the large
    // majority of installs never pay from Tron. Name the one command that fixes it.
    throw new CliInputError(
      'Approving on Tron needs the tronweb package, which is an optional peer dependency so ' +
        'that EVM-only installs do not carry it. Install it alongside this CLI:\n' +
        '  npm install -g tronweb',
    );
  }

  const tronWeb = new tronweb.TronWeb(
    privateKey ? { fullHost: rpcUrl, privateKey } : { fullHost: rpcUrl },
  );
  // Without an address set, TronWeb refuses even a constant call, so --check would fail on a
  // chain it never reached.
  tronWeb.setAddress(owner);
  // Deliberately unannotated and uncast: assigning a REAL TronWeb into ChainClient here is what
  // proves an integrator can pass theirs without ceremony. A cast would hide a regression in
  // TronWebLike from us and hand it to them instead.
  return { tronWeb };
}

/**
 * `approve-permit2` — grant the one-off source-token approval every EVM payment depends on.
 *
 * The escrow moves the source token through Permit2, so the token contract has to be told that
 * Permit2 may move it. Without that, `send-payment` builds and signs a correct request, the
 * gateway accepts it, and settlement reverts on-chain minutes later.
 *
 * It is its own command rather than a flag on `send-payment` because it is a different kind of
 * act: it broadcasts a transaction and spends gas, once per wallet and token, and it is worth
 * doing deliberately and ahead of time rather than as a side effect of paying.
 *
 * Output mirrors the other commands: the result JSON goes to stdout for piping, everything
 * else to stderr.
 */
const program = new Command();

/** Smallest-unit amount for --amount. Rejects decimals, signs and anything non-numeric. */
function parseUnits(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new CliInputError(
      `--amount must be a whole number of the token's smallest units (got "${value}")`,
    );
  }
  const amount = BigInt(value);
  if (amount === 0n) {
    throw new CliInputError('--amount must be greater than zero');
  }
  return amount;
}

program
  .name('approve-permit2')
  // Hard-wrapped and indented on purpose: commander re-wraps a description unless it finds a
  // line break followed by a space (Help.wrap's manualIndent).
  .description(
    [
      'Approve the Permit2 contract to move a source token, so payments from it can settle.',
      '',
      '  A one-off transaction per wallet and token. Every payment afterwards is an offline',
      '  signature that costs nothing. Run this before the first send-payment from a token;',
      '  without it the payment is built and signed correctly and still fails to settle.',
      '',
      '  This command SENDS A TRANSACTION and spends gas on the source chain. It is the only',
      '  command here that does. Use --check to see whether one is needed, without sending.',
    ].join('\n'),
  )
  .version(PACKAGE_VERSION)
  .argument('<sender>', 'Payer address that will hold the approval (e.g. 0xF0D0...)')
  .argument('<sourceAsset>', 'Source asset in CAIP-19 format')
  .option('--rpc-url <url>', 'RPC endpoint for the source chain (overrides RPC_URL env)')
  .option(
    '--spender <address>',
    `Contract to approve (default: the canonical Permit2, ${PERMIT2_CONTRACT_ADDRESS})`,
  )
  .option(
    '--amount <units>',
    "Approve only this many of the token's smallest units, instead of an unlimited approval. " +
      'Never lowers an allowance that is already larger',
    parseUnits,
  )
  .option('--check', 'Report whether an approval is needed and exit. Sends nothing, costs no gas')
  .addHelpText(
    'after',
    `
Examples:
  approve-permit2 0xF0D0... eip155:421614/erc20:0xaf88... --rpc-url https://...
  approve-permit2 0xF0D0... eip155:421614/erc20:0xaf88... --check

EVM and Tron sources. Tron also needs the tronweb package, an optional peer dependency so that
EVM-only installs do not carry it: npm install -g tronweb

The private key is read from PRIVATE_KEY, or prompted for. It is never taken as a flag, which
would put it in your shell history and in the process list. --check needs no key at all.

Unlimited by default, so later payments need no further transaction. --amount bounds the approval
this command sends instead; note that Permit2 decrements the allowance on every payment, so a
bounded approval is consumed and has to be renewed. It raises an allowance, never lowers one: a
wallet already approved for more than --amount is left as it is.

Output:
  Result JSON -> stdout (for parsing/automation, e.g. | jq)

An approval that is broadcast but not confirmed in time exits non-zero with
{"unconfirmed": true, "txHash": ...} on stdout. It may still land: check that transaction
before running this again, rather than sending a second approval.`,
  )
  .action(async (sender: string, sourceAsset: string, options) => {
    // Declared outside the try so the catch can still name the transaction that went out: for an
    // approval that is broadcast but never seen to confirm, that hash is the only way for the
    // payer to find out how it ended.
    let submittedTxHash: string | undefined;

    try {
      const asset = parseAssetIdentifier(sourceAsset);

      if (asset.namespace === 'solana') {
        throw new CliInputError(
          'Solana needs no Permit2 approval: the signed deposit authorizes the transfer itself. ' +
            'Nothing to do here.',
        );
      }
      if (asset.namespace !== 'eip155' && asset.namespace !== 'tron') {
        throw new CliInputError(
          `No Permit2 approval is defined for ${asset.chainId}. ` +
            'This command covers EVM and Tron sources.',
        );
      }

      const rpcUrl = options.rpcUrl || process.env.RPC_URL;
      if (!rpcUrl) {
        throw new CliInputError(
          'An RPC endpoint is required to read the allowance and send the approval. ' +
            'Pass --rpc-url or set RPC_URL.',
        );
      }

      const params = {
        network: asset.chainId,
        token: asset.tokenAddress,
        owner: sender,
        spender: options.spender,
        // The SDK treats a bounded amount as its own requirement, so --amount means "grant at
        // least this much, and treat that as sufficient" without the caller pairing it by hand.
        // It raises an allowance and never lowers one, which is what boundNotice below explains
        // when the wallet already holds more.
        approvalAmount: options.amount as bigint | undefined,
        // Printed the moment it is broadcast: the transaction is already spending the user's
        // gas, so they should be able to follow it rather than watch a silent terminal. The
        // purpose is named because a token that refuses an in-place overwrite produces two
        // transactions, and two unexplained hashes read like a double spend.
        onSubmitted: (txHash: string, purpose: 'approval' | 'reset') => {
          submittedTxHash = txHash;
          console.error(
            purpose === 'reset'
              ? `Resetting the existing allowance to zero first, in ${txHash}...`
              : `Submitted ${txHash}, waiting for it...`,
          );
        },
      };

      const buildClient = (privateKey?: string): Promise<ChainClient> =>
        asset.namespace === 'tron'
          ? tronClient(rpcUrl, sender, privateKey)
          : Promise.resolve(evmClient(rpcUrl, sender, privateKey));

      // Read the allowance BEFORE asking for a key. After the first run every wallet is already
      // approved, so prompting first would cost the overwhelmingly common case a secret to learn
      // that there was nothing to do. send-payment applies the same rule to a bad argument.
      const needed = await needsSourceApproval({ ...params, ...(await buildClient()) });

      // This command raises an allowance to what a payment needs; it never lowers one. So an
      // existing allowance at or above --amount is left exactly as it is. Said out loud, because
      // a bare "already approved" otherwise reads as though the cap had been applied.
      const boundNotice =
        options.amount === undefined
          ? ''
          : `\nAn allowance of at least ${String(options.amount)} is already in place. This ` +
            `command never lowers an existing allowance.`;

      if (options.check) {
        console.log(JSON.stringify({ approvalNeeded: needed }, null, 2));
        console.error(
          needed
            ? '\nAn approval is needed. Re-run without --check to send it.'
            : `\nAlready approved. Nothing to send.${boundNotice}`,
        );
        process.exit(0);
      }

      if (!needed) {
        console.log(JSON.stringify({ alreadySufficient: true }, null, 2));
        console.error(`\nAlready approved. No transaction was sent.${boundNotice}`);
        process.exit(0);
      }

      const privateKey = process.env.PRIVATE_KEY || (await promptPrivateKey());
      if (!privateKey) {
        throw new CliInputError('A private key is required. Set PRIVATE_KEY or enter one.');
      }

      // Verify the key derives <sender> before spending anything. Without this the allowance is
      // read for <sender> while the approval is granted by whatever account the key holds: a
      // successful-looking run that approves the wrong account, leaves <sender> unapproved, and
      // still fails at settlement. createSenderSigner is the same guard send-payment gets, and
      // it fails closed on a chain it cannot verify; the signer it returns is not needed here.
      createSenderSigner(asset.chainId, { provider: 'raw', privateKey, pinnedAddress: sender });

      const result = await ensureSourceApproval({ ...params, ...(await buildClient(privateKey)) });

      console.log(JSON.stringify(result, null, 2));
      console.error(
        result.alreadySufficient
          ? '\nAlready approved. No transaction was sent.'
          : `\nApproved in ${result.txHash}.`,
      );
      process.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // A bounded wait that ran out is not a failure: the approval is on-chain or about to be,
      // and sending another would pay for an allowance the payer is already getting. Reported on
      // stdout like any other result, so a script can branch on it instead of seeing the same
      // empty stdout and exit 1 a revert produces. The exit stays non-zero because the run did
      // not finish; `unconfirmed` is what says it must not simply be retried.
      if (isUnconfirmed(error)) {
        console.log(
          JSON.stringify({ unconfirmed: true, txHash: submittedTxHash, message }, null, 2),
        );
        console.error('\nNot confirmed yet. Check that transaction before running this again.');
        process.exit(1);
      }

      // Reported here rather than rethrown: the action is async, so a throw escapes the
      // synchronous try in runCli and would surface as an unhandled rejection. Every other
      // command in this CLI reports its own action errors the same way.
      console.error('\n❌ Error:', message);
      process.exit(1);
    }
  });

runCli(program);
