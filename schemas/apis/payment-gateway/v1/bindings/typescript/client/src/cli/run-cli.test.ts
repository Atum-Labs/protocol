import { readdirSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { Command } from 'commander';
import { runCli } from './run-cli';
import { CliInputError } from './cli-input-error';
import { parseSeconds } from './parse-seconds';

describe('runCli', () => {
  let stderr: jest.SpyInstance;
  let exit: jest.SpyInstance;

  beforeEach(() => {
    stderr = jest.spyOn(console, 'error').mockImplementation(() => {});
    // process.exit is typed as never-returning, so throw to stop the caller the
    // way the real exit would; each test asserts on the recorded code, because
    // the thrown marker alone would also match a wrong non-zero code.
    exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * A command carrying one seconds option, like the real CLIs. Their actions are
   * async, which this does not model: an async rejection never reaches runCli's
   * catch either way, so it is out of scope for these tests.
   */
  function buildProgram(flag: string, action: jest.Mock): Command {
    return new Command().option(`${flag} <n>`, 'seconds', parseSeconds(flag)).action(action);
  }

  const FLAGS = ['--quote-deadline-seconds', '--fulfillment-deadline-seconds', '--wait-seconds'];
  const BAD_VALUES = ['1.5', '1e3', '0x10', 'soon'];

  // Values commander's coercion rejects: a decimal, exponent and hex notation, and plain text.
  const cases = FLAGS.flatMap((flag) => BAD_VALUES.map((value) => [flag, value] as const));

  it.each(cases)('reports %s %s as a one-line error and exits non-zero', (flag, value) => {
    const action = jest.fn();
    const program = buildProgram(flag, action);

    expect(() => runCli(program, [flag, value], { from: 'user' })).toThrow('exit:1');

    expect(action).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(
      '\n❌ Error:',
      `${flag} must be an integer number of seconds`,
    );
  });

  it('rethrows a non-input error from a coercion — a real bug keeps its stack', () => {
    const bug = new TypeError('coercion bug');
    const program = new Command()
      .option('--n <n>', 'n', () => {
        throw bug;
      })
      .action(jest.fn());

    expect(() => runCli(program, ['--n', '1'], { from: 'user' })).toThrow(bug);
    expect(exit).not.toHaveBeenCalled();
  });

  it('rethrows a non-input error from an action handler', () => {
    const bug = new Error('boom');
    const program = new Command().action(() => {
      throw bug;
    });

    expect(() => runCli(program, [], { from: 'user' })).toThrow(bug);
    expect(exit).not.toHaveBeenCalled();
  });

  // Commander reports its own argv failures; runCli must not add a second report.
  it('leaves commander its own errors, with no ❌ prefix', () => {
    const usage = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const program = new Command().option('--known <n>', 'k').action(jest.fn());

    expect(() => runCli(program, ['--bogus'], { from: 'user' })).toThrow('exit:1');

    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).not.toHaveBeenCalled();
    expect(usage).toHaveBeenCalledWith(expect.stringContaining('unknown option'));
  });

  it.each(FLAGS)('leaves a valid %s value alone', (flag) => {
    const action = jest.fn();
    const program = buildProgram(flag, action);

    runCli(program, [flag, '120'], { from: 'user' });

    expect(action).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });
});

// A coercion throw only stays caught while the entry point parses through runCli.
// Importing these would run the CLI, so pin the wiring by source instead.
describe('CLI entry points', () => {
  // The manifest says what ships, so there is no list here to keep in step with
  // it. Command names are compared rather than paths, which leaves the build
  // layout free to change.
  const { bin } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
  };
  const shipped = Object.values(bin ?? {})
    .filter((target): target is string => typeof target === 'string' && target.endsWith('.js'))
    .map((target) => basename(target, '.js'));

  const entries = readdirSync(__dirname)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .filter((file) => readFileSync(join(__dirname, file), 'utf8').startsWith('#!'));

  it('declares every CLI in this directory in the manifest', () => {
    expect(entries).not.toHaveLength(0);
    expect(shipped).toEqual(expect.arrayContaining(entries.map((file) => basename(file, '.ts'))));
  });

  it.each(entries)('%s parses through runCli, not program.parse()', (file) => {
    const source = readFileSync(join(__dirname, file), 'utf8');

    expect(source).toMatch(/^runCli\(program\);$/m);
    expect(source).not.toMatch(/^program\.parse\(/m);
  });

  // send-payment validates <sender> a second time on purpose. createSenderSigner validates it on
  // both provider branches, but the raw branch prompts for the key first, so the early call is the
  // only thing standing between a blank argument and an entered secret. That ordering is the whole
  // point of the call and nothing else asserts it, so a later reader cannot delete it as redundant
  // without this going red.
  it('send-payment checks <sender> before it prompts for a private key', () => {
    const source = readFileSync(join(__dirname, 'send-payment.ts'), 'utf8');
    const check = source.indexOf('requirePinnedSender(sender)');
    const prompt = source.indexOf('promptPrivateKey()');

    expect(check).toBeGreaterThan(-1);
    expect(prompt).toBeGreaterThan(check);
  });
});

describe('CliInputError', () => {
  it('is an Error carrying just the message', () => {
    const error = new CliInputError('--wait-seconds must be an integer number of seconds');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CliInputError');
    expect(error.message).toBe('--wait-seconds must be an integer number of seconds');
  });
});
