// The TypeScript from README.md, compiled against the PACKED TARBALL by
// `pnpm run check:publishable` (see publish-guard.config.mjs `consumer.snippetFiles`).
//
// It exists so the code we tell customers to write is checked the way they will
// experience it: against the published types, not against `src/`. A renamed field or a
// changed argument shape fails the guard here instead of reaching the README.
//
// EDIT THIS FILE WHENEVER YOU EDIT A TYPESCRIPT BLOCK IN README.md.
//
// It mirrors those blocks rather than copying them byte for byte, because the README shows
// each one standalone while this is a single module: the imports are hoisted to the top and
// the shared setup (`client`, `paymentId`) is declared once. Where the README repeats a
// declaration, this file reuses it. Nothing else should differ.
//
// This file is not part of `src/`, is not in the package `files` allowlist, and ships to
// nobody.
//
// NOTE: comments are NOT mirrored and are NOT covered by the guard. A compile pass says the
// code is valid; it says nothing about whether the prose around it is accurate.

import {
  PaymentGatewayClient,
  createSenderSigner,
  signPaymentRequest,
  getErrorResponse,
  isGatewayTimeoutError,
  isApiError,
  waitForStatus,
  isTerminalStatus,
  ApiError,
  ensureSourceApproval,
  isUnconfirmed,
  needsSourceApproval,
  encodeDirectDepositCalldata,
  deriveDirectDeposit,
  createStellarDelegate,
  type DirectDepositPaymentRequest,
  type TronWebLike,
  type ConfirmationOptions,
} from '@atumlabs/payment-gateway-client';
import { randomUUID } from 'node:crypto';
import { Contract, Wallet, JsonRpcProvider } from 'ethers';

// --- Basic Setup -----------------------------------------------------------------
const client = new PaymentGatewayClient({
  BASE: 'https://payment-gw.production-testnet.atum.xyz',
});

// --- Timeouts --------------------------------------------------------------------
void new PaymentGatewayClient({ timeoutMs: 10_000, syncWaitTimeoutMs: 60_000 });

const paymentId = 'pay_readme';

// --- Example: Tron to Celo Sepolia Payment ---------------------------------------
export async function sendPayment() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY environment variable required');
  }

  const tronSender = 'TYourTronAddressHere';

  const paymentRequest = await client.preparePaymentRequest({
    depositor: tronSender,
    fulfillmentAmount: '100000',
    sourceAsset: 'tron:shasta/trc20:TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs',
    destinationAccount: '0xYourEthereumAddressHere',
    destinationAsset: 'eip155:11142220/erc20:0x456a3D042C0DbD3db53D5489e98dFb038553B0d0',
    maxSourceAmount: '101000',
    requestId: 'order-4711',
  });

  const sourceChainId = 'tron:shasta';
  const signer = createSenderSigner(sourceChainId, {
    provider: 'raw',
    privateKey,
    pinnedAddress: tronSender,
  });
  await signPaymentRequest(paymentRequest, signer);

  try {
    const response = await client.payments.submitPayment({
      requestBody: paymentRequest,
    });

    console.log('Payment ID:', response.payment_id);
    if (response.idempotent_replay) {
      console.log('Handed back an existing payment');
    }

    switch (response.status) {
      case 'completed':
        console.log('Settled.');
        console.log('Source TX:', response.transactions?.deposit?.transaction_hash);
        console.log('Destination TX:', response.transactions?.fulfillment?.transaction_hash);
        break;
      case 'finalizing':
        console.log(
          'Paid on chain, not final yet:',
          response.transactions?.fulfillment?.transaction_hash,
        );
        break;
      case 'failed':
        console.error('Failed:', response.error?.code, response.error?.message);
        break;
      case 'refunded':
        console.error('Refunded:', response.payment_id);
        break;
      case 'refund_available':
        console.error('Refund available:', response.payment_id);
        break;
      default:
        console.log('Still settling - see "Tracking a payment" below.');
    }

    return response;
  } catch (error) {
    const gwError = getErrorResponse(error);
    if (gwError) {
      console.error('Gateway error:', gwError.code, gwError.message, gwError.request_id);
    } else if (error instanceof ApiError) {
      console.error('HTTP', error.status, error.statusText, error.url);
    }
    throw error;
  }
}

