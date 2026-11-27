// depositRequestHash v2 in the commitment entry points, asserted against the vectors the Go SDK
// generates (conformance/commitment-v2-vectors.json). Mirrors commitment_v2_test.go.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  commitmentLogFields,
  requiredCommitmentOf,
  verifyCommitment,
  verifyRequestCommitment,
} from './commitment.js';
import { commitmentResultOf, emptyResult } from './commitment-rules.js';
import { verifyPaymentRequest, verifyPaymentRequestJSON } from './verify.js';
import { verifyQuoteRequestBinding } from './quote-binding.js';
import type { VerifyPaymentRequestExpectations } from './verify.js';
import type {
  CommitmentOptions,
  CommitmentResult,
  RequiredCommitment,
  SolanaDomain,
} from './commitment.js';

const VECTORS = resolve(__dirname, '../../../../conformance/commitment-v2-vectors.json');

type Mode = '' | 'audit' | 'enforce' | 'retire' | 'Enforce' | 'Retire' | null;

interface RequestCase {
  name: string;
  request: string;
  solana?: SolanaDomain;
  mode: Mode;
  result: Partial<CommitmentResult>;
}

interface RequiredCase {
  name: string;
  request: string;
  solana?: SolanaDomain;
  mode: Mode;
  commitment?: RequiredCommitment;
  result?: Partial<CommitmentResult>;
}

interface VerifyJSONCase {
  name: string;
  request: string;
  expected: VerifyPaymentRequestExpectations;
  amount?: string;
  commitment?: Partial<CommitmentResult>;
  result?: Partial<CommitmentResult>;
}

interface QuoteCase {
  name: string;
  quote: string;
  stored: string;
  hashes?: { depositRequestHashV1: string; depositRequestHashV2: string };
  result?: Partial<CommitmentResult>;
}

const vectors = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
  requests: RequestCase[];
  requiredCommitment: RequiredCase[];
  verifyJson: VerifyJSONCase[];
  quoteBinding: QuoteCase[];
};

/** What a call returns, or the result its refusal carries; any other error is rethrown. */
function settle<T>(call: () => T): { value?: T; refusal?: CommitmentResult } {
  try {
    return { value: call() };
  } catch (e) {
    const refusal = commitmentResultOf(e);
    if (refusal === undefined) throw e;
    return { refusal };
  }
}

/** The named rows `pick` selects, at least one, as `it.each` takes them. */
function rows<T extends { name: string }>(all: T[], pick: (c: T) => boolean = () => true) {
  const picked = all.filter(pick);
  expect(picked.length).toBeGreaterThan(0);
  return picked.map((c) => [c.name, c] as const);
}

/** A Go result with the keys Go omits when empty and TypeScript always sets. */
function asTypeScript(result: Partial<CommitmentResult>): CommitmentResult {
  return { ...emptyResult(), ...result } as CommitmentResult;
}

/**
 * The vector's mode as given: Go's off is the empty string, and null where a shared configuration
 * gives null, which Go decodes as off. TypeScript reads both as off too.
 */
function optionsOf(mode: Mode): CommitmentOptions {
  return { depositRequestHashV2Mode: mode as CommitmentOptions['depositRequestHashV2Mode'] };
}

/** Whether the mode opts in and still accepts v1: `audit` or `enforce`. */
const optedIn = (mode: Mode | undefined) => mode === 'audit' || mode === 'enforce';

/** The modes the vectors spell wrong, which every entry point refuses. */
const unknownMode = (mode: Mode | undefined) => mode === 'Enforce' || mode === 'Retire';

const requests = (pick: (c: RequestCase) => boolean) => rows(vectors.requests, pick);

function assertRequest(c: RequestCase) {
  const { value, refusal } = settle(() =>
    verifyRequestCommitment(c.request, c.solana ?? undefined, optionsOf(c.mode)),
  );
  expect(value ?? refusal).toEqual(asTypeScript(c.result));
}

describe('verifyRequestCommitment without the option is as before v2', () => {
  it.each(requests((c) => c.mode === ''))('%s', (_name, c) => assertRequest(c));
});

