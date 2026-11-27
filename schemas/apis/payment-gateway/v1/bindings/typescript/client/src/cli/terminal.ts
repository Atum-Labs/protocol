import * as readline from 'readline';
import { ApiError } from '../generated/core/ApiError';
import { getErrorResponse } from '../errors';
import type { ListedQuote } from './quote-table';
import type { QuoteSelector, SelectorKey } from './quote-selector';

/**
 * Where a Quote API command talks to a person. When stdin and stdout are both a terminal, the
 * commands show tables and ask; otherwise they print JSON and never ask, so a script or an agent
 * is never left waiting on a prompt.
 */
export interface Terminal {
  /** A person is at the keyboard: stdin and stdout are both a terminal. */
  interactive: boolean;
  /** A line for the person. Goes to stderr, so stdout stays machine-readable. */
  write(line: string): void;
  /** Asks one question and returns the trimmed answer. Rejects if stdin closes first. */
  ask(question: string): Promise<string>;
  /**
   * Lets the person move a cursor over the quotes and award one, redrawing as keys arrive and
   * once a second. Absent where keys cannot be read one at a time; the caller then asks for a
   * number.
   */
  choose?<T extends ListedQuote>(selector: QuoteSelector<T>): Promise<void>;
}

/** The text with control characters shown as `?`, so only printable text reaches the screen. */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?');
}

export function processTerminal(): Terminal {
  const keysOneAtATime =
    Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY) &&
    typeof process.stdin.setRawMode === 'function';
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    write: (line) => process.stderr.write(`${printable(line)}\n`),
    ask: (question) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      return new Promise((resolve, reject) => {
        let answered = false;
        rl.question(question, (answer) => {
          answered = true;
          rl.close();
          resolve(answer.trim());
        });
        // Ctrl-C closes the question, so the command ends as "nothing done" instead of waiting.
        rl.on('SIGINT', () => rl.close());
        rl.on('close', () => {
          if (!answered) reject(new Error('cancelled before an answer: nothing signed'));
        });
      });
    },
    ...(keysOneAtATime ? { choose: chooseInTerminal } : {}),
  };
}

const CLEAR_LINE = '\x1b[2K';
const CLEAR_BELOW = '\x1b[J';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

function keyOf(key: readline.Key | undefined): SelectorKey | undefined {
  if (!key) return undefined;
  if (key.ctrl && key.name === 'c') return 'quit';
  if (key.name === 'up' || key.name === 'k') return 'up';
  if (key.name === 'down' || key.name === 'j') return 'down';
  if (key.name === 'return' || key.name === 'enter') return 'enter';
  if (key.name === 'q' || key.name === 'escape') return 'quit';
  return key.sequence && /^[1-9]$/.test(key.sequence) ? (key.sequence as SelectorKey) : undefined;
}

/** Draws the selector on stderr, in place, until the person awards a quote or quits. */
function chooseInTerminal<T extends ListedQuote>(selector: QuoteSelector<T>): Promise<void> {
  const input = process.stdin;
  const output = process.stderr;
  const wasRaw = input.isRaw;
  let drawn = 0;
  const draw = () => {
    const lines = selector.render(Date.now(), output.columns);
    const up = drawn ? `\x1b[${drawn}F` : '';
    output.write(up + lines.map((line) => CLEAR_LINE + line).join('\n') + '\n' + CLEAR_BELOW);
    drawn = lines.length;
  };
  // Leaves the terminal as it was if the process ends while the selector is open.
  const restore = () => {
    input.setRawMode(wasRaw);
    output.write(SHOW_CURSOR);
  };

  return new Promise((resolve) => {
    const finish = () => {
      clearInterval(timer);
      input.off('keypress', onKey);
      output.off('resize', draw);
      process.off('exit', restore);
      restore();
      input.pause();
      resolve();
    };
    const onKey = (_: string, key: readline.Key | undefined) => {
      const pressed = keyOf(key);
      if (pressed) selector.press(pressed, Date.now());
      draw();
      if (selector.state !== 'open') finish();
    };
    const timer = setInterval(() => {
      selector.tick(Date.now());
      draw();
      if (selector.state !== 'open') finish();
    }, 1000);

    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on('keypress', onKey);
    output.on('resize', draw);
    process.on('exit', restore);
    output.write(HIDE_CURSOR);
    draw();
    if (selector.state !== 'open') finish();
  });
}

/**
 * Reports a failed command. A gateway error body goes to stdout as JSON for a script, and as one
 * line for a person.
 */
export function printCliError(error: unknown, terminal: Terminal): void {
  if (error instanceof ApiError && error.body) {
    if (!terminal.interactive) {
      console.log(JSON.stringify(error.body, null, 2));
      return;
    }
    const body = getErrorResponse(error);
    terminal.write(
      `\n❌ Error: ${body ? `${body.code}: ${body.message}` : `${error.status} ${JSON.stringify(error.body)}`}`,
    );
    return;
  }
  terminal.write(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}`);
}
