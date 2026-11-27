// Renders ../../eip3009-tokens.json as generated/eip3009-tokens.ts, so TypeScript consumers get
// the list without importing JSON. Run through `pnpm run generate` in schemas/declarations;
// make -C schemas check-ts-bindings fails when the committed output differs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(readFileSync(join(here, '../../eip3009-tokens.json'), 'utf8'));

const body = `// Generated from schemas/declarations/PaymentRequest/v1/eip3009-tokens.json by
// generate-eip3009-tokens.mjs. Do not edit; edit the JSON and run make generate-ts-bindings.

export interface Eip3009Token {
  readonly symbol: string;
  readonly address: string;
}

/** Tokens that implement EIP-3009 transferWithAuthorization, keyed by CAIP-2 chain ID. */
export const EIP3009_TOKENS: Readonly<Record<string, readonly Eip3009Token[]>> = ${JSON.stringify(source.chains, null, 2)};
`;

mkdirSync(join(here, 'generated'), { recursive: true });
writeFileSync(join(here, 'generated/eip3009-tokens.ts'), body);
