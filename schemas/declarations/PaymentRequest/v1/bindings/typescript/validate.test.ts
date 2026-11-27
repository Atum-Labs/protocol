import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DIRECT_DEPOSIT_MAX_DESTINATION_BYTES,
  DirectDepositRuleError,
  PaymentRequestError,
  UnsupportedDestinationAssetError,
  validatePaymentRequest,
  validatePaymentRequestJSON,
} from './validate.js';

/**
 * The shared conformance file the Go binding reads too (bindings/go/rules_test.go), so a rule
 * that drifts between the languages fails here rather than in a consumer.
 */
interface OriginatorFulfillVector {
  name: string;
  executor: unknown;
  destinations: string[];
  wantErr: boolean;
  wantAsset: string;
}

/**
 * Raw JSON text, handed to the validator unchanged. Re-serializing a parsed document would drop
 * the folded member twins these vectors exist to pin, so the vector would prove nothing — Go
 * reads the same strings from the same file.
 */
interface RawDocumentVector {
  name: string;
  document: string;
  wantErrKind: '' | 'ambiguous' | 'unsupported';
  wantAsset: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(here, '../../conformance/originator-fulfill-vectors.json'), 'utf8'),
) as {
  originatorFulfillDestinations: OriginatorFulfillVector[];
  rawDocuments: RawDocumentVector[];
};

/**
 * The smallest document the rule reads: the executor and the destinations. The rules do not run
 * the schema, so the other required members are beside the point here.
 */
function vectorRequest(executor: unknown, destinations: string[]): Record<string, unknown> {
  const document: Record<string, unknown> = {
    destination: destinations.map((assetIdentifier) => ({
      asset_identifier: assetIdentifier,
      account: '0x1234567890123456789012345678901234567890',
    })),
  };
  if (executor !== null) document.executor = executor;
  return document;
}

describe('validatePaymentRequest: originator fulfill destinations', () => {
  it('reads the conformance vectors', () => {
    expect(vectors.originatorFulfillDestinations.length).toBeGreaterThan(0);
  });

  for (const vector of vectors.originatorFulfillDestinations) {
    it(vector.name, () => {
      const document = vectorRequest(vector.executor, vector.destinations);

      if (!vector.wantErr) {
        expect(() => validatePaymentRequest(document)).not.toThrow();
        return;
      }

      let thrown: unknown;
      try {
        validatePaymentRequest(document);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UnsupportedDestinationAssetError);
      const refusal = thrown as UnsupportedDestinationAssetError;
      expect(refusal.assetIdentifier).toBe(vector.wantAsset);
      // The chain is split out for consumers that tag metrics and logs by it, matching the Go
      // binding's Chain field.
      expect(refusal.chain).toBe(vector.wantAsset.slice(0, vector.wantAsset.indexOf('/')));
      // The message is the contract the Go binding matches, and the text a gateway surfaces, so
      // it is pinned rather than left to the error class alone.
      expect(refusal.message).toBe(
        `destination asset "${vector.wantAsset}" does not support EIP-3009 transferWithAuthorization, which originator fulfill requires`,
      );
    });
  }
});

// Go's encoding/json folds member names and keeps the last match, so a document carrying both
// "executor" and "Executor" decodes there as one of them while JSON.parse keeps both and this
// binding reads the other. validatePaymentRequestJSON refuses such a document before it parses,
// so the two readers cannot disagree about what a payment says. The same strings drive the Go
// test.
describe('validatePaymentRequestJSON: raw documents', () => {
  it('reads the raw-document vectors', () => {
    expect(vectors.rawDocuments.length).toBeGreaterThan(0);
  });

  for (const vector of vectors.rawDocuments) {
    it(vector.name, () => {
      let thrown: unknown;
      try {
        validatePaymentRequestJSON(vector.document);
      } catch (error) {
        thrown = error;
      }

      if (vector.wantErrKind === '') {
        expect(thrown).toBeUndefined();
        return;
      }

      if (vector.wantErrKind === 'ambiguous') {
        expect(thrown).toBeInstanceOf(PaymentRequestError);
        expect((thrown as Error).message).toContain('ambiguous member');
        // An ambiguous document is malformed, not an unsupported destination: payment-gw answers
        // the two with different API errors, so they must stay apart.
        expect(thrown).not.toBeInstanceOf(UnsupportedDestinationAssetError);
        return;
      }

      expect(thrown).toBeInstanceOf(UnsupportedDestinationAssetError);
      expect((thrown as UnsupportedDestinationAssetError).assetIdentifier).toBe(vector.wantAsset);
    });
  }

  it('refuses a document that is not valid JSON', () => {
    expect(() => validatePaymentRequestJSON('{"executor":')).toThrow(PaymentRequestError);
  });
});

