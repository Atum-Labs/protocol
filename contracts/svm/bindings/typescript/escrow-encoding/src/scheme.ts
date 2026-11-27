import { verifyEd25519Strict } from './ed25519-strict';
import {
  ESCROW_LABEL_DEPOSIT,
  ESCROW_LABEL_REFUND,
  ESCROW_LABEL_RELEASE,
  ESCROW_LABEL_RESERVE,
  ESCROW_MESSAGE_FORMS,
  type EscrowLabel,
  type EscrowMessageForm,
  escrowMessage,
  escrowText,
} from './signed-text';

/**
 * The form of the message an escrow version's ed25519 signers sign over a witness hash. The
 * registry's `svmMessage` field names it; `''` (SCHEME_RAW_HASH) signs the 32 byte hash itself.
 */
export type MessageScheme = string;

/** Signs the 32 byte witness hash itself, the only form the v4 program verifies. */
export const SCHEME_RAW_HASH: MessageScheme = '';

/**
 * Signs the escrow text `<label> <base64url-nopad(hash)>`. The program accepts it bare or inside a
 * single-signer off-chain message envelope (v1, or v0 with a zero application domain), and never
 * the raw hash.
 */
export const SCHEME_ESCROW_TEXT_V1: MessageScheme = 'escrow-text-v1';

/** Every known scheme. The registry accepts exactly these names. */
export const MESSAGE_SCHEMES: readonly MessageScheme[] = [SCHEME_RAW_HASH, SCHEME_ESCROW_TEXT_V1];

/** The escrow operation a witness hash authorizes. Values match the Go WitnessKind. */
export enum WitnessKind {
  Deposit = 1,
  Reserve = 2,
  Release = 3,
  Refund = 4,
}

const LABELS: Record<WitnessKind, EscrowLabel> = {
  [WitnessKind.Deposit]: ESCROW_LABEL_DEPOSIT,
  [WitnessKind.Reserve]: ESCROW_LABEL_RESERVE,
  [WitnessKind.Release]: ESCROW_LABEL_RELEASE,
  [WitnessKind.Refund]: ESCROW_LABEL_REFUND,
};

function validKind(kind: WitnessKind): boolean {
  return Number.isInteger(kind) && kind >= WitnessKind.Deposit && kind <= WitnessKind.Refund;
}

/** The escrow text label of `kind`. Throws on an unknown kind. */
export function witnessLabel(kind: WitnessKind): EscrowLabel {
  if (!validKind(kind)) throw new Error(`unknown witness kind ${kind}`);
  return LABELS[kind];
}

/**
 * Returns the message to sign for a witness hash under `scheme`. The raw hash scheme returns a
 * copy of the hash and the text scheme the bare escrow text for `kind`; an unknown scheme or kind,
 * or a hash that is not 32 bytes, throws.
 */
export function signingBytes(
  scheme: MessageScheme,
  kind: WitnessKind,
  hash: Uint8Array,
): Uint8Array {
  if (!validKind(kind)) {
    throw new Error(`unknown witness kind ${kind}`);
  }
  if (hash.length !== 32) {
    throw new Error(`witness hash must be 32 bytes, got ${hash.length}`);
  }
  if (scheme === SCHEME_RAW_HASH) {
    return Uint8Array.from(hash);
  }
  if (scheme === SCHEME_ESCROW_TEXT_V1) {
    return escrowText(LABELS[kind], hash);
  }
  throw new Error(`unknown message scheme ${JSON.stringify(scheme)}`);
}

/**
 * Returns the message schemes a client signature may take for an escrow signing with `scheme`:
 * the scheme itself. {@link messageForms} lists the exact forms within it.
 */
export function acceptedForms(scheme: MessageScheme): MessageScheme[] {
  if (scheme === SCHEME_RAW_HASH || scheme === SCHEME_ESCROW_TEXT_V1) {
    return [scheme];
  }
  throw new Error(`unknown message scheme ${JSON.stringify(scheme)}`);
}

/**
 * The message forms a client witness signature may take under `scheme`: raw only for the raw hash
 * scheme, as the v4 program does, and bare, v1 and v0 for the text scheme, which never accepts the
 * raw hash. Throws on an unknown scheme.
 */
export function messageForms(scheme: MessageScheme): EscrowMessageForm[] {
  if (scheme === SCHEME_RAW_HASH) return ['raw'];
  if (scheme === SCHEME_ESCROW_TEXT_V1) return [...ESCROW_MESSAGE_FORMS];
  throw new Error(`unknown message scheme ${JSON.stringify(scheme)}`);
}

/** A matched escrow witness: the form signed and its exact bytes. */
export interface EscrowWitnessMatch {
  form: EscrowMessageForm;
  message: Uint8Array;
}

/**
 * Finds the form, among those `scheme` accepts, that `signature` signs for the `kind` witness over
 * `hash` under `publicKey`, and returns that form and its exact signed bytes, the message an
 * Ed25519SigVerify instruction must carry. Uses {@link verifyEd25519Strict}, as the program does.
 * Returns undefined for an unknown scheme or kind, a malformed hash, key or signature, or no
 * matching form. Mirrors the Go `MatchEscrowWitness`.
 */
export function matchEscrowWitness(
  scheme: MessageScheme,
  kind: WitnessKind,
  hash: Uint8Array,
  publicKey: Uint8Array,
  signature: Uint8Array,
): EscrowWitnessMatch | undefined {
  if (scheme !== SCHEME_RAW_HASH && scheme !== SCHEME_ESCROW_TEXT_V1) return undefined;
  if (
    !validKind(kind) ||
    hash.length !== 32 ||
    publicKey.length !== 32 ||
    signature.length !== 64
  ) {
    return undefined;
  }
  for (const form of messageForms(scheme)) {
    const message = escrowMessage(form, LABELS[kind], hash, publicKey);
    if (verifyEd25519Strict(publicKey, message, signature)) return { form, message };
  }
  return undefined;
}
