import * as readline from 'readline';

/**
 * Read a private key from the terminal without echoing it.
 *
 * Shared by every CLI that needs one, so the stdout surgery below exists once. The prompt goes
 * to stderr, not stdout, so a command whose result is JSON on stdout stays pipeable.
 *
 * Secrets are never taken from a flag: a flag lands in shell history and in the process list.
 * Callers read PRIVATE_KEY from the environment and fall back to this.
 */
// Hiding typed input means monkey-patching Node's stdout writer and reaching for a
// readline internal, neither of which has a public type. The `any`s and the `arguments`
// forward are that surgery, scoped to this one function rather than loosened across the
// CLI. The unused positional parameters use the repo's `_` convention instead, so a
// genuinely unused binding elsewhere in this function is still reported.
/* eslint-disable @typescript-eslint/no-explicit-any, prefer-rest-params */
export async function promptPrivateKey(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return new Promise((resolve, reject) => {
    let answered = false;
    // Display prompt to stderr so it's visible (doesn't interfere with JSON output)
    process.stderr.write('Enter private key (input hidden): ');

    // Temporarily replace stdout to hide input
    const originalWrite = process.stdout.write;
    process.stdout.write = function (chunk: any, _encoding?: any, _callback?: any) {
      if (chunk === '\n' || chunk === '\r\n') {
        return originalWrite.apply(process.stdout, arguments as any);
      }
      return true;
    };

    rl.question('', (answer) => {
      answered = true;
      // Restore original stdout
      process.stdout.write = originalWrite;
      process.stderr.write('\n');
      rl.close();
      resolve(answer);
    });

    // Without this, a closed stdin (a script, cron, CI) leaves the question pending, node drains
    // its event loop and exits 0, which a caller reads as a completed payment.
    rl.on('close', () => {
      if (answered) return;
      process.stdout.write = originalWrite;
      process.stderr.write('\n');
      reject(new Error('no private key entered before stdin closed: set PRIVATE_KEY'));
    });

    // Mask input - cast to any to access internal method
    (rl as any)._writeToOutput = function () {
      // Don't write anything (hide input)
    };
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any, prefer-rest-params */