// The rule reads CAIP-19, which the schema's pattern guarantees for a validated document. A
// caller running the rules on their own gets a refusal rather than an admission.
describe('validatePaymentRequest: unreadable destinations', () => {
  for (const assetIdentifier of [
    '',
    'eip155:1',
    'eip155:1/erc20',
    '/erc20:0xabc',
    'eip155:1/erc20:',
  ]) {
    it(`refuses the identifier ${JSON.stringify(assetIdentifier)}`, () => {
      expect(() => validatePaymentRequest(vectorRequest('originator', [assetIdentifier]))).toThrow(
        UnsupportedDestinationAssetError,
      );
    });
  }

  it('refuses a destination whose asset_identifier is not a string', () => {
    const document = { executor: 'originator', destination: [{ account: '0x1234' }] };
    expect(() => validatePaymentRequest(document)).toThrow(UnsupportedDestinationAssetError);
  });
});

// Documents the rule cannot read at all are left to the schema, which is what refuses them.
describe('validatePaymentRequest: documents the rule does not judge', () => {
  for (const document of [null, undefined, 'a string', 42]) {
    it(`admits ${JSON.stringify(document) ?? 'undefined'}`, () => {
      expect(() => validatePaymentRequest(document)).not.toThrow();
    });
  }

  it('admits an originator fulfill with no destination array', () => {
    expect(() =>
      validatePaymentRequest({
        executor: { deposit: 'settler', reserve: 'settler', fulfill: 'originator' },
      }),
    ).not.toThrow();
  });
});

/** conformance/direct-deposit-rule-vectors.json, which the Go binding reads too (rules_direct_deposit_test.go). */
interface DirectDepositRuleVector {
  name: string;
  document: string;
  wantErrKind: '' | 'direct_deposit' | 'unsupported' | 'ambiguous';
  wantRule: string;
  wantMessage: string;
}

const directDepositVectors = (
  JSON.parse(
    readFileSync(join(here, '../../conformance/direct-deposit-rule-vectors.json'), 'utf8'),
  ) as { vectors: DirectDepositRuleVector[] }
).vectors;

describe('validatePaymentRequestJSON: originator-executed deposit rules', () => {
  it('has vectors', () => {
    expect(directDepositVectors.length).toBeGreaterThan(0);
  });

  it.each(directDepositVectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    let thrown: unknown;
    try {
      validatePaymentRequestJSON(vector.document);
    } catch (err) {
      thrown = err;
    }
    switch (vector.wantErrKind) {
      case '':
        expect(thrown).toBeUndefined();
        return;
      case 'direct_deposit':
        expect(thrown).toBeInstanceOf(DirectDepositRuleError);
        expect((thrown as DirectDepositRuleError).rule).toBe(vector.wantRule);
        break;
      case 'unsupported':
        expect(thrown).toBeInstanceOf(UnsupportedDestinationAssetError);
        break;
      case 'ambiguous':
        // A twin inside a member the rules read is malformed, not a broken deposit rule.
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(DirectDepositRuleError);
        expect(thrown).not.toBeInstanceOf(UnsupportedDestinationAssetError);
        break;
    }
    expect((thrown as Error).message).toBe(vector.wantMessage);
  });
});

describe('DIRECT_DEPOSIT_MAX_DESTINATION_BYTES', () => {
  it('is the escrow cap the shared destination fixture pins', () => {
    const fixture = JSON.parse(
      readFileSync(join(here, '../../conformance/destination-vectors.json'), 'utf8'),
    ) as { maxDestinationBytes: number };
    expect(DIRECT_DEPOSIT_MAX_DESTINATION_BYTES).toBe(fixture.maxDestinationBytes);
  });
});
