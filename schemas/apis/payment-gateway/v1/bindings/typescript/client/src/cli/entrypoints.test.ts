import { spawn } from 'child_process';
import { createServer, type Server } from 'http';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import { Address } from '@atum-labs/stellar-escrow-encoding';
import type { AwardedQuote, CreateQuoteRequest } from '../index';
import { startFakeGateway, type FakeGateway, type Responder } from '../test-support/fake-gateway';
import { signedQuoteFor } from '../test-support/quotes';
import {
  BUILD_ONLY_OPTIONS,
  HIDDEN_BUILD_ONLY_OPTIONS,
  SEND_OPTIONS,
  SUBMIT_ONLY_OPTIONS,
  FORM_OPTIONS,
} from './option-groups';

/**
 * The command-line tools, executed.
 *
 * Until this file, nothing ran them. Importing an entry point runs it — the last line of each is
 * `runCli(program)` — so `run-cli.test.ts` checks them by reading their source text, and the only
 * place they were ever executed was the publish guard's `--version` check. A tool could fail at
 * startup and every gate stayed green.
 *
 * These run the BUILT files, for two reasons. They are what a customer installs, bundling and all;
 * and `--version` is only meaningful there, because `PACKAGE_VERSION` is injected by tsup's
 * `define` and reads as the sentinel `0.0.0-dev` under ts-jest (see src/version.ts). A break in that
 * injection is invisible to any in-process test.
 */

const PACKAGE_ROOT = resolve(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
  version: string;
  bin: Record<string, string>;
};

/** Every shipped command, from the manifest, so a new one is covered the moment it is declared. */
const BINS = Object.entries(manifest.bin).map(([name, target]) => ({
  name,
  path: resolve(PACKAGE_ROOT, target),
}));

/**
 * A CLI's own `.env` loading reads the working directory, and the environment is read for
 * `GATEWAY_URL`, `PRIVATE_KEY` and the Turnkey credentials. Run from a scratch directory with a
 * hand-built environment so a developer's own `.env` cannot change what these tests observe.
 */
// Each case spawns at least one process, and the --wait case waits out a real poll interval on top
// of that. The default 5s is not enough headroom for either on a loaded machine.
jest.setTimeout(30_000);

const SCRATCH = mkdtempSync(join(tmpdir(), 'pgc-cli-'));
const BASE_ENV = { PATH: process.env.PATH ?? '', HOME: SCRATCH } as NodeJS.ProcessEnv;

/** What a finished command left behind. */
interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a built command and collect its output.
 *
 * Asynchronous on purpose, and it must stay that way: the fake gateway runs inside THIS process, so
 * a synchronous spawn would block the event loop that has to answer the command's own HTTP calls,
 * and the two would deadlock waiting on each other.
 *
 * @param binPath - the built entry point to run
 * @param args - argv for it
 * @param options - environment additions, and anything to feed its stdin
 */
