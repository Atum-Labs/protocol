import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Node = Record<string, unknown>;

// The request members the payee check and verifyPaymentRequestJSON read by exact name. Mirrors the
// Go request-members test.
const READER_MEMBER_PATHS = [
  ['source', 'asset_identifier'],
  ['source', 'account'],
  ['destination', 'asset_identifier'],
  ['destination', 'account'],
  ['request_id'],
  ['max_source_amount'],
  ['sender_auth', 'message_scheme'],
  ['sender_auth', 'signed_messages', 'message'],
  ['sender_auth', 'signed_messages', 'signature'],
  ['sender_auth', 'signed_messages', 'message_prehash'],
  ['sender_auth', 'signed_messages', 'payload'],
];

// Every member the request reader names must exist in the PaymentRequest schema, so renaming one
// there fails here instead of leaving the reader looking for the old name.
describe('request reader member names', () => {
  const schema = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../schema.json'), 'utf8'),
  ) as Node;
  const defs = (schema['$defs'] ?? {}) as Record<string, Node>;
  const settle = (node: Node): Node => {
    for (;;) {
      const ref = node['$ref'];
      if (typeof ref === 'string') node = defs[ref.replace('#/$defs/', '')] ?? {};
      else if (typeof node['items'] === 'object' && node['items'] !== null)
        node = node['items'] as Node;
      else return node;
    }
  };
  for (const path of READER_MEMBER_PATHS) {
    it(path.join('.'), () => {
      let node = schema;
      for (const name of path) {
        const child = ((settle(node)['properties'] ?? {}) as Record<string, Node>)[name];
        expect(child, `${path.join('.')} is not in the PaymentRequest schema`).toBeDefined();
        node = child!;
      }
    });
  }
});
