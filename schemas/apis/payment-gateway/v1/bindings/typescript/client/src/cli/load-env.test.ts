import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadCliEnv } from './load-env';

// `.env.example` told users to `cp .env.example .env` long before anything read
// the file, so a user following it literally got no effect and silently fell back
// to the built-in defaults. These tests pin the loader down, and in particular
// pin the precedence: a real environment variable must beat the file, or setting
// GATEWAY_URL for one command would be silently overridden by a stale .env.
describe('loadCliEnv', () => {
  const ORIGINAL_CWD = process.cwd();
  let dir: string;
  const TOUCHED = ['GATEWAY_URL', 'PRIVATE_KEY', 'SOLANA_RPC_URL', 'PGC_TEST_ONLY'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
    for (const k of TOUCHED) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'pgc-load-env-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const writeEnv = (contents: string) => writeFileSync(join(dir, '.env'), contents);

  it('loads values from a .env in the working directory', () => {
    writeEnv('GATEWAY_URL=https://from-file.example\nPGC_TEST_ONLY=hello\n');
    loadCliEnv();
    expect(process.env.GATEWAY_URL).toBe('https://from-file.example');
    expect(process.env.PGC_TEST_ONLY).toBe('hello');
  });

  // The precedence guarantee. `override: false` is what makes
  // `GATEWAY_URL=... send-payment ...` work even with a stale .env on disk.
  it('does NOT override a variable already set in the real environment', () => {
    process.env.GATEWAY_URL = 'https://from-real-env.example';
    writeEnv('GATEWAY_URL=https://from-file.example\n');
    loadCliEnv();
    expect(process.env.GATEWAY_URL).toBe('https://from-real-env.example');
  });

  it('still fills in variables the real environment does not set', () => {
    process.env.GATEWAY_URL = 'https://from-real-env.example';
    writeEnv(
      'GATEWAY_URL=https://from-file.example\nSOLANA_RPC_URL=https://rpc-from-file.example\n',
    );
    loadCliEnv();
    expect(process.env.GATEWAY_URL).toBe('https://from-real-env.example');
    expect(process.env.SOLANA_RPC_URL).toBe('https://rpc-from-file.example');
  });

  it('is a no-op when no .env exists — the file is optional', () => {
    expect(() => loadCliEnv()).not.toThrow();
    expect(process.env.GATEWAY_URL).toBeUndefined();
  });

  it('ignores comments and blank lines', () => {
    writeEnv('# a comment\n\nGATEWAY_URL=https://from-file.example\n\n# trailing comment\n');
    loadCliEnv();
    expect(process.env.GATEWAY_URL).toBe('https://from-file.example');
  });

  // A naive line-splitter leaves the quotes in the value, which would turn a
  // signing key into a malformed one and fail confusingly at signing time. This
  // is the main reason the loader is dotenv rather than hand-rolled.
  it('strips surrounding quotes from values', () => {
    writeEnv('PRIVATE_KEY="0xabc123"\nGATEWAY_URL=\'https://quoted.example\'\n');
    loadCliEnv();
    expect(process.env.PRIVATE_KEY).toBe('0xabc123');
    expect(process.env.GATEWAY_URL).toBe('https://quoted.example');
  });

  it('preserves an empty assignment as empty, so the SDK treats it as unset', () => {
    writeEnv('GATEWAY_URL=\n');
    loadCliEnv();
    expect(process.env.GATEWAY_URL).toBe('');
  });
});