describe('verifyRequestCommitment in enforce refuses what the strict reader refuses', () => {
  it.each(requests((c) => c.mode === 'enforce' && c.name.startsWith('go-built')))(
    '%s',
    (_name, c) => assertRequest(c),
  );
});

describe('verifyRequestCommitment in audit reads a strict refusal as before v2 and reports it', () => {
  it.each(requests((c) => c.mode === 'audit' && c.name.startsWith('go-built')))('%s', (_name, c) =>
    assertRequest(c),
  );
});

describe('verifyRequestCommitment opted in matches v1 or v2 and refuses neither', () => {
  it.each(requests((c) => optedIn(c.mode) && c.name.startsWith('strict')))('%s', (_name, c) =>
    assertRequest(c),
  );
});

describe('verifyRequestCommitment in retire admits only v2, and refuses what enforce refuses', () => {
  it.each(requests((c) => c.mode === 'retire'))('%s', (_name, c) => assertRequest(c));
});

describe('verifyRequestCommitment refuses a mode it does not know', () => {
  it.each(requests((c) => unknownMode(c.mode)))('%s', (_name, c) => assertRequest(c));
});

describe('verifyRequestCommitment reads a null mode as off, as Go decodes it', () => {
  it.each(requests((c) => c.mode === null))('%s', (_name, c) => assertRequest(c));
});

const required = (pick: (c: RequiredCase) => boolean) => rows(vectors.requiredCommitment, pick);

function assertRequired(c: RequiredCase) {
  const { value, refusal } = settle(() =>
    requiredCommitmentOf(c.request, c.solana ?? undefined, optionsOf(c.mode)),
  );
  if (c.commitment !== undefined) expect(value).toEqual(c.commitment);
  else expect(refusal).toEqual(asTypeScript(c.result!));
}

describe('requiredCommitmentOf without the option is as before v2', () => {
  it.each(required((c) => c.mode === ''))('%s', (_name, c) => assertRequired(c));
});

describe('requiredCommitmentOf opted in returns both candidates, or the strict refusal', () => {
  it.each(required((c) => optedIn(c.mode)))('%s', (_name, c) => assertRequired(c));
});

describe('requiredCommitmentOf in retire names only v2, and refuses what enforce refuses', () => {
  it.each(required((c) => c.mode === 'retire'))('%s', (_name, c) => assertRequired(c));
});

describe('requiredCommitmentOf refuses a mode it does not know', () => {
  it.each(required((c) => unknownMode(c.mode)))('%s', (_name, c) => assertRequired(c));
});

describe('requiredCommitmentOf reads a null mode as off, as Go decodes it', () => {
  it.each(required((c) => c.mode === null))('%s', (_name, c) => assertRequired(c));
});

const verifyJSON = (pick: (c: VerifyJSONCase) => boolean) => rows(vectors.verifyJson, pick);

/** The row's mode as the vector gives it, which may be one TypeScript does not type. */
const jsonMode = (c: VerifyJSONCase) => c.expected.depositRequestHashV2Mode as Mode | undefined;

function assertVerifyJSON(c: VerifyJSONCase) {
  const { value: verified, refusal } = settle(() =>
    verifyPaymentRequestJSON(c.request, c.expected),
  );
  if (c.amount === undefined) {
    expect(refusal).toEqual(asTypeScript(c.result!));
    return;
  }
  expect(verified?.results[0]!.amount).toBe(c.amount);
  // Unopted, the result has no commitment key at all, as before v2.
  if (c.commitment === undefined) expect(verified).not.toHaveProperty('commitment');
  else expect(verified?.commitment).toEqual(asTypeScript(c.commitment));
}

describe('verifyPaymentRequestJSON without the option is as before v2', () => {
  it.each(verifyJSON((c) => jsonMode(c) === undefined))('%s', (_name, c) => assertVerifyJSON(c));
});

describe('verifyPaymentRequestJSON opted in verifies every signature against v1 or v2', () => {
  it.each(verifyJSON((c) => optedIn(jsonMode(c))))('%s', (_name, c) => assertVerifyJSON(c));
});

describe('verifyPaymentRequestJSON refuses retire, which only the request checks read', () => {
  it.each(verifyJSON((c) => jsonMode(c) === 'retire'))('%s', (_name, c) => assertVerifyJSON(c));
});

