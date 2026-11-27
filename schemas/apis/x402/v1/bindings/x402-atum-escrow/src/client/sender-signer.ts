/**
 * Bridge from x402's capability signer to the shared sender_auth SDK's signer seam.
 *
 * The SDK signs through a `SenderSigner` (it holds no key); its only built-in implementation
 * is `localKeySigner`, for a raw private key. x402's payer signer is instead a *capability*
 * ({@link EscrowSigner}'s `signTypedData` for EVM/Tron, the Ed25519 `sign` of
 * {@link SolanaSigner} and {@link StellarSigner} for Solana and Stellar) so a remote/opaque
 * provider (Turnkey/HSM) can drive it without exposing key material. This adapter wraps that
 * capability into a `SenderSigner`, signing exactly the structure the facilitator later recovers
 * against — so migrating the client onto the shared SDK keeps x402's Turnkey-readiness.
 *
 * Local-key callers should use the SDK's `localKeySigner(network, privateKey)` directly; this
 * bridge exists for the capability case.
 */
import { getBytes, hexlify, type TypedDataDomain, type TypedDataField } from 'ethers';
import type {
  SenderSigner,
  SenderSignature,
  SignedMessageInput,
} from '@atum-labs/payment-request-sender-auth';
import type { AuthSigner } from '../chain-adapters';

/**
 * Adapt an x402 {@link AuthSigner} into the SDK's `SenderSigner` for a CAIP-2 source network.
 *
 * @throws if the signer's capability does not match the network family (an Ed25519 signer on
 * an EVM source, or vice versa).
 */
export function toSenderSigner(network: string, signer: AuthSigner): SenderSigner {
  const namespace = network.split(':')[0];

  // Solana and Stellar: Ed25519 is not public-key recoverable, so sign the digest bytes and
  // disclose the signer's public key as `delegateSigner` — the facilitator verifies against it
  // and pins it to source.account (it cannot recover the key from the signature the way EVM/Tron
  // do). The key is disclosed in the source account's own form (base58 on Solana, a `G…` strkey
  // on Stellar). Solana signs the raw 32 byte digest. The client refuses an escrow-text-v1 (v5)
  // escrow before it gets here (UNSUPPORTED_ESCROW_SCHEME) only when the trust source names that
  // scheme in svmMessageScheme, as atumGatewayTrust does from the gateway's escrows.
  if (namespace === 'solana' || namespace === 'stellar') {
    if (!('publicKey' in signer)) {
      const [chain, typeName] =
        namespace === 'solana' ? ['Solana', 'SolanaSigner'] : ['Stellar', 'StellarSigner'];
      throw new Error(`sender-signer: a ${chain} source requires an Ed25519 (${typeName}) signer`);
    }
    const ed25519 = signer;
    return {
      // Bound to the source network, as the SDK's localKeySigner is, so an entry point that holds
      // the request (`assertRequestSignable`) can refuse a request whose source is another chain.
      network,
      async sign(m: SignedMessageInput): Promise<SenderSignature> {
        const signature = hexlify(await ed25519.sign(getBytes(m.message)));
        return { signature, delegateSigner: ed25519.publicKey };
      },
    };
  }

  // EVM / Tron: sign the inspectable typed data from the prehash (TIP-712 == EIP-712). The
  // digest ethers derives from (domain, types, message) is exactly what the facilitator
  // reconstructs canonically on verify, so no `delegateSigner` is needed (secp256k1 recovers
  // the signer from the signature). `primaryType` in the prehash is ignored — ethers derives it.
  if (!('signTypedData' in signer)) {
    throw new Error(
      `sender-signer: an ${namespace} source requires an EIP-712 typed-data (EscrowSigner) signer`,
    );
  }
  const escrow = signer;
  return {
    network,
    async sign(m: SignedMessageInput): Promise<SenderSignature> {
      if (m.message_prehash === undefined) {
        throw new Error('sender-signer: signed message is missing message_prehash');
      }
      const { domain, types, message } = JSON.parse(m.message_prehash) as {
        domain: TypedDataDomain;
        types: Record<string, Array<TypedDataField>>;
        message: Record<string, unknown>;
      };
      return { signature: await escrow.signTypedData(domain, types, message) };
    },
  };
}
