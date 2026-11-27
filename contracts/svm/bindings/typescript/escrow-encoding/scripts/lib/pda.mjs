// Solana program-derived addresses, for scripts/check-deployed-events.mjs. Unit tested in
// src/pda.test.ts against a deposit account observed on mainnet.

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import bs58 from 'bs58';

const MARKER = Buffer.from('ProgramDerivedAddress');

function onCurve(bytes) {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Base58 address of the canonical PDA: the first bump, from 255 down, that lands off the curve. */
export function findProgramAddress(seeds, programId) {
  const program = Buffer.from(bs58.decode(programId));
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(Buffer.concat([...seeds, Buffer.from([bump]), program, MARKER]));
    if (!onCurve(hash)) return bs58.encode(hash);
  }
  throw new Error('no viable bump seed');
}
