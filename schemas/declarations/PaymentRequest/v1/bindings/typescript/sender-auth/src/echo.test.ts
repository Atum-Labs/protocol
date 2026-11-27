import { describe, it, expect } from 'vitest';
import { echo } from './commitment-rules.js';

const MAX = 512;
const whole = (text: string) => {
  const codePoints = Array.from(text);
  return codePoints.length <= MAX ? text : codePoints.slice(0, MAX).join('') + '...';
};

// echo cuts to 512 code points exactly as a whole-string split would, lone surrogates included,
// and reads no further than the cut.
describe('echo', () => {
  it('matches a whole-string cut', () => {
    const lone = String.fromCharCode(0xd800);
    for (const text of [
      '',
      'short',
      'a'.repeat(MAX),
      'a'.repeat(MAX + 1),
      'é'.repeat(MAX + 1),
      '😀'.repeat(MAX + 7),
      lone.repeat(MAX + 1),
      'a'.repeat(MAX - 1) + lone + '😀' + 'tail',
    ]) {
      expect(echo(text)).toBe(whole(text));
    }
  });

  it('stays cheap on a huge value', () => {
    const huge = '😀'.repeat(4 << 20);
    const started = performance.now();
    const cut = echo(huge);
    expect(performance.now() - started).toBeLessThan(50);
    expect(cut).toBe(whole(huge.slice(0, 2 * (MAX + 1))));
  });
});
