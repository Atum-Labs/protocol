/**
 * Decides whether an account string is usable on the chain it names.
 *
 * TypeScript half of the chain-address contract. The Go half lives at
 * ../../go and both are held equal by ../../vectors.json, which pins the canonical bytes, the account
 * kind and the rejection reason for every case.
 *
 * It answers the chain-agnostic half only: present, no surrounding whitespace, parses under the
 * chain's own address rules, and not that chain's zero address. Whether a particular settler can
 * pay the account is payout form, not an address property, and stays with the service enforcing it.
 */
import bs58 from 'bs58';
import { getAddress } from 'ethers';
import { Address as StellarAddress, CONTRACT_ADDRESS as STELLAR_CONTRACT_ADDRESS } from '@atum-labs/stellar-escrow-encoding';
import { base58ToHex } from '@atum-labs/tvm-escrow-encoding';

/** CAIP-2 namespaces this package knows address rules for. */
export const NAMESPACE_EIP155 = 'eip155';
export const NAMESPACE_TRON = 'tron';
export const NAMESPACE_SOLANA = 'solana';
export const NAMESPACE_STELLAR = 'stellar';

/**
 * The frozen rejection taxonomy. These strings are part of the cross-language contract: Go must
 * reject the same input with the same reason.
 *
 * The union is derived from this array rather than declared beside it, so a reason cannot be added
 * to the type without appearing here, and the coverage test that demands a vector per reason reads
 * the same source. An array declared separately from the union would not be checked against it: a
 * `Reason[]` may omit members freely.
 */
export const REASONS = [
  'EMPTY',
  'SURROUNDING_WHITESPACE',
  'UNSUPPORTED_NAMESPACE',
  'UNPARSEABLE',
  'ZERO',
] as const;

export type Reason = (typeof REASONS)[number];

export class InvalidAccountError extends Error {
  readonly reason: Reason;
  readonly network: string;
  readonly account: string;
  readonly detail: string;

  constructor(reason: Reason, network: string, account: string, detail = '') {
    super(messageFor(reason, network, detail));
    this.name = 'InvalidAccountError';
    this.reason = reason;
    this.network = network;
    this.account = account;
    this.detail = detail;
  }
}

/** Mirrors the Go Error() text exactly, which the vectors pin. */
function messageFor(reason: Reason, network: string, detail: string): string {
  switch (reason) {
    case 'EMPTY':
      return 'account is required and cannot be empty';
    case 'SURROUNDING_WHITESPACE':
      return 'account must not contain leading or trailing whitespace';
    case 'UNSUPPORTED_NAMESPACE':
      return `no address rules are known for chain ${network}`;
    case 'ZERO':
      return `account is the zero address on ${network}, which cannot receive a payout`;
    default:
      // detail is deliberately not rendered: it comes from whichever address library each
      // language uses, and those word the same failure differently, so including it would make
      // the message impossible to hold equal across the two halves.
      return `account is not a valid address for ${network}`;
  }
}

/**
 * A parsed account in canonical byte form: 20 bytes for eip155 and tron, 32 for solana and stellar
 * (the ed25519 key of a G account or the contract id of a C account).
 *
 * For stellar the bytes alone are not an identity: a G account and a C contract with the same 32
 * bytes are different accounts that parse to equal bytes. Compare kind as well.
 */
export interface Account {
  namespace: string;
  /**
   * Which kind of account a namespace with more than one parsed: 'account' (G...) or 'contract' (C...)
   * for stellar, '' for every other namespace.
   */
  kind: AccountKind;
  bytes: Uint8Array;
}

export type AccountKind = '' | 'account' | 'contract';

export function supportedNamespaces(): string[] {
  return [NAMESPACE_EIP155, NAMESPACE_SOLANA, NAMESPACE_STELLAR, NAMESPACE_TRON];
}

/**
 * Whitespace both languages agree to treat as surrounding, which is the union of the two platform
 * functions rather than either one.
 *
 * The two sets differ in exactly two characters, and the reason returned is the cross language
 * contract, so leaving each side on its own function made that contract diverge. This trim has the
 * byte order mark and lacks U+0085, while Go's unicode.White_Space is the reverse. Taking the union
 * keeps every character either side already trimmed, so no input moves between accepted and
 * rejected, and a receiver pasted out of a file carrying a byte order mark is told about the
 * whitespace rather than that its address is unreadable.
 */
function trimSurrounding(value: string): string {
  // Built per call rather than shared: a global regex carries lastIndex, and this runs twice per
  // parse, so a shared one is state waiting to be tripped over by the next reader.
  return value.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '');
}

/**
 * Applies the form rules: present, no surrounding whitespace, parseable under the chain's rules.
 * Throws {@link InvalidAccountError}. Does not apply the zero-address rule, see {@link validate}.
 *
 * Only the CAIP-2 namespace is read. Address form does not depend on the reference, and the
 * reference is spelled inconsistently across our surfaces.
 */
