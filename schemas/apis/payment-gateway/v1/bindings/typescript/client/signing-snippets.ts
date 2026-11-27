// The TypeScript from docs/signing.md, compiled against the PACKED TARBALL by
// `pnpm run check:publishable` (see publish-guard.config.mjs `consumer.snippetFiles`).
//
// Same contract as readme-snippets.ts: the code we tell customers to write is checked the way
// they will experience it — against the published types, not against `src/`. It exists because
// docs/signing.md documents the three signing surfaces in exact detail, which is precisely the
// kind of prose that goes stale silently.
//
// EDIT THIS FILE WHENEVER YOU EDIT A TYPESCRIPT BLOCK IN docs/signing.md.
//
// It mirrors those blocks rather than copying them byte for byte: imports are hoisted, shared
// setup is declared once, and each block that awaits is wrapped in an exported function. Where
// the doc shows the same name for two different values (`signed` is both a signed request and a
// signed declaration, in different sections), each function names its own locals. Nothing else
// should differ.
//
// This file is not part of `src/`, is not in the package `files` allowlist, and ships to nobody.
//
// NOTE: comments are NOT mirrored and are NOT covered by the guard. A compile pass says the code
// is valid; it says nothing about whether the prose around it is accurate.

import { Wallet } from 'ethers';
import {
  PaymentGatewayClient,
  signPaymentRequest,
  createSenderSigner,
  type PaymentRequest,
} from '@atum-labs/payment-gateway-client';
import {
  signDeclaration,
  verifyDeclaration,
  verifyPaymentRequest,
  signerFromEthersWallet,
  buildEnvelopeForAccount,
  computeRequestHash,
  type DeclarationSigner,
  requestSessionToken,
  createSessionTokenSource,
} from '@atum-labs/payment-gateway-client/signing';

// --- Shared setup ----------------------------------------------------------------
const wallet = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const gateway = 'https://payment-gw.production-testnet.atum.xyz';
declare const request: PaymentRequest;
declare const knownToAtumCredential: unknown;
declare const agreedTokenAddress: string;
declare const agreedMaxAmount: string;

// --- Keys never reach this package -----------------------------------------------
// The doc reproduces the DeclarationSigner interface. These two assignments bind that
// reproduction to the real exported type in BOTH directions, so the doc is caught going stale
// whether a member is added or removed.
type DocumentedDeclarationSigner = {
  getAddress(): Promise<string> | string;
  signDigest(digest: Uint8Array): Promise<Uint8Array> | Uint8Array;
};
export const _docShapeAcceptsShipped: DocumentedDeclarationSigner = {} as DeclarationSigner;
export const _shippedAcceptsDocShape: DeclarationSigner = {} as DocumentedDeclarationSigner;

// --- For a local key, use ethers --------------------------------------------------
export const localSigner = signerFromEthersWallet(wallet);

// --- Signing both surfaces --------------------------------------------------------
export async function signBothSurfaces() {
  const senderSigner = createSenderSigner('eip155:1', {
    provider: 'raw',
    privateKey: wallet.privateKey,
    pinnedAddress: wallet.address,
  });

  // 1. Authorize the transfer.
  const authorized = await signPaymentRequest(request, senderSigner);

  // 2. Attest the document.
  const signed = await signDeclaration(authorized, signerFromEthersWallet(wallet), {
    chainId: 1,
  });

  // 3. Submit.
  await new PaymentGatewayClient({ BASE: gateway }).payments.submitPayment({
    requestBody: signed,
  });

  return signed;
}

// --- Check what you are signing ---------------------------------------------------
export function bindToAgreedTerms(signedRequest: PaymentRequest) {
  const { recoveredAccount } = verifyPaymentRequest(signedRequest, {
    sourceAsset: agreedTokenAddress,
    network: 'eip155:1',
    maxSourceAmount: agreedMaxAmount,
  });

  return recoveredAccount;
}

// --- Verifying --------------------------------------------------------------------
export async function verifyADocument(
  signedDeclaration: Awaited<ReturnType<typeof signBothSurfaces>>,
) {
  const { signer } = await verifyDeclaration(signedDeclaration);

  if (signer.kind === 'recovered-secp256k1') {
    console.log(signer.address);
  } else {
    // Self-asserted ed25519: bind it to a trusted source before relying on it.
  }
}

// --- The identity envelope --------------------------------------------------------
export async function buildIdentityEnvelope() {
  const envelope = await buildEnvelopeForAccount('eip155:1', wallet.address.toLowerCase(), {
    holderVCs: [knownToAtumCredential],
    signer: signerFromEthersWallet(wallet),
    challenge: await computeRequestHash(request),
    domain: 'did:web:devnet.atum.network',
  });

  return envelope;
}

// --- Session tokens ---------------------------------------------------------------
export async function requestASessionToken() {
  const session = await requestSessionToken({
    authUrl: 'https://auth.production-testnet.atum.xyz',
    credentials: [knownToAtumCredential],
    signer: signerFromEthersWallet(wallet),
  });

  return `Bearer ${session.accessToken}`;
}

export function keepASessionTokenCurrent() {
  const session = createSessionTokenSource({
    authUrl: 'https://auth.production-testnet.atum.xyz',
    credentials: [knownToAtumCredential],
    signer: signerFromEthersWallet(wallet),
    onError: (error) => console.warn('session renewal failed', error),
  });

  const client = new PaymentGatewayClient({ session });
  return client;
}