// --- Tracking a payment ----------------------------------------------------------
export async function readStatus() {
  const snapshot = await client.payments.getPaymentStatus({ paymentId });

  if (!isTerminalStatus(snapshot.status)) {
    // Still in flight. Do not release goods.
  }

  if (snapshot.error) {
    console.error(
      snapshot.error.code,
      snapshot.error.message,
      snapshot.error.blockchain_context?.transaction_hash ?? '',
    );
  }
}

// --- Waiting for an outcome ------------------------------------------------------
export async function waitForIt() {
  const outcome = await waitForStatus({
    fetchStatus: () => client.payments.getPaymentStatus({ paymentId }),
    budgetMs: 60_000,
    onError: (error) => console.warn('status check failed, still waiting:', error),
  });

  if (outcome.timedOut) {
    // Still in flight when the budget ran out.
  } else {
    console.log(outcome.snapshot?.status);
  }
}

// --- Stopping a wait early -------------------------------------------------------
export async function waitWithShutdown() {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());

  const outcome = await waitForStatus({
    fetchStatus: () => client.payments.getPaymentStatus({ paymentId }),
    signal: controller.signal,
  });

  if (outcome.aborted) {
    // Shutting down. The payment is unaffected; pick it up again on the next start.
  }
}

// --- Finding a payment again -----------------------------------------------------
export async function findAgain() {
  try {
    const { payment_id } = await client.payments.resolvePayment({ requestId: 'order-4711' });
    const snapshot = await client.payments.getPaymentStatus({ paymentId: payment_id });
    console.log(snapshot.status);
  } catch (error) {
    if (isApiError(error) && error.status === 404) {
      // No payment recorded for that request_id yet.
    } else {
      throw error;
    }
  }
}

// --- Step-by-step detail ---------------------------------------------------------
export async function readTimeline() {
  const timeline = await client.payments.getPaymentTimeline({ paymentId });

  for (const step of timeline.steps) {
    console.log(step.status, step.label, step.transaction_hash ?? '');
  }

  if (timeline.error) {
    console.error(
      timeline.error.code,
      timeline.error.message,
      timeline.error.blockchain_context?.revert_reason ?? '',
    );
  }
}

// --- Error Handling --------------------------------------------------------------
export async function handleErrors(
  paymentRequest: Awaited<ReturnType<typeof client.preparePaymentRequest>>,
) {
  try {
    await client.payments.submitPayment({ requestBody: paymentRequest });
  } catch (error) {
    const gwError = getErrorResponse(error);
    if (gwError) {
      console.error('Code:', gwError.code);
      console.error('Message:', gwError.message);
      console.error('Request ID:', gwError.request_id);
      console.error('Docs:', gwError.docs_url);
      if (gwError.code === 'IDEMPOTENCY_TERMS_MISMATCH') {
        // 409 - this request_id already identifies a payment with different economics.
      }
    } else if (isGatewayTimeoutError(error)) {
      console.error(error.message, error.timeoutMs);
    } else if (error instanceof ApiError) {
      console.error('HTTP', error.status, error.statusText, error.url);
    } else {
      throw error;
    }
  }
}

// --- Approving the source token ---------------------------------------------------
const RPC_URL = process.env.RPC_URL ?? '';
const sourceToken = '0x456a3D042C0DbD3db53D5489e98dFb038553B0d0';

export async function approveSourceToken() {
  const wallet = new Wallet(process.env.PRIVATE_KEY!, new JsonRpcProvider(RPC_URL));

  const result = await ensureSourceApproval({
    network: 'eip155:11142220',
    token: sourceToken,
    owner: wallet.address,
    signer: wallet,
  });

  if (!result.alreadySufficient) {
    console.log(`approved in ${result.txHash}`);
  }

  // Tron takes a TronWeb instance in place of the ethers signer.
  const tronWeb = undefined as unknown as TronWebLike;
  await ensureSourceApproval({
    network: 'tron:shasta',
    token: sourceToken,
    owner: wallet.address,
    tronWeb,
  });

  // Confirmation options and the submitted-hash callback. Named as a type so a consumer can
  // build one in a variable or a helper, not only inline.
  const confirmation: ConfirmationOptions = { timeoutMs: 120_000 };
  await ensureSourceApproval({
    network: 'eip155:11142220',
    token: sourceToken,
    owner: wallet.address,
    signer: wallet,
    onSubmitted: (txHash) => console.log(`watching ${txHash}`),
    confirmation,
  });

  // Telling a broadcast-but-unseen approval apart from one that failed. The two need opposite
  // responses, so the predicate is part of the surface rather than a property read off the error.
  try {
    await ensureSourceApproval({
      network: 'eip155:11142220',
      token: sourceToken,
      owner: wallet.address,
      signer: wallet,
    });
  } catch (error) {
    if (!isUnconfirmed(error)) {
      throw error;
    }
  }

  // Checking without spending gas.
  if (
    await needsSourceApproval({
      network: 'eip155:11142220',
      token: sourceToken,
      owner: wallet.address,
      signer: wallet,
    })
  ) {
    // a one-off approval transaction is due first
  }

  // Bounded approvals.
  await ensureSourceApproval({
    network: 'eip155:11142220',
    token: sourceToken,
    owner: wallet.address,
    signer: wallet,
    requiredAllowance: 1_000_000n,
    approvalAmount: 5_000_000n,
  });
}