function run(
  binPath: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: SCRATCH,
      env: { ...BASE_ENV, ...(options.env ?? {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    // Closed rather than left open: every command here either ignores stdin or, for
    // `--submit -`, is handed its document explicitly.
    child.stdin.end(options.input ?? '');
  });
}

const BUILD_HINT =
  'build first: pnpm --filter @atum-labs/payment-gateway-client build ' +
  '(a plain `pnpm install` also builds, via the prepare script)';

/**
 * Newest modification time among the sources that actually reach `dist`.
 *
 * Test files are skipped, and so is `test-support`: it is scaffolding for these tests and is not in
 * the tsup entry list, so nothing in it is ever built. Counting it would send someone who edited the
 * fake gateway off to run a build that cannot change anything.
 */
function newestSourceTime(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((newest, entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'test-support' ? newest : Math.max(newest, newestSourceTime(path));
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return newest;
    return Math.max(newest, statSync(path).mtimeMs);
  }, 0);
}

beforeAll(() => {
  // A smoke test that skips itself when the thing it smokes is missing is worse than no test, so
  // this fails loudly and says exactly what to do.
  const missing = BINS.filter((bin) => !existsSync(bin.path)).map((bin) => bin.name);
  if (missing.length) {
    throw new Error(
      `the built CLI(s) ${missing.join(', ')} are missing. These tests run the shipped files, so ${BUILD_HINT}.`,
    );
  }

  // These run `dist`, so a `dist` older than `src` means they are testing the previous build: a
  // command could be broken by the very edit under test and this suite would still pass. `pnpm test`
  // does not build (CI does, before it tests), so the staleness has to be caught here.
  const builtAt = Math.min(...BINS.map((bin) => statSync(bin.path).mtimeMs));
  const sourcedAt = newestSourceTime(resolve(PACKAGE_ROOT, 'src'));
  if (sourcedAt > builtAt) {
    throw new Error(
      `src has changed since the CLIs were built, so these tests would run the previous build: ${BUILD_HINT}.`,
    );
  }
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('every shipped command-line tool', () => {
  it('is a file the manifest declares and this suite therefore covers', async () => {
    // Pins the discovery above: an empty bin map would make every case below vacuous.
    expect(BINS.length).toBeGreaterThanOrEqual(4);
    expect(BINS.map((b) => b.name)).toEqual(
      expect.arrayContaining(['send-payment', 'payment-status']),
    );
  });

  it.each(BINS)('$name --version exits 0 and reports the published version', async ({ path }) => {
    const result = await run(path, ['--version']);

    expect(result.status).toBe(0);
    // Not merely non-empty: this is the assertion that catches tsup's version injection breaking,
    // which would otherwise ship every command reporting 0.0.0-dev.
    expect(result.stdout.trim()).toBe(manifest.version);
  });

  it.each(BINS)('$name --help exits 0 and prints its usage', async ({ name, path }) => {
    const result = await run(path, ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Usage: ${name}`);
    expect(result.stderr).toBe('');
  });

  it.each(BINS)('$name reports an unknown option instead of ignoring it', async ({ path }) => {
    const result = await run(path, ['--definitely-not-an-option']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown option');
  });
});

describe('send-payment --help', () => {
  const help = async () => (await run(binPath('send-payment'), ['--help'])).stdout;

  it('names the Permit2 prerequisite before the options, not buried at the end', async () => {
    // The single most common cause of a failed EVM payment. It used to sit ~100 lines down, below
    // the CAIP-19 examples and the exit-code table, where nobody reads it.
    const text = await help();
    const prerequisite = text.indexOf('PREREQUISITE');
    const options = text.indexOf('Options:');

    expect(prerequisite).toBeGreaterThan(-1);
    expect(text).toContain('Permit2');
    expect(prerequisite).toBeLessThan(options);
  });

  it('still lists the Permit2 contract addresses, which is what the prerequisite points at', async () => {
    expect(await help()).toContain('0x000000000022D473030F116dDEE9F6B43aC78BA3');
  });

  it("says <amount> is what the receiver gets, in the destination token's smallest units", async () => {
    const { stdout } = await run(binPath('send-payment'), ['--help']);

    expect(stdout.replace(/\s+/g, ' ')).toContain(
      "Amount the receiver gets, in the destination token's smallest units",
    );
  });

  it('documents that --prepare-only is outside the payment exit-code contract', async () => {
    // Exit 0 there means "signed", not "paid". `send-payment ... && ship-goods` would otherwise
    // ship goods against a payment that was never made.
    expect(await help()).toContain('--prepare-only');
    expect(await help()).toMatch(/does not apply to\n--prepare-only/);
  });
});

/**
 * `send-payment` has two forms, and every option belongs to exactly one of them. The grouping is
 * declared in option-groups.ts and enforced at runtime through commander's conflict list; these
 * cases keep the declaration honest, so an option cannot be added without deciding where it goes.
 */
describe('send-payment option groups', () => {
  /**
   * Every long flag the command declares, read from the help it actually prints.
   *
   * Scoped to the options block and anchored to the start of a line. Scanning the rest of the help
   * as free text would count a flag merely MENTIONED in the prose below as declared, which makes the
   * "publishes every option it classifies" direction vacuous for the several flags the prose names:
   * the declaration could be deleted and the group would still match the prose. Commander writes the
   * options as a contiguous list, so the block ends at the first blank line.
   */
  const published = async (): Promise<string[]> => {
    const { stdout } = await run(binPath('send-payment'), ['--help']);
    const block = stdout.slice(stdout.indexOf('Options:')).split('\n\n')[0];
    return block
      .split('\n')
      .map((line) => line.match(/^ {2}(?:-\w, )?(--[a-zA-Z][\w-]*)/)?.[1])
      .filter((flag): flag is string => flag !== undefined);
  };

  it('classifies every option it publishes', async () => {
    // The guard that matters: a new option that nobody classified fails here rather than being
    // silently accepted by --submit and ignored.
    const classified = new Set<string>([
      ...BUILD_ONLY_OPTIONS,
      ...SEND_OPTIONS,
      ...FORM_OPTIONS,
      '--version',
      '--help',
    ]);
    const unclassified = (await published()).filter((flag) => !classified.has(flag));

    expect(unclassified).toEqual([]);
  });

  it('publishes every option it classifies', async () => {
    // The other direction: a group naming an option that no longer exists would silently stop
    // protecting anything.
    const flags = new Set(await published());
    const missing = [...BUILD_ONLY_OPTIONS, ...SEND_OPTIONS, ...FORM_OPTIONS].filter(
      (flag) => !flags.has(flag),
    );

    expect(missing).toEqual([]);
  });

  it('puts no option in two groups at once', () => {
    const all = [...BUILD_ONLY_OPTIONS, ...SEND_OPTIONS, ...FORM_OPTIONS];

    expect(all).toHaveLength(new Set(all).size);
  });

  it.each([...BUILD_ONLY_OPTIONS, ...HIDDEN_BUILD_ONLY_OPTIONS])(
    'refuses %s alongside --submit',
    async (flag) => {
      // Every flag here takes a value, and the value has to be a valid one: commander coerces before
      // it checks conflicts, so a bad value would fail this for the wrong reason. 120 parses for all
      // of them, including the two that require whole seconds. The file does not exist on purpose --
      // the conflict must be reported before anything tries to read it.
      const result = await run(binPath('send-payment'), [
        '--submit',
        'nonexistent.json',
        flag,
        '120',
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(flag);
      expect(result.stderr).toContain('cannot be used with');
    },
  );
});

describe('argument handling, with no gateway reachable', () => {
  // Nothing here should get as far as the network; if one of these starts hanging, that is the bug.
  const UNREACHABLE = 'http://127.0.0.1:1';

  it('send-payment refuses a malformed CAIP-19 source asset before prompting for a key', async () => {
    const result = await run(binPath('send-payment'), [
      '0xF0D07a1c182Bc68a757C641014e0bAE7C4f17640',
      '100000',
      'not-a-caip19-asset',
      '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      'eip155:42220/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
      '--max-source-amount',
      '103000',
      '--gateway',
      UNREACHABLE,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('❌ Error:');
    // It must not have asked for a secret to tell the user about a bad argument.
    expect(result.stderr).not.toContain('Enter private key');
  });

  it('send-payment exits 1, not 0, when stdin closes before a private key is entered', async () => {
    // Exit 0 means a completed payment; a script with no PRIVATE_KEY and no terminal must not see it.
    const result = await run(binPath('send-payment'), [
      '0xF0D07a1c182Bc68a757C641014e0bAE7C4f17640',
      '100000',
      'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      'eip155:42220/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
      '--max-source-amount',
      '103000',
      '--gateway',
      UNREACHABLE,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no private key entered before stdin closed: set PRIVATE_KEY');
  });

  it('send-payment refuses an unknown --provider', async () => {
    const result = await run(binPath('send-payment'), [
      '0xF0D07a1c182Bc68a757C641014e0bAE7C4f17640',
      '100000',
      'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      'eip155:42220/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
      '--provider',
      'nonsense',
      '--max-source-amount',
      '103000',
      '--gateway',
      UNREACHABLE,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown --provider 'nonsense'");
  });

  // Each flag that takes a value is given a valid one: commander coerces before it checks
  // conflicts, so a bad value would fail this for the wrong reason.
  const SUBMIT_ONLY_ARGS: Record<(typeof SUBMIT_ONLY_OPTIONS)[number], string[]> = {
    '--auto-accept': [],
    '--wait': [],
    '--wait-for': ['completed'],
    '--wait-seconds': ['10'],
  };

  it.each(SUBMIT_ONLY_OPTIONS)(
    'send-payment refuses --prepare-only together with %s',
    async (flag) => {
      const result = await run(binPath('send-payment'), [
        '--prepare-only',
        flag,
        ...SUBMIT_ONLY_ARGS[flag],
        'a',
        'b',
        'c',
        'd',
        'e',
      ]);

      expect(result.status).toBe(1);
      // Whichever side declared the conflict names the other first.
      expect(result.stderr).toMatch(
        new RegExp(
          `'--prepare-only' cannot be used with option '${flag}[^']*'|'${flag}[^']*' cannot be used with option '--prepare-only'`,
        ),
      );
    },
  );

  // send-payment is absent on purpose: its arguments are optional so --submit can omit them, so it
  // reports a short invocation itself. That is covered by the two rules below.
  it.each([
    ['payment-status', []],
    ['quote-status', []],
    ['request-quote', []],
  ])('%s reports a missing required argument', async (name, args) => {
    const result = await run(binPath(name), args as string[]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing required argument');
  });

  it.each(['send-payment', 'request-quote'])(
    '%s rejects a non-integer --wait-seconds style value',
    async (name) => {
      const result = await run(binPath(name), [
        '--quote-deadline-seconds',
        '1.5',
        'a',
        'b',
        'c',
        'd',
        'e',
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        '--quote-deadline-seconds must be an integer number of seconds',
      );
    },
  );

  // The arguments are declared optional so --submit can omit them, which means commander no longer
  // reports a short invocation. These two rules replace it, and they say more than it could.
  it.each([
    [[] as string[], 0],
    [['0xF0D0', '100000', 'a'], 3],
  ])('send-payment names both forms when given %p', async (args) => {
    const result = await run(binPath('send-payment'), args);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('needs five arguments');
    expect(result.stderr).toContain('--submit <file>');
  });

  it('send-payment refuses --submit together with the corridor arguments', async () => {
    const file = join(SCRATCH, 'both.json');
    writeFileSync(file, JSON.stringify({ request_id: 'r1' }));

    const result = await run(binPath('send-payment'), [
      '--submit',
      file,
      '0xF0D07a1c182Bc68a757C641014e0bAE7C4f17640',
      '100000',
      'a',
      'b',
      'c',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('corridor arguments do not apply');
  });

  it('send-payment refuses --submit together with --prepare-only', async () => {
    const result = await run(binPath('send-payment'), ['--submit', 'x.json', '--prepare-only']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot be used with option '--prepare-only'");
  });

  it('--submit refuses a file that is not a payment request', async () => {
    const file = join(SCRATCH, 'garbage.json');
    writeFileSync(file, JSON.stringify({ hello: 'world' }));

    const result = await run(binPath('send-payment'), ['--submit', file, '--gateway', UNREACHABLE]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no request_id');
  });

  it('--submit refuses an empty file', async () => {
    const file = join(SCRATCH, 'empty.json');
    writeFileSync(file, '   \n');

    const result = await run(binPath('send-payment'), ['--submit', file, '--gateway', UNREACHABLE]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is empty');
  });

  it('--submit refuses a file that is not JSON', async () => {
    const file = join(SCRATCH, 'notjson.json');
    writeFileSync(file, 'this is not json');

    const result = await run(binPath('send-payment'), ['--submit', file, '--gateway', UNREACHABLE]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not valid JSON');
  });

  it.each([
    ['an array', '[]'],
    ['a scalar', '42'],
  ])('--submit refuses JSON that is %s rather than an object', async (_label, body) => {
    const file = join(SCRATCH, `shape-${_label.replace(/\s/g, '')}.json`);
    writeFileSync(file, body);

    const result = await run(binPath('send-payment'), ['--submit', file, '--gateway', UNREACHABLE]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not hold a PaymentRequest object');
  });

  it('--submit - reports an empty stdin rather than hanging', async () => {
    // stdin is closed rather than a terminal here, so this reaches the empty-input branch. The
    // terminal branch cannot be exercised without a pty; both end in a message rather than a wait.
    const result = await run(binPath('send-payment'), ['--submit', '-', '--gateway', UNREACHABLE]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nothing arrived on stdin');
  });

  /**
   * The recovery advice after a failed --submit. This is the only new logic in this change that has
   * been wrong twice: first by claiming a re-prepare reproduces the same document, then by telling
   * every failure that the window had closed when a refused connection fails in milliseconds with it
   * wide open. It needs no gateway to exercise -- an unreachable one fails fast, which is exactly
   * the case that was wrong.
   */
  describe.each([
    ['still ahead', '2099-01-01T00:00:00.000Z', 'may still be open'],
    ['already past', '2020-01-01T00:00:00.000Z', 'will be refused'],
    // A deadline this machine cannot read must not be guessed as closed: that would send the
    // operator to find a key holder for a file that is probably fine.
    ['unreadable', 'not-a-timestamp', 'may still be open'],
    ['absent', undefined, 'may still be open'],
  ])('recovery advice when the quote window is %s', (_label, deadline, advice) => {
    it(`says "${advice}"`, async () => {
      const file = join(SCRATCH, `recovery-${_label.replace(/\s/g, '-')}.json`);
      writeFileSync(
        file,
        JSON.stringify({
          request_id: 'recovery-probe',
          ...(deadline === undefined ? {} : { quote_deadline: deadline }),
          sender_auth: { signed_messages: [{ message: '0x1', signature: '0xab' }] },
        }),
      );

      const result = await run(binPath('send-payment'), [
        '--submit',
        file,
        '--gateway',
        UNREACHABLE,
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('recovery-probe');
      expect(result.stderr).toContain(advice);
    });
  });

  it('offers no window advice at all when the file could not be read', async () => {
    // requestId and the parsed document are assigned together, so a file that never parsed leaves
    // both undefined and the advice is skipped rather than guessing about a document nobody has.
    const file = join(SCRATCH, 'unparseable-for-advice.json');
    writeFileSync(file, 'not json');

    const result = await run(binPath('send-payment'), ['--submit', file, '--gateway', UNREACHABLE]);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('quote window');
  });

  it('--submit refuses a request that was never signed', async () => {
    const file = join(SCRATCH, 'unsigned.json');
    writeFileSync(
      file,
      JSON.stringify({
        request_id: 'r1',
        sender_auth: { signed_messages: [{ message: '0x1', signature: '' }] },
      }),
    );

    const result = await run(binPath('send-payment'), ['--submit', file, '--gateway', UNREACHABLE]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('carries no sender_auth signature');
  });

  // The cap is the payer's signed spend ceiling; the CLI must demand it explicitly and must do so
  // before asking for a key, so an operator never types a secret only to be told an argument is missing.
  it('send-payment refuses a build with no --max-source-amount before prompting for a key', async () => {
    const result = await run(binPath('send-payment'), [
      '0xF0D07a1c182Bc68a757C641014e0bAE7C4f17640',
      '100000',
      'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      'eip155:42220/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
      '--gateway',
      UNREACHABLE,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--max-source-amount');
    expect(result.stderr).not.toContain('Enter private key');
  });

  // The cap is signed in the source token's smallest units, so only a canonical positive integer is
  // meaningful. Anything else is refused before the key prompt: a typo must never cost a secret.
  // '-5' uses the `=` form so the value is unambiguous to a reader; commander would take it either way.
  it.each([
    ['a decimal', ['--max-source-amount', '1.5']],
    ['zero', ['--max-source-amount', '0']],
    ['a leading zero', ['--max-source-amount', '01']],
    ['a negative number', ['--max-source-amount=-5']],
    ['a non-number', ['--max-source-amount', 'abc']],
    ['exponent notation', ['--max-source-amount', '1e6']],
    ['a hex literal', ['--max-source-amount', '0x10']],
    ['leading whitespace', ['--max-source-amount', ' 5']],
  ])(
    'send-payment refuses %s as --max-source-amount before prompting for a key',
    async (_label, capArgs) => {
      const result = await run(binPath('send-payment'), [
        '0xF0D07a1c182Bc68a757C641014e0bAE7C4f17640',
        '100000',
        'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
        'eip155:42220/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
        ...capArgs,
        '--gateway',
        UNREACHABLE,
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--max-source-amount');
      expect(result.stderr).not.toContain('Enter private key');
    },
  );

  it('send-payment does not refuse a well-formed --max-source-amount', async () => {
    // The command still fails further on (no key on a closed stdin, no gateway), so the exit status
    // says nothing here; the point is only that the cap check lets a valid value through.
    const result = await run(binPath('send-payment'), [
      '0xF0D07a1c182Bc68a757C641014e0bAE7C4f17640',
      '100000',
      'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      'eip155:42220/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
      '--max-source-amount',
      '103000',
      '--gateway',
      UNREACHABLE,
    ]);

    expect(result.stderr).not.toContain('needs --max-source-amount');
    expect(result.stderr).not.toContain('must be a positive');
  });

  it('--submit does not demand --max-source-amount (it builds nothing)', async () => {
    // The file is absent, so the command fails for that reason; the point is only that the cap
    // requirement is scoped to the build form and never leaks into the submit form.
    const result = await run(binPath('send-payment'), [
      '--submit',
      'does-not-exist.json',
      '--gateway',
      UNREACHABLE,
    ]);

    expect(result.stderr).not.toContain('--max-source-amount');
  });
});

/**
 * The tools driven end to end against a gateway defined by the OpenAPI contract. Every request they
 * send is validated against the spec on arrival, so these also answer "does the contract still
 * describe what these commands do?".
 */
/**
 * A JSON-RPC node that answers only what an allowance read needs: the chain id, and one
 * `eth_call` returning a fixed allowance. Enough to drive approve-permit2 past the read and into
 * the branches that matter, without a chain.
 */
function startFakeRpc(allowance: bigint): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed: unknown = JSON.parse(body);
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      const answers = batch.map((call) => {
        const { id, method } = call as { id: number; method: string };
        const result =
          method === 'eth_chainId'
            ? '0x7a69'
            : method === 'eth_blockNumber'
              ? '0x1'
              : method === 'eth_call'
                ? `0x${allowance.toString(16).padStart(64, '0')}`
                : null;
        return { jsonrpc: '2.0', id, result };
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]));
    });
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      ready({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe('approve-permit2, against a node that answers', () => {
  const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  // Derives 0xf39Fd6e5…2266, the anvil account 0 key. A fixed test key, never a real secret.
  const SENDER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const EVM_ASSET = 'eip155:31337/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
  const MAX_UINT256 = (1n << 256n) - 1n;

  // The allowance read happens BEFORE the key is requested, so an already-approved wallet — which
  // is every wallet after the first run — never has to produce a secret to learn there was
  // nothing to do. A refactor that moves the prompt back above the read fails here.
  it('exits without asking for a private key when the wallet is already approved', async () => {
    const rpc = await startFakeRpc(MAX_UINT256);
    try {
      const result = await run(binPath('approve-permit2'), [
        SENDER,
        EVM_ASSET,
        '--rpc-url',
        rpc.url,
      ]);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('private key');
      expect(result.stdout).toContain('"alreadySufficient": true');
    } finally {
      await rpc.close();
    }
  });

  // Without this check the allowance is read for <sender> while the approval is granted by
  // whatever account the key holds: a successful-looking run that approves the wrong account and
  // still fails at settlement.
  it('refuses a private key that does not derive <sender>', async () => {
    const rpc = await startFakeRpc(0n);
    try {
      const result = await run(
        binPath('approve-permit2'),
        ['0x90F79bf6EB2c4f870365E785982E1f101E93b906', EVM_ASSET, '--rpc-url', rpc.url],
        { env: { PRIVATE_KEY: SENDER_KEY } },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/does not match the sender/);
    } finally {
      await rpc.close();
    }
  });

  // --amount bounds the approval that gets SENT; it never lowers an allowance that is already
  // larger. A bare "already approved" would read as though the cap had been applied, so the
  // command says what it did not do.
  it('says it never lowers an allowance when --amount is below the current one', async () => {
    const rpc = await startFakeRpc(MAX_UINT256);
    try {
      const result = await run(binPath('approve-permit2'), [
        SENDER,
        EVM_ASSET,
        '--rpc-url',
        rpc.url,
        '--amount',
        '5000000',
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"alreadySufficient": true');
      expect(result.stderr).toMatch(/never lowers an existing allowance/);
    } finally {
      await rpc.close();
    }
  });

  it('reports that an approval is needed under --check, without a key', async () => {
    const rpc = await startFakeRpc(0n);
    try {
      const result = await run(binPath('approve-permit2'), [
        SENDER,
        EVM_ASSET,
        '--rpc-url',
        rpc.url,
        '--check',
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"approvalNeeded": true');
      expect(result.stderr).not.toContain('private key');
    } finally {
      await rpc.close();
    }
  });
});

describe('approve-permit2, with no chain reachable', () => {
  // The approval is the one command here that spends gas, so everything it can refuse without a
  // key and without a network it should refuse there -- these all fail before any RPC call.
  const UNREACHABLE_RPC = 'http://127.0.0.1:1';
  const SENDER = '0xF0D07a1c182Bc68a757C641014e0bAE7C4f17640';
  const EVM_ASSET = 'eip155:42220/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C';

  it('reports that Solana needs no approval at all, rather than trying one', async () => {
    const result = await run(binPath('approve-permit2'), [
      SENDER,
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      '--rpc-url',
      UNREACHABLE_RPC,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Solana needs no Permit2 approval');
  });

  // Tron is supported, so the command must get as far as the network rather than refusing the
  // chain. Reaching a connection error proves tronweb loaded, TronWeb was constructed and the
  // SDK was called -- the whole Tron path short of a live node.
  it('accepts a Tron source and fails at the network, not at the chain', async () => {
    const result = await run(binPath('approve-permit2'), [
      'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs',
      'tron:shasta/trc20:TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs',
      '--rpc-url',
      UNREACHABLE_RPC,
      '--check',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ECONNREFUSED');
    expect(result.stderr).not.toContain('EVM chains only');
    expect(result.stderr).not.toContain('optional peer');
  });

  it('refuses a malformed CAIP-19 source asset', async () => {
    const result = await run(binPath('approve-permit2'), [
      SENDER,
      'not-a-caip19-asset',
      '--rpc-url',
      UNREACHABLE_RPC,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid asset identifier');
  });

  it('names the missing RPC endpoint instead of failing somewhere inside ethers', async () => {
    const result = await run(binPath('approve-permit2'), [SENDER, EVM_ASSET]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--rpc-url');
  });

  it.each([
    ['1.5', 'whole number'],
    ['-1', 'whole number'],
    ['abc', 'whole number'],
    ['0', 'greater than zero'],
  ])('refuses --amount %s', async (amount, expected) => {
    const result = await run(binPath('approve-permit2'), [
      SENDER,
      EVM_ASSET,
      '--rpc-url',
      UNREACHABLE_RPC,
      '--amount',
      amount,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
  });

  // Everything above is refused before a key is read: a bad argument must never cost the user
  // a secret. PRIVATE_KEY is deliberately absent from the environment for all of them.
  it('refuses every bad argument without asking for a private key', async () => {
    const result = await run(binPath('approve-permit2'), [SENDER, 'not-a-caip19-asset']);
    expect(result.stderr).not.toContain('private key');
    expect(result.stdout).toBe('');
  });
});

describe('against a contract-driven gateway', () => {
  let gateway: FakeGateway;

  // A well-known Hardhat test key. It signs; it guards nothing.
  const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const RECEIVER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
  const SOURCE_ASSET = 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
  const DEST_ASSET = 'eip155:42220/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C';

  const corridor = () => [SENDER, '100000', SOURCE_ASSET, RECEIVER, DEST_ASSET];
  // Distinct from the fulfillment amount, so passing the wrong one through to the SDK is visible.
  const MAX_SOURCE_AMOUNT = '103000';

  beforeEach(async () => {
    gateway = await startFakeGateway();
  });

  afterEach(async () => {
    await gateway.close();
  });

  function sendPayment(extra: string[]): Promise<Ran> {
    return run(
      binPath('send-payment'),
      [...corridor(), '--max-source-amount', MAX_SOURCE_AMOUNT, '--gateway', gateway.url, ...extra],
      {
        env: { PRIVATE_KEY },
      },
    );
  }

  it('send-payment --prepare-only prints a contract-valid signed request and submits nothing', async () => {
    const result = await sendPayment(['--prepare-only', '--quote-deadline-seconds', '30']);

    expect(result.status).toBe(0);
    const request = JSON.parse(result.stdout);
    expect(request.request_id).toBeTruthy();
    expect(request.sender_auth.signed_messages[0].signature).toMatch(/^0x[0-9a-f]+$/i);
    // The cap the operator typed is both the declared cap and the amount the Permit2 signature authorizes.
    expect(request.max_source_amount).toBe(MAX_SOURCE_AMOUNT);
    const prehash = JSON.parse(request.sender_auth.signed_messages[0].message_prehash);
    expect(prehash.message.permitted.amount).toBe(MAX_SOURCE_AMOUNT);
    // The claim the flag exists to make.
    expect(gateway.received('POST', '/v1/payments')).toHaveLength(0);
    // It did talk to the gateway, for the corridor addresses — "prepare-only" is not "offline".
    expect(gateway.received('GET', '/v1/defaults').length).toBeGreaterThan(0);
    expect(result.stderr).toContain('nothing was submitted and no payment exists');
  });

  it('send-payment --prepare-only builds a Stellar deposit for the delegate epoch it is given', async () => {
    const seed = '22'.repeat(32);
    const sender = Address.account(
      nacl.sign.keyPair.fromSeed(Uint8Array.from(Buffer.from(seed, 'hex'))).publicKey,
    ).toString();
    const account = (byte: number) => Address.account(new Uint8Array(32).fill(byte)).toString();
    const contract = (byte: number) => Address.contract(new Uint8Array(32).fill(byte)).toString();
    const token = contract(0xe1);
    await gateway.close();
    gateway = await startFakeGateway({
      responders: {
        'GET /v1/defaults': (req) => ({
          body: {
            chain_id: req.query.chain_id,
            quote_selector: account(0x55),
            escrow_contract: contract(0xc0),
            fulfillment_proxy: '0x09A5a0d6955E5394A661Cd9E7007076fa63B4158',
            fulfillment_verifier: { account: account(0x66), endpoint: 'https://veri-fill.test' },
          },
        }),
      },
    });

    const result = await run(
      binPath('send-payment'),
      [
        sender,
        '100000',
        `stellar:testnet/sep41:${token}`,
        RECEIVER,
        DEST_ASSET,
        '--max-source-amount',
        MAX_SOURCE_AMOUNT,
        '--gateway',
        gateway.url,
        '--prepare-only',
        '--stellar-delegate-epoch',
        '4',
        // Nothing listens here, so the ledger clock falls back to the local clock.
        '--stellar-rpc-url',
        'http://127.0.0.1:1',
      ],
      { env: { PRIVATE_KEY: seed } },
    );

    expect(result.status).toBe(0);
    const request = JSON.parse(result.stdout);
    expect(request.sender_auth.message_scheme).toBe('STELLAR');
    const message = request.sender_auth.signed_messages[0];
    expect(JSON.parse(message.message_prehash)).toMatchObject({
      epoch: '4',
      depositor: sender,
      token,
      amount: MAX_SOURCE_AMOUNT,
    });
    expect(message.payload).toEqual({ delegate_signer: sender });
    expect(message.signature).toMatch(/^0x[0-9a-f]{128}$/);
    expect(gateway.received('POST', '/v1/payments')).toHaveLength(0);
  });

  describe('Stellar with a delegate signer that is not the sender', () => {
    const seed = '22'.repeat(32);
    const delegate = Address.account(
      nacl.sign.keyPair.fromSeed(Uint8Array.from(Buffer.from(seed, 'hex'))).publicKey,
    ).toString();
    const account = (byte: number) => Address.account(new Uint8Array(32).fill(byte)).toString();
    const contract = (byte: number) => Address.contract(new Uint8Array(32).fill(byte)).toString();
    const token = contract(0xe1);

    async function prepare(sender: string, extra: string[]) {
      await gateway.close();
      gateway = await startFakeGateway({
        responders: {
          'GET /v1/defaults': (req) => ({
            body: {
              chain_id: req.query.chain_id,
              quote_selector: account(0x55),
              escrow_contract: contract(0xc0),
              fulfillment_proxy: '0x09A5a0d6955E5394A661Cd9E7007076fa63B4158',
              fulfillment_verifier: { account: account(0x66), endpoint: 'https://veri-fill.test' },
            },
          }),
        },
      });
      return run(
        binPath('send-payment'),
        [
          sender,
          '100000',
          `stellar:testnet/sep41:${token}`,
          RECEIVER,
          DEST_ASSET,
          '--max-source-amount',
          MAX_SOURCE_AMOUNT,
          '--gateway',
          gateway.url,
          '--prepare-only',
          '--stellar-delegate-epoch',
          '4',
          '--stellar-rpc-url',
          'http://127.0.0.1:1',
          ...extra,
        ],
        { env: { PRIVATE_KEY: seed } },
      );
    }

    it('refuses a sender whose own key is not the signing key, unless the delegate is declared', async () => {
      const refused = await prepare(contract(0xd2), []);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/does not match|mismatch/i);
    });

    it('signs for a contract-account depositor with its delegate key when declared', async () => {
      const sender = contract(0xd2);
      const result = await prepare(sender, ['--delegate-signer']);
      expect(result.status).toBe(0);
      const message = JSON.parse(result.stdout).sender_auth.signed_messages[0];
      expect(JSON.parse(message.message_prehash)).toMatchObject({ depositor: sender, epoch: '4' });
      expect(message.payload).toEqual({ delegate_signer: delegate });
    });

    it('refuses the flag on a source that is not Stellar', async () => {
      const result = await sendPayment(['--prepare-only', '--delegate-signer']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('applies only to a stellar: source asset');
    });
  });

  it('send-payment without the flag does submit, so the assertion above is not vacuous', async () => {
    // Without this, "no POST happened" would pass just as well against a CLI broken end to end.
    const result = await sendPayment([]);

    expect(gateway.received('POST', '/v1/payments')).toHaveLength(1);
    // The fake's default payment is pending, which is exit 2.
    expect(result.status).toBe(2);
  });

  it('the prepared request satisfies the contract, checked by the gateway on arrival', async () => {
    const prepared = await sendPayment(['--prepare-only', '--quote-deadline-seconds', '30']);
    const file = join(SCRATCH, 'prepared.json');
    writeFileSync(file, prepared.stdout);

    const submitted = await run(binPath('send-payment'), [
      '--submit',
      file,
      '--gateway',
      gateway.url,
    ]);

    const posted = gateway.received('POST', '/v1/payments');
    expect(posted).toHaveLength(1);
    // Validated against the spec's PaymentRequest on the way in; a violation would be recorded here.
    expect(posted[0].violation).toBeUndefined();
    expect(submitted.status).toBe(2);
  });

  it('--submit sends the prepared document unchanged', async () => {
    // The signature covers the contents, so any rewriting between prepare and submit invalidates it.
    const prepared = await sendPayment(['--prepare-only', '--quote-deadline-seconds', '30']);
    const file = join(SCRATCH, 'unchanged.json');
    writeFileSync(file, prepared.stdout);

    await run(binPath('send-payment'), ['--submit', file, '--gateway', gateway.url]);

    expect(gateway.received('POST', '/v1/payments')[0].body).toEqual(JSON.parse(prepared.stdout));
  });

  it('accepts a prepared request through a real shell pipeline', async () => {
    // Deliberately a shell pipeline rather than a spawn with `input`. A shell leaves the read end of
    // a pipe non-blocking, so reading stdin synchronously fails with EAGAIN before the producer has
    // written anything -- which is every run of this flow, since `--prepare-only` makes a gateway
    // round trip first. Handing a child a prepared buffer does not reproduce it: this only failed
    // when a person actually typed the pipe.
    // The script is a fixed string and every path and argument reaches it as a positional
    // parameter, so nothing is interpolated into the command the shell parses. Building it by
    // concatenation would make the command text depend on values from the environment.
    //
    // The three fixed parameters are read and shifted away, so the corridor arrives as "$@". A
    // positional-by-number form would cap at $9 in POSIX sh, where a sixth corridor argument would
    // silently parse as $1 followed by a literal 0.
    const PIPELINE =
      'node=$1; cli=$2; gw=$3; shift 3; ' +
      '"$node" "$cli" "$@" --gateway "$gw" --prepare-only --quote-deadline-seconds 30 2>/dev/null ' +
      '| "$node" "$cli" --submit - --gateway "$gw"';

    const piped = await new Promise<Ran>((resolve, reject) => {
      const child = spawn(
        '/bin/sh',
        [
          '-c',
          PIPELINE,
          'pipeline',
          process.execPath,
          binPath('send-payment'),
          gateway.url,
          ...corridor(),
          '--max-source-amount',
          '103000',
        ],
        {
          cwd: SCRATCH,
          env: { ...BASE_ENV, PRIVATE_KEY },
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
      child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
      child.stdin.end();
    });

    expect(piped.stderr).not.toContain('EAGAIN');
    expect(gateway.received('POST', '/v1/payments')).toHaveLength(1);
    expect(JSON.parse(piped.stdout).payment_id).toBe('0xpayment');
  });

  it('accepts a prepared request on stdin, so the two halves pipe together', async () => {
    const prepared = await sendPayment(['--prepare-only', '--quote-deadline-seconds', '30']);

    const submitted = await run(
      binPath('send-payment'),
      ['--submit', '-', '--gateway', gateway.url],
      {
        input: prepared.stdout,
      },
    );

    expect(gateway.received('POST', '/v1/payments')).toHaveLength(1);
    expect(submitted.status).toBe(2);
  });

  it('send-payment --wait polls the status endpoint and reports what it learned', async () => {
    const result = await sendPayment(['--wait', '--wait-seconds', '10']);

    expect(gateway.received('GET', '/v1/payments/{paymentId}/status').length).toBeGreaterThan(0);
    // The fake's status endpoint answers `completed`, superseding the pending submit.
    expect(JSON.parse(result.stdout).status).toBe('completed');
    expect(result.status).toBe(0);
  });

  it('warns that a prepared request has expired, and sends it anyway', async () => {
    // The one safety net in this flow, and the deliberate choice inside it: the gateway compares
    // against ITS clock, so refusing locally could strand a payment the payer already authorized.
    // It warns and lets the gateway decide.
    const prepared = await sendPayment(['--prepare-only', '--quote-deadline-seconds', '30']);
    const document = JSON.parse(prepared.stdout);
    document.quote_deadline = '2020-01-01T00:00:00.000Z';
    const file = join(SCRATCH, 'expired.json');
    writeFileSync(file, JSON.stringify(document));

    const result = await run(binPath('send-payment'), ['--submit', file, '--gateway', gateway.url]);

    expect(result.stderr).toContain("has passed by this machine's clock");
    // Warned, not refused: the request still reached the gateway.
    expect(gateway.received('POST', '/v1/payments')).toHaveLength(1);
    // The advice has to name the form the remedy belongs to. Recommending
    // --quote-deadline-seconds flatly would point at an option this form refuses, so the reader
    // would type it, be rejected, and be no wiser.
    expect(result.stderr).toContain('an option of the form that builds a request, not of --submit');
  });

  it('send-payment --auto-accept asks the gateway to auto-accept, beside the signed request', async () => {
    await sendPayment(['--auto-accept']);

    const [submit] = gateway.received('POST', '/v1/payments');
    expect(submit.query.auto_accept).toBe('true');
  });

  it('send-payment without --auto-accept carries no auto_accept', async () => {
    await sendPayment([]);

    const [submit] = gateway.received('POST', '/v1/payments');
    expect(submit.query).not.toHaveProperty('auto_accept');
  });

  it('--submit --auto-accept carries the flag for a request built earlier', async () => {
    const prepared = await sendPayment(['--prepare-only', '--quote-deadline-seconds', '30']);
    const file = join(SCRATCH, 'auto-accept-on-submit.json');
    writeFileSync(file, prepared.stdout);

    await run(binPath('send-payment'), [
      '--submit',
      file,
      '--gateway',
      gateway.url,
      '--auto-accept',
    ]);

    const [submit] = gateway.received('POST', '/v1/payments');
    expect(submit.query.auto_accept).toBe('true');
  });

  it('--submit --wait polls the status endpoint, the same as an ordinary run', async () => {
    // option-groups declares --wait as applying to BOTH forms. The ordinary form is covered above;
    // this is the --submit side of that declaration, which nothing else exercises end to end.
    const prepared = await sendPayment(['--prepare-only', '--quote-deadline-seconds', '30']);
    const file = join(SCRATCH, 'wait-on-submit.json');
    writeFileSync(file, prepared.stdout);

    const result = await run(binPath('send-payment'), [
      '--submit',
      file,
      '--gateway',
      gateway.url,
      '--wait',
      '--wait-seconds',
      '10',
    ]);

    expect(gateway.received('GET', '/v1/payments/{paymentId}/status').length).toBeGreaterThan(0);
    // The fake's status endpoint answers `completed`, superseding the pending submit.
    expect(JSON.parse(result.stdout).status).toBe('completed');
    expect(result.status).toBe(0);
  });

  describe('a payment that is paid on chain but not yet final', () => {
    const PAYOUT_TX = '0x' + 'ab'.repeat(32);

    beforeEach(async () => {
      await gateway.close();
      gateway = await startFakeGateway({
        responders: {
          'GET /v1/payments/{paymentId}/status': () => ({
            body: {
              payment_id: '0xpayment',
              status: 'finalizing',
              transactions: {
                fulfillment: {
                  transaction_hash: PAYOUT_TX,
                  chain_id: 'eip155:42220',
                  block_number: 1,
                },
              },
            },
          }),
        },
      });
    });

    it('send-payment --wait stops at finalizing, exits 4 and names the payout', async () => {
      const result = await sendPayment(['--wait', '--wait-seconds', '10']);

      expect(gateway.received('GET', '/v1/payments/{paymentId}/status')).toHaveLength(1);
      expect(JSON.parse(result.stdout).status).toBe('finalizing');
      expect(result.stderr).toContain(PAYOUT_TX);
      expect(result.status).toBe(5);
    });

    it('--wait-for completed waits on through finalizing, and implies --wait', async () => {
      const result = await sendPayment(['--wait-for', 'completed', '--wait-seconds', '3']);

      expect(gateway.received('GET', '/v1/payments/{paymentId}/status').length).toBeGreaterThan(1);
      expect(result.stderr).toContain('gave up waiting for completed');
      expect(result.status).toBe(5);
    });

    it('payment-status exits 0 on a lookup that worked, and names the payout', async () => {
      const result = await run(binPath('payment-status'), ['0xpayment', '--gateway', gateway.url]);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('not yet final');
      expect(result.stderr).toContain(PAYOUT_TX);
    });
  });

  it('send-payment refuses a --wait-for other than finalizing or completed', async () => {
    const result = await sendPayment(['--wait-for', 'pending']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /--wait-for.*pending.*Allowed choices are finalizing, completed/s,
    );
    expect(gateway.received('POST', '/v1/payments')).toHaveLength(0);
  });

  it('payment-status reads a payment and exits on whether the lookup worked', async () => {
    const result = await run(binPath('payment-status'), ['0xpayment', '--gateway', gateway.url]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('completed');
    expect(gateway.received('GET', '/v1/payments/{paymentId}/status')).toHaveLength(1);
  });

  it('request-quote opens a quote-request batch', async () => {
    const result = await run(binPath('request-quote'), [...corridor(), '--gateway', gateway.url]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).quote_request_id).toBe('qr_test');
    const posted = gateway.received('POST', '/v1/payments/quote-requests');
    expect(posted).toHaveLength(1);
    expect(posted[0].violation).toBeUndefined();
  });

  it.each(['--allow-settler', '--whitelistSettler'])(
    '%s lands in settler_requirements.whitelist, on request-quote and send-payment',
    async (flag) => {
      const did = 'did:web:settler.example';

      const quoted = await run(binPath('request-quote'), [
        ...corridor(),
        '--gateway',
        gateway.url,
        flag,
        did,
      ]);
      const prepared = await sendPayment(['--prepare-only', flag, did]);

      expect(quoted.status).toBe(0);
      expect(
        (gateway.received('POST', '/v1/payments/quote-requests')[0].body as CreateQuoteRequest)
          .settler_requirements,
      ).toEqual({ whitelist: [did] });
      expect(prepared.status).toBe(0);
      expect(JSON.parse(prepared.stdout).settler_requirements).toEqual({ whitelist: [did] });
    },
  );

  it('quote-status reads a quote-request batch', async () => {
    const result = await run(binPath('quote-status'), ['qr_test', '--gateway', gateway.url]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).quote_request_id).toBe('qr_test');
    expect(gateway.received('GET', '/v1/payments/quote-requests/{quoteRequestId}')).toHaveLength(1);
  });

  it('reads the gateway from GATEWAY_URL when no flag is given', async () => {
    const result = await run(binPath('payment-status'), ['0xpayment'], {
      env: { GATEWAY_URL: gateway.url },
    });

    expect(result.status).toBe(0);
    expect(gateway.received('GET', '/v1/payments/{paymentId}/status')).toHaveLength(1);
  });
});

describe('awarding a quote, against a contract-driven gateway', () => {
  let gateway: FakeGateway;
  /** The settler-signed quote the fake lists, once request-quote has posted its body. */
  let served: AwardedQuote | undefined;
  /** Set when the quote request reads as awarded to another quote. */
  let awardedTo: { quote_id: string; payment_id: string } | undefined;

  const depositor = new ethers.Wallet(ethers.id('award-quote cli test depositor'));
  const selector = new ethers.Wallet(ethers.id('award-quote cli test selector'));
  const SOURCE_ASSET = 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
  const DEST_ASSET = 'eip155:42220/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
  const RECEIVER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
  const OTHER_QUOTE_ID = '0x' + 'ef'.repeat(32);
  const QUOTE_AMOUNT = '99000';
  const QUOTES_FILE = join(SCRATCH, 'quotes.json');

  async function startGateway(responders: Record<string, Responder> = {}, servesErrors = false) {
    gateway = await startFakeGateway({
      allowInvalidResponses: servesErrors,
      responders: {
        'GET /v1/payments/quote-requests/{quoteRequestId}': () => ({
          body: {
            quote_request_id: 'qr_test',
            status: awardedTo ? 'awarded' : 'ready',
            quotes: served ? [served] : [],
            ...(awardedTo ? { payments: [awardedTo] } : {}),
          },
        }),
        ...responders,
      },
    });
  }

  beforeEach(() => {
    served = undefined;
    awardedTo = undefined;
  });

  afterEach(async () => {
    await gateway.close();
  });

  function requestQuote(extra: string[] = [], receiver = RECEIVER): Promise<Ran> {
    return run(binPath('request-quote'), [
      depositor.address,
      '98000',
      SOURCE_ASSET,
      receiver,
      DEST_ASSET,
      '--max-source-amount',
      '100000',
      '--gateway',
      gateway.url,
      ...extra,
    ]);
  }

  /** Opens a quote request as a script does, keeping its output, and lists a quote for it. */
  async function openQuoteRequest(): Promise<CreateQuoteRequest> {
    const ran = await requestQuote();
    expect(ran.status).toBe(0);
    writeFileSync(QUOTES_FILE, ran.stdout);
    const posted = gateway.received('POST', '/v1/payments/quote-requests')[0]
      .body as CreateQuoteRequest;
    served = await signedQuoteFor(posted, { sourceAmount: QUOTE_AMOUNT });
    return posted;
  }

  function awardQuote(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Ran> {
    return run(binPath('award-quote'), [...args, '--gateway', gateway.url], {
      env: { PRIVATE_KEY: depositor.privateKey, ...env },
    });
  }

  function awarded() {
    return gateway.received('POST', '/v1/payments/awards');
  }

  it('request-quote from a script prints the quotes and the body it sent as JSON, and signs nothing', async () => {
    await startGateway();

    const result = await requestQuote();

    expect(result.status).toBe(0);
    const printed = JSON.parse(result.stdout);
    expect(printed.quote_request_id).toBe('qr_test');
    expect(printed.quote_request).toEqual(
      gateway.received('POST', '/v1/payments/quote-requests')[0].body,
    );
    expect(result.stderr).not.toContain('Award which?');
    expect(awarded()).toHaveLength(0);
    expect(gateway.received('POST', '/v1/payments/quote-requests')[0].query.wait).toBe('true');
  });

  it("request-quote and quote-status from a script print a quote request's error as the gateway sent it", async () => {
    const error = {
      code: 'NO_SETTLER_FOR_CORRIDOR',
      message:
        'No settlement provider currently serves this source and destination pair. This request_id is spent, so a new attempt needs a new one, and it will not succeed until a provider covers the pair.',
      domain: 'PAYMENT_GATEWAY',
      docs_url: 'https://docs.atum.xyz/errors#no-settler-for-corridor',
      retry_classification: 'NOT_RETRYABLE_FIX_REQUEST',
      request_id_reusable: false,
    };
    const batch = {
      quote_request_id: 'qr_test',
      status: 'ready',
      quotes: [],
      requested_count: 0,
      decline_summary: [],
      error,
    };
    await startGateway({
      'POST /v1/payments/quote-requests': () => ({ body: { ...batch, idempotent_replay: false } }),
      'GET /v1/payments/quote-requests/{quoteRequestId}': () => ({ body: batch }),
    });

    const created = await requestQuote();
    const status = await run(binPath('quote-status'), ['qr_test', '--gateway', gateway.url]);

    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout).error).toEqual(error);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).error).toEqual(error);
  });

  it("the contract refuses a quote request's error without a message", async () => {
    await startGateway({
      'GET /v1/payments/quote-requests/{quoteRequestId}': () => ({
        body: {
          quote_request_id: 'qr_test',
          status: 'ready',
          quotes: [],
          error: { code: 'NO_SETTLER_FOR_CORRIDOR' },
        },
      }),
    });

    const status = await run(binPath('quote-status'), ['qr_test', '--gateway', gateway.url]);

    expect(status.status).not.toBe(0);
    expect(
      gateway.received('GET', '/v1/payments/quote-requests/{quoteRequestId}')[0].violation,
    ).toMatch(/\/error must have required property 'message'/);
  });

  it('request-quote --no-wait from a script returns at once, and is not taken for paying', async () => {
    await startGateway();

    const result = await requestQuote(['--no-wait']);

    expect(result.status).toBe(0);
    expect(gateway.received('POST', '/v1/payments/quote-requests')[0].query.wait).toBe('false');
  });

  it('request-quote re-run with the same --request-id prints the batch it recovered, which award-quote --from pays', async () => {
    let first: CreateQuoteRequest | undefined;
    await startGateway({
      // As the API answers a re-sent request_id: the batch opened first, with its own deadlines.
      'POST /v1/payments/quote-requests': (req) => {
        const replay = first !== undefined;
        first ??= req.body as CreateQuoteRequest;
        return {
          body: {
            quote_request_id: 'qr_test',
            status: 'ready',
            idempotent_replay: replay,
            quote_deadline: first.quote_deadline,
            fulfillment_deadline: first.fulfillment_deadline,
            quotes: [],
          },
        };
      },
    });

    expect((await requestQuote(['--request-id', 'quote-again'])).status).toBe(0);
    served = await signedQuoteFor(first!, { sourceAmount: QUOTE_AMOUNT });
    // The deposit commits deadlines in whole seconds, so the re-run must land in a later one.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const again = await requestQuote(['--request-id', 'quote-again']);

    expect(again.status).toBe(0);
    expect(again.stderr).toContain('Recovered quote request qr_test');
    const resent = gateway.received('POST', '/v1/payments/quote-requests')[1]
      .body as CreateQuoteRequest;
    expect(resent.quote_deadline).not.toBe(first!.quote_deadline);
    expect(JSON.parse(again.stdout).quote_request).toEqual({
      ...resent,
      quote_deadline: first!.quote_deadline,
      fulfillment_deadline: first!.fulfillment_deadline,
    });

    writeFileSync(QUOTES_FILE, again.stdout);
    const result = await awardQuote(['--from', QUOTES_FILE]);

    expect(result.stderr).not.toContain('not for this quote request');
    expect(awarded()).toHaveLength(1);
    expect((awarded()[0].body as { quote_id: string }).quote_id).toBe(served.quote_id);
  });

  it.each([
    ['--provider', 'turnkey'],
    ['--wait'],
    ['--wait-for', 'completed'],
    ['--wait-seconds', '30'],
    ['--solana-rpc-url', 'http://127.0.0.1:1'],
  ])(
    'request-quote from a script refuses %s, which only pays, and opens nothing',
    async (...flag) => {
      await startGateway();

      const result = await requestQuote(flag);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${flag[0]} acts on paying`);
      expect(result.stderr).toContain('pay with award-quote --from');
      expect(gateway.requests).toHaveLength(0);
    },
  );

  it('award-quote --from signs the body request-quote sent with the depositor key and prints the payment', async () => {
    await startGateway();
    await openQuoteRequest();

    const result = await awardQuote(['--from', QUOTES_FILE]);

    expect(awarded()).toHaveLength(1);
    const { body, violation } = awarded()[0] as {
      body: {
        request_id: string;
        quote_request_id: string;
        quote_id: string;
        sender_auth: { signed_messages: { message: string; signature: string }[] };
        reserve_auth: { message: string; signature: string };
      };
      violation?: string;
    };
    expect(violation).toBeUndefined();
    expect(body).toMatchObject({
      request_id: `award-${served!.quote_id.slice(2)}`,
      quote_request_id: 'qr_test',
      quote_id: served!.quote_id,
    });
    const deposit = body.sender_auth.signed_messages[0];
    expect(ethers.recoverAddress(deposit.message, deposit.signature)).toBe(depositor.address);
    expect(ethers.recoverAddress(body.reserve_auth.message, body.reserve_auth.signature)).toBe(
      depositor.address,
    );
    expect(JSON.parse(result.stdout).payment_id).toBe('0xpayment');
    // The fake's award answers pending, which is exit 2.
    expect(result.status).toBe(2);
  });

  it('award-quote from a script refuses bare ids, and says to use --from', async () => {
    await startGateway();
    await openQuoteRequest();

    const result = await awardQuote(['qr_test', served!.quote_id]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('from a script, award with --from <request-quote output>');
    expect(gateway.received('GET', '/v1/payments/quote-requests/{quoteRequestId}')).toHaveLength(0);
    expect(awarded()).toHaveLength(0);
  });

  it('award-quote --wait reports the status the payment reached', async () => {
    await startGateway();
    await openQuoteRequest();

    const result = await awardQuote(['--from', QUOTES_FILE, '--wait']);

    expect(gateway.received('GET', '/v1/payments/{paymentId}/status').length).toBeGreaterThan(0);
    expect(JSON.parse(result.stdout).status).toBe('completed');
    expect(result.status).toBe(0);
  });

  it('award-quote refuses a quote_id the quote request does not hold, before asking for a key', async () => {
    await startGateway();
    await openQuoteRequest();

    const result = await awardQuote(['--from', QUOTES_FILE, OTHER_QUOTE_ID], { PRIVATE_KEY: '' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('quote request qr_test holds no quote');
    expect(awarded()).toHaveLength(0);
  });

  it('award-quote refuses a quote request that names another account as selector, before asking for a key', async () => {
    await startGateway();
    await openQuoteRequest();
    const saved = JSON.parse(readFileSync(QUOTES_FILE, 'utf8'));
    saved.quote_request.quote_selector = selector.address;
    writeFileSync(QUOTES_FILE, JSON.stringify(saved));

    const result = await awardQuote(['--from', QUOTES_FILE], { PRIVATE_KEY: '' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`names quote_selector ${selector.address}`);
    expect(result.stderr).toContain('Awarding for another account needs the SDK');
    expect(awarded()).toHaveLength(0);
  });

  it.each([
    ['absent', undefined],
    ['blank', '  '],
  ])(
    'award-quote refuses a saved quote request whose quote_selector is %s, before asking for a key',
    async (_, value) => {
      await startGateway();
      await openQuoteRequest();
      const saved = JSON.parse(readFileSync(QUOTES_FILE, 'utf8'));
      saved.quote_request.quote_selector = value;
      writeFileSync(QUOTES_FILE, JSON.stringify(saved));

      const result = await awardQuote(['--from', QUOTES_FILE], { PRIVATE_KEY: '' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('the quote request names no quote_selector');
      expect(awarded()).toHaveLength(0);
    },
  );

  it('award-quote refuses another quote of an awarded quote request and names its payment', async () => {
    await startGateway();
    await openQuoteRequest();
    awardedTo = { quote_id: OTHER_QUOTE_ID, payment_id: '0x' + '77'.repeat(32) };

    const result = await awardQuote(['--from', QUOTES_FILE, served!.quote_id], { PRIVATE_KEY: '' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `qr_test already awarded quote ${OTHER_QUOTE_ID} (payment 0x${'77'.repeat(32)}). ` +
        'Open a new quote request to pay again.',
    );
    expect(awarded()).toHaveLength(0);
  });

  it("award-quote prints the gateway's 409 body for a script, and says the quote request is spent", async () => {
    await startGateway(
      {
        'POST /v1/payments/awards': () => {
          awardedTo = { quote_id: OTHER_QUOTE_ID, payment_id: '0x' + '77'.repeat(32) };
          return {
            status: 409,
            body: { code: 'QUOTE_REQUEST_ALREADY_AWARDED', message: 'already awarded' },
          };
        },
      },
      true,
    );
    await openQuoteRequest();

    const result = await awardQuote(['--from', QUOTES_FILE]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).code).toBe('QUOTE_REQUEST_ALREADY_AWARDED');
    expect(result.stderr).toContain(`qr_test already awarded quote ${OTHER_QUOTE_ID}`);
    expect(result.stderr).not.toContain('Retry');
  });
});

function binPath(name: string): string {
  const bin = BINS.find((b) => b.name === name);
  if (!bin) throw new Error(`no such command in the manifest: ${name}`);
  return bin.path;
}
