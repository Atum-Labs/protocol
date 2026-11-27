import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Pubkey } from './pubkey';
import { computeDepositHash } from './deposit-encoder';
import { computeReserveHash } from './reserve-encoder';
import { computeReleaseHash } from './release-encoder';
import { computeRefundHash } from './refund-encoder';
import type { EscrowDomain } from './escrow-domain';

// Cross-language parity against the AUTHORITATIVE golden produced by the
// on-chain escrow program's own compute_*_hash functions
// The Rust harness that originally produced it is gone along with the pre-v3 program, and the corpus
// is now FROZEN: these cases pin domain versions 1 and 2, which the current program can no longer
// produce. It is the regression gate for the frozen legacy encoder functions.
//
// This retires the previous circular check where the TS encoder was validated
// against vectors it generated itself. The golden is program-sourced (Rust
// writes it, the Rust test asserts the program reproduces it). This TS test and
// the sibling Go test (parity_golden_test.go) both assert their encoders
// reproduce the same hashes, so Rust + Go + TS agree on one source of truth.
// program_id is the real declare_id (44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs).
//
// Regenerate the golden ONLY from the program:
//   cd contracts/svm/source && REGEN_GOLDEN=1 cargo test -p escrow parity_golden

const ESCROW_PROGRAM_ID = '44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const goldenPath = resolve(__dirname, '../../../../conformance/parity-golden.json');

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface GoldenCase {
  name: string;
  domain: {
    cluster_name: string;
    cluster_id: string;
    signature_domain_version: number;
  };
  deposit: {
    deposit_request_hash: string;
    depositor: string;
    mint: string;
    amount: string;
    reserver: string;
    releaser: string;
    nonce: string;
    issued_at: string;
    deadline: string;
  };
  recipient: string;
  expected: {
    deposit_hash: string;
    reserve_hash: string;
    release_hash: string;
    refund_hash: string;
  };
}

interface GoldenFile {
  program_id: string;
  program_id_hex: string;
  cases: GoldenCase[];
}

const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenFile;

describe('SVM cross-language parity (program-sourced golden)', () => {
  it('golden program_id is the real declare_id and its hex agrees', () => {
    expect(golden.program_id).toBe(ESCROW_PROGRAM_ID);
    expect(golden.program_id_hex).toBe(
      Pubkey.fromBase58(golden.program_id).toHex(),
    );
  });

  it('has a non-empty case set', () => {
    expect(golden.cases.length).toBeGreaterThan(0);
  });

  it.each(golden.cases)('TS encoder reproduces all four hashes: $name', (c) => {
    const domain: EscrowDomain = {
      clusterId: hexToBytes(c.domain.cluster_id),
      signatureDomainVersion: c.domain.signature_domain_version,
      programId: Pubkey.fromBase58(golden.program_id),
    };

    const depositHash = computeDepositHash(
      {
        depositRequestHash: hexToBytes(c.deposit.deposit_request_hash),
        depositor: Pubkey.fromBase58(c.deposit.depositor),
        mint: Pubkey.fromBase58(c.deposit.mint),
        amount: BigInt(c.deposit.amount),
        reserver: Pubkey.fromBase58(c.deposit.reserver),
        releaser: Pubkey.fromBase58(c.deposit.releaser),
        nonce: BigInt(c.deposit.nonce),
        issuedAt: BigInt(c.deposit.issued_at),
        deadline: BigInt(c.deposit.deadline),
      },
      domain,
    );
    expect(bytesToHex(depositHash)).toBe(c.expected.deposit_hash);

    const reserveHash = computeReserveHash(
      { depositHash, recipient: Pubkey.fromBase58(c.recipient) },
      domain,
    );
    expect(bytesToHex(reserveHash)).toBe(c.expected.reserve_hash);

    const releaseHash = computeReleaseHash({ depositHash }, domain);
    expect(bytesToHex(releaseHash)).toBe(c.expected.release_hash);

    const refundHash = computeRefundHash({ depositHash }, domain);
    expect(bytesToHex(refundHash)).toBe(c.expected.refund_hash);
  });
});