// --- Funding the deposit yourself ------------------------------------------------
export async function fundDirectDeposit() {
  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);

  const { request, deposit, depositRequestHashVersion } = await client.prepareDirectDepositRequest({
    depositor: wallet.address,
    sourceAsset: 'eip155:11142220/erc20:0x456a3D042C0DbD3db53D5489e98dFb038553B0d0',
    destinationAsset: 'eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    destinationAccount: '0x742D35cC6634c0532925a3b844Bc9e7595F41360',
    fulfillmentAmount: '1000000',
    maxSourceAmount: '1030000',
    requestId: randomUUID(),
    depositNonce: 4711n,
    fulfill: 'settler',
    quoteDeadlineSeconds: 1800,
    fulfillmentDeadlineSeconds: 2700,
  });

  const escrow = request.escrow_contract_address;
  const token = new Contract(
    deposit.input.token,
    ['function approve(address,uint256) returns (bool)'],
    wallet,
  );
  await (await token.approve(escrow, deposit.input.amount)).wait();
  const funding = await wallet.sendTransaction({
    to: escrow,
    data: encodeDirectDepositCalldata(deposit.input),
  });
  const receipt = (await funding.wait())!;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  while (((await provider.getBlock('finalized'))?.number ?? -1) < receipt.blockNumber)
    await pause(15_000);
  await pause(15_000);

  const remaining = Date.parse(request.quote_deadline) - Date.now();
  if (remaining < 20_000)
    throw new Error('finality left no usable quote window: refund the deposit');
  await pause(Math.max(0, remaining - 45_000));
  const payment = await client.payments.submitPayment({ requestBody: request });
  if (payment.payment_id !== deposit.depositId) {
    throw new Error('the gateway named another deposit: refund the deposit');
  }

  // What to keep: the stored request gives the deposit back.
  const storedRequestJson = JSON.stringify(request);
  const stored: DirectDepositPaymentRequest = JSON.parse(storedRequestJson);
  const restored = deriveDirectDeposit(
    storedRequestJson,
    11142220n,
    stored.escrow_contract_address,
    depositRequestHashVersion,
  );

  // Getting the deposit back.
  const escrowContract = new Contract(
    escrow,
    [
      'function refundUnreserved((bytes32 depositId, bytes32 depositRequestHash, bytes32 destinationHash, address token, uint256 amount, address reserver, address releaser) input)',
    ],
    wallet,
  );
  const {
    depositRequestHash,
    destinationHash,
    token: depositedToken,
    amount,
    reserver,
    releaser,
  } = deposit.unreserved;
  await (
    await escrowContract.refundUnreserved({
      depositId: deposit.depositId,
      depositRequestHash,
      destinationHash,
      token: depositedToken,
      amount,
      reserver,
      releaser,
    })
  ).wait();

  return { payment, restored };
}

// --- Example: A Stellar payer's one-time setup -------------------------------------
export async function stellarSetup() {
  const payerSeedHex = process.env.PAYER_SEED_HEX ?? '';
  const { epoch } = await createStellarDelegate({
    sourceAsset: 'stellar:testnet/sep41:<C... token contract id>',
    escrow: '<C... escrow contract id from the payment>',
    trustedEscrow: '<C... escrow contract id from trusted deployment configuration>',
    depositorPrivateKey: payerSeedHex,
    delegateSigner: '<G... public key of the delegate signer>',
    capacity: 50_000_000n, // everything the delegate may deposit, in the token's smallest units
    maxTransferSize: 10_000_000n, // the most one deposit may take
    expiresInSeconds: 86_400, // or an absolute `expiration` in Unix seconds
  });
  return epoch;
}