describe('verifyPaymentRequestJSON refuses a mode it does not know', () => {
  it.each(verifyJSON((c) => unknownMode(jsonMode(c))))('%s', (_name, c) => assertVerifyJSON(c));
});

describe('verifyPaymentRequestJSON reads a null mode as off, as Go decodes it', () => {
  it.each(verifyJSON((c) => jsonMode(c) === null))('%s', (_name, c) => assertVerifyJSON(c));
});

describe('verifyQuoteRequestBinding binds a quote to the stored request', () => {
  it.each(rows(vectors.quoteBinding))('%s', (_name, c) => {
    const { value: got, refusal } = settle(() => verifyQuoteRequestBinding(c.quote, c.stored));
    if (c.hashes !== undefined) {
      expect(got?.depositRequestHashV1).toBe(c.hashes.depositRequestHashV1);
      expect(got?.depositRequestHashV2).toBe(c.hashes.depositRequestHashV2);
    } else {
      expect(refusal).toEqual(asTypeScript(c.result!));
    }
  });
});

describe('commitmentLogFields', () => {
  const byName = (name: string) => vectors.requests.find((c) => c.name === name)!;

  it('adds the v2 fields only when set, so an unopted check logs the keys it did before', () => {
    const off = commitmentLogFields(asTypeScript(byName('strict-evm-v2/off').result));
    expect(Object.keys(off).sort()).toEqual([
      'detail',
      'request_deposit_request_hash',
      'request_destination',
      'scheme',
      'sender_auth_result',
      'signed_deposit_request_hash',
      'signed_destination',
      'source_namespace',
    ]);

    const v2 = asTypeScript(byName('strict-evm-v2/enforce').result);
    const fields = commitmentLogFields(v2);
    expect(fields.deposit_request_hash_version).toBe('v2');
    expect(fields.request_deposit_request_hash_v2).toBe(v2.expectedDepositRequestHashV2);
    expect(fields).not.toHaveProperty('strict_detail');

    const audit = asTypeScript(byName('go-built-evm/audit').result);
    const auditFields = commitmentLogFields(audit);
    expect(auditFields.deposit_request_hash_version).toBe('v1');
    expect(auditFields.strict_detail).toBe(audit.strictDetail);
    expect(auditFields).not.toHaveProperty('request_deposit_request_hash_v2');
  });
});

describe('the package index', () => {
  it('exports the quote binding', async () => {
    const index = await import('./index.js');
    expect(index.verifyQuoteRequestBinding).toBe(verifyQuoteRequestBinding);
  });
});

describe('verifyCommitment cannot apply a depositRequestHash v2 mode', () => {
  it('refuses every one, retire included, rather than check less than the caller asked for', () => {
    const signed = {
      sourceAssetIdentifier: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    } as Parameters<typeof verifyCommitment>[0];
    const expected = {} as Parameters<typeof verifyCommitment>[1];
    // Without the options the deposit is judged, so a refusal below is the options' own.
    expect(settle(() => verifyCommitment(signed, expected)).refusal?.outcome).not.toBe(
      'verifier_misconfigured',
    );
    for (const mode of ['audit', 'enforce', 'retire'] as const) {
      const { refusal } = settle(() =>
        verifyCommitment(signed, expected, undefined, { depositRequestHashV2Mode: mode }),
      );
      expect(refusal?.outcome, mode).toBe('verifier_misconfigured');
    }
  });
});

describe('verifyPaymentRequest accepts only v1', () => {
  it('refuses a depositRequestHashV2 mode rather than check less than the caller asked for', () => {
    const c = vectors.verifyJson.find((v) => v.name === 'strict-evm-v1/off')!;
    const request = JSON.parse(c.request) as Parameters<typeof verifyPaymentRequest>[0];
    expect(verifyPaymentRequest(request, c.expected).results).toHaveLength(1);
    for (const mode of ['audit', 'enforce', 'retire'] as const) {
      const { refusal } = settle(() =>
        verifyPaymentRequest(request, {
          ...c.expected,
          depositRequestHashV2Mode:
            mode as VerifyPaymentRequestExpectations['depositRequestHashV2Mode'],
        }),
      );
      expect(refusal?.outcome).toBe('verifier_misconfigured');
    }
  });
});
