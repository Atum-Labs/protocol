import { parseSeconds } from './parse-seconds';
import { CliInputError } from './cli-input-error';

describe('parseSeconds', () => {
  const parse = parseSeconds('--quote-deadline-seconds');

  it('accepts a plain integer', () => {
    expect(parse('30')).toBe(30);
  });

  it('trims surrounding whitespace', () => {
    expect(parse('  120  ')).toBe(120);
  });

  it('rejects partial input like 10oops (parseInt would have accepted 10)', () => {
    expect(() => parse('10oops')).toThrow(
      '--quote-deadline-seconds must be an integer number of seconds',
    );
  });

  // The type is load-bearing: runCli reports only CliInputError as one line.
  it('rejects decimals like 1.5 (parseInt would have truncated to 1)', () => {
    expect(() => parse('1.5')).toThrow(CliInputError);
    expect(() => parse('1.5')).toThrow('must be an integer number of seconds');
  });

  it('rejects empty input', () => {
    expect(() => parse('')).toThrow('must be an integer number of seconds');
  });

  // The sign is allowed through on purpose. parse-seconds.ts records which
  // options are guarded downstream and which are not.
  it('parses a negative integer', () => {
    expect(parse('-5')).toBe(-5);
  });
});