export function parse(network: string, account: string): Account {
  if (trimSurrounding(account) === '') {
    throw new InvalidAccountError('EMPTY', network, account);
  }
  // Refused rather than trimmed: the account travels onward as written, so a value this had to
  // alter is one the caller should correct.
  if (account !== trimSurrounding(account)) {
    throw new InvalidAccountError('SURROUNDING_WHITESPACE', network, account);
  }

  const separator = network.indexOf(':');
  if (separator <= 0) {
    throw new InvalidAccountError('UNSUPPORTED_NAMESPACE', network, account);
  }
  const namespace = network.slice(0, separator);

  let bytes: Uint8Array;
  let kind: AccountKind = '';
  try {
    switch (namespace) {
      case NAMESPACE_EIP155:
        bytes = parseEvm(account);
        break;
      case NAMESPACE_TRON:
        bytes = parseTron(account);
        break;
      case NAMESPACE_SOLANA:
        bytes = parseSolana(account);
        break;
      case NAMESPACE_STELLAR:
        ({ bytes, kind } = parseStellar(account));
        break;
      default:
        throw new InvalidAccountError('UNSUPPORTED_NAMESPACE', network, account);
    }
  } catch (error) {
    if (error instanceof InvalidAccountError) throw error;
    throw new InvalidAccountError('UNPARSEABLE', network, account, (error as Error).message);
  }

  return { namespace, kind, bytes };
}

/** parse plus the zero-address rule. This is what an ingress check calls. */
export function validate(network: string, account: string): Account {
  const parsed = parse(network, account);
  if (isZero(parsed.bytes)) {
    throw new InvalidAccountError('ZERO', network, account);
  }
  return parsed;
}

/** Never throws. Returns the error rather than raising it, for call sites that branch on it. */
export function checkAccount(network: string, account: string): InvalidAccountError | null {
  try {
    validate(network, account);
    return null;
  } catch (error) {
    if (error instanceof InvalidAccountError) return error;
    throw error;
  }
}

/** Requires at least one byte, so an empty array is never mistaken for the zero address. */
function isZero(bytes: Uint8Array): boolean {
  return bytes.length > 0 && bytes.every((one) => one === 0);
}

const HEX_40 = /^(0[xX])?[0-9a-fA-F]{40}$/;

/**
 * Accepts hex with an optional 0x or 0X prefix, enforcing EIP-55 only when the body is mixed case.
 *
 * Deliberately hand-rolled rather than delegating to ethers' getAddress, which disagrees with the
 * Go half on two spellings: it throws on a 0X-prefixed address that Go accepts, and it accepts a
 * bare checksummed body that Go rejects. getAddress is used only to compute the checksum form,
 * from an all-lowercase input it always accepts.
 */
function parseEvm(account: string): Uint8Array {
  if (!HEX_40.test(account)) {
    throw new Error('expected 40 hex characters, optionally 0x-prefixed');
  }
  const body = account.replace(/^0[xX]/, '');
  const lower = body.toLowerCase();
  if (body !== lower && body !== body.toUpperCase()) {
    if (getAddress(`0x${lower}`) !== account) {
      throw new Error('mixed-case address fails its EIP-55 checksum');
    }
  }
  return hexToBytes(lower);
}

/**
 * Takes the base58check form, the 0x41-prefixed hex form, or the EVM hex forms, returning the
 * 20 bytes with the 0x41 prefix removed so the zero test means the same thing as on eip155.
 */
function parseTron(account: string): Uint8Array {
  let hexBody: string;
  if (account.startsWith('T') && account.length === 34) {
    try {
      hexBody = base58ToHex(account);
    } catch (error) {
      throw new Error(`base58 address failed its checksum: ${(error as Error).message}`);
    }
  } else if (account.toLowerCase().startsWith('0x41') && account.length === 44) {
    hexBody = account.slice(2);
  } else if (HEX_40.test(account)) {
    // The EVM hex form, checksum rules and all.
    return parseEvm(account);
  } else {
    throw new Error('expected a T-prefixed base58 address or 40 hex characters');
  }

  hexBody = hexBody.startsWith('41') ? hexBody.slice(2) : hexBody;
  if (hexBody.length !== 40) {
    throw new Error(`expected 40 hex characters after conversion, got ${hexBody.length}`);
  }
  return hexToBytes(hexBody);
}

/**
 * Base58 only. The hex and base64 spellings some parsers allow are refused: the account travels
 * to the settler as written and the payout path reads base58.
 */
function parseSolana(account: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(account);
  } catch {
    throw new Error('expected a 32-byte base58 public key');
  }
  if (decoded.length !== 32) {
    throw new Error(`expected a 32-byte base58 public key, got ${decoded.length} bytes`);
  }
  return decoded;
}

/**
 * A G account (ed25519 public key) or a C contract strkey. Every other strkey type is refused,
 * including muxed accounts (M) and muxed contracts (W, CAP-84, Protocol 30): the payout path has no
 * way to carry the mux id, so accepting one would silently pay the base account or contract.
 *
 * The strkey rules (alphabet first, canonical base32, checksum, payload size) live in one place, the
 * Stellar escrow-encoding package. This adds only what a payout can name.
 */
function parseStellar(account: string): { bytes: Uint8Array; kind: AccountKind } {
  const address = StellarAddress.fromStrkey(account);
  return { bytes: address.toBytes(), kind: address.type === STELLAR_CONTRACT_ADDRESS ? 'contract' : 'account' };
}

/** Hex body, so the helper below can never be handed anything it would silently mangle. */
const HEX_BODY = /^[0-9a-fA-F]*$/;

function hexToBytes(hex: string): Uint8Array {
  // Total on purpose, rather than trusting every caller to have validated first. `parseInt` is
  // lenient in two ways that compose into silent corruption here: it skips leading whitespace and
  // stops at the first character it cannot read, and the `NaN` it returns for a wholly unreadable
  // pair becomes 0 when assigned into a Uint8Array. So an unvalidated body yields bytes that are
  // not the caller's address, and the Go half rejects the same input outright.
  if (hex.length % 2 !== 0 || !HEX_BODY.test(hex)) {
    throw new Error('expected hex characters');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
