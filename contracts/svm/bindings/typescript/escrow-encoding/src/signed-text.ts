/**
 * Escrow signed text: the exact bytes an escrow signer signs and the Ed25519SigVerify
 * instruction data that carries them. Pure bytes, mirrors the Go signed_text.go.
 */

export const ESCROW_LABEL_DEPOSIT = 'atum deposit v1';
export const ESCROW_LABEL_RESERVE = 'atum reserve v1';
export const ESCROW_LABEL_RELEASE = 'atum release v1';
export const ESCROW_LABEL_REFUND = 'atum refund v1';

export type EscrowLabel =
  | typeof ESCROW_LABEL_DEPOSIT
  | typeof ESCROW_LABEL_RESERVE
  | typeof ESCROW_LABEL_RELEASE
  | typeof ESCROW_LABEL_REFUND;

/**
 * The exact message an escrow witness signature is over. raw: the 32 byte hash itself, the only
 * form the v4 program verifies and the default. bare: the text itself. v1/v0: the text inside a
 * single-signer off-chain message envelope.
 */
export type EscrowMessageForm = 'raw' | 'bare' | 'v1' | 'v0';

/** Every text form, the forms an escrow-text-v1 program accepts. */
export const ESCROW_MESSAGE_FORMS: readonly EscrowMessageForm[] = ['bare', 'v1', 'v0'];

/** Base58 id of the native Ed25519 signature verification program. */
export const ED25519_PROGRAM_ID = 'Ed25519SigVerify111111111111111111111111111';

/** `\xffsolana offchain`, the first 16 bytes of every off-chain message envelope. */
export const OFFCHAIN_SIGNING_DOMAIN = new Uint8Array([
  0xff, 0x73, 0x6f, 0x6c, 0x61, 0x6e, 0x61, 0x20, 0x6f, 0x66, 0x66, 0x63, 0x68, 0x61, 0x69, 0x6e,
]);

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Offset of the signer pubkey inside a v1 / v0 envelope. */
const V1_PK_AT = 18;
const V0_PK_AT = 51;

function base64UrlNoPad(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes.length - i;
    const v = (bytes[i]! << 16) | ((n > 1 ? bytes[i + 1]! : 0) << 8) | (n > 2 ? bytes[i + 2]! : 0);
    const chars = Math.min(n, 3) + 1;
    for (let c = 0; c < chars; c++) out += B64URL[(v >> (18 - 6 * c)) & 0x3f];
  }
  return out;
}

function requireLength(name: string, bytes: Uint8Array, len: number): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== len) {
    throw new Error(`${name} must be ${len} bytes`);
  }
}

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) throw new Error('escrow text must be printable ASCII');
    out[i] = c;
  }
  return out;
}

/** `<label> <base64url-nopad(hash)>` as bytes. */
export function escrowText(label: EscrowLabel, hash: Uint8Array): Uint8Array {
  requireLength('hash', hash, 32);
  return ascii(`${label} ${base64UrlNoPad(hash)}`);
}

/**
 * The exact bytes signed for `form`: a copy of the hash for raw, otherwise the text under `label`.
 * Envelopes embed `publicKey` as their only signer.
 */
export function escrowMessage(
  form: EscrowMessageForm,
  label: EscrowLabel,
  hash: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array {
  requireLength('publicKey', publicKey, 32);
  if (form === 'raw') {
    requireLength('hash', hash, 32);
    return Uint8Array.from(hash);
  }
  const text = escrowText(label, hash);
  if (form === 'bare') return text;
  if (form === 'v1') {
    const out = new Uint8Array(V1_PK_AT + 32 + text.length);
    out.set(OFFCHAIN_SIGNING_DOMAIN, 0);
    out[16] = 1;
    out[17] = 1;
    out.set(publicKey, V1_PK_AT);
    out.set(text, V1_PK_AT + 32);
    return out;
  }
  if (form === 'v0') {
    // domain, version 0, 32-byte zero application domain, format 0, one signer, pk, u16le length.
    const out = new Uint8Array(V0_PK_AT + 32 + 2 + text.length);
    out.set(OFFCHAIN_SIGNING_DOMAIN, 0);
    out[50] = 1;
    out.set(publicKey, V0_PK_AT);
    out[83] = text.length & 0xff;
    out[84] = text.length >> 8;
    out.set(text, 85);
    return out;
  }
  throw new Error(`unknown escrow message form: ${String(form)}`);
}

function writeU16(out: Uint8Array, at: number, v: number): void {
  out[at] = v & 0xff;
  out[at + 1] = v >> 8;
}

/**
 * Ed25519SigVerify instruction data for one signature with in-instruction offsets. raw and bare use
 * the web3.js layout (pubkey, signature, message); envelopes point the pubkey offset at the signer
 * inside the message, which saves 32 bytes.
 */
export function escrowEd25519Instruction(
  form: EscrowMessageForm,
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Uint8Array {
  requireLength('publicKey', publicKey, 32);
  requireLength('signature', signature, 64);
  let data: Uint8Array;
  let sigOffset: number;
  let pkOffset: number;
  let msgOffset: number;
  if (form === 'raw' || form === 'bare') {
    if (form === 'raw') requireLength('message', message, 32);
    pkOffset = 16;
    sigOffset = 48;
    msgOffset = 112;
    data = new Uint8Array(msgOffset + message.length);
    data.set(publicKey, pkOffset);
  } else if (form === 'v1' || form === 'v0') {
    const pkAt = form === 'v1' ? V1_PK_AT : V0_PK_AT;
    const embedded = message.subarray(pkAt, pkAt + 32);
    if (embedded.length !== 32 || embedded.some((b, i) => b !== publicKey[i])) {
      throw new Error(`${form} message does not embed publicKey`);
    }
    sigOffset = 16;
    msgOffset = 80;
    pkOffset = msgOffset + pkAt;
    data = new Uint8Array(msgOffset + message.length);
  } else {
    throw new Error(`unknown escrow message form: ${String(form)}`);
  }
  if (data.length > 0xffff) throw new Error('message too long');
  data[0] = 1;
  writeU16(data, 2, sigOffset);
  writeU16(data, 4, 0xffff);
  writeU16(data, 6, pkOffset);
  writeU16(data, 8, 0xffff);
  writeU16(data, 10, msgOffset);
  writeU16(data, 12, message.length);
  writeU16(data, 14, 0xffff);
  data.set(signature, sigOffset);
  data.set(message, msgOffset);
  return data;
}
