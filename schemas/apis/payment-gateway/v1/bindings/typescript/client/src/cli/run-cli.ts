import type { Command } from 'commander';
import { CliInputError } from './cli-input-error';

/**
 * Parse argv and run the command, reporting a {@link CliInputError} the same way
 * the action handlers report input errors: one line, non-zero exit. Anything else
 * keeps its stack. Extra arguments are forwarded to commander's `parse`; the CLIs
 * pass none and so read `process.argv`.
 *
 * Every CLI entry point is wired through this, including those whose options take
 * no coercion, so a coercion added later needs no new wiring.
 *
 * Commander's `InvalidArgumentError` would report one line without this wrapper,
 * but under commander's `error: option ... is invalid.` prefix instead of the
 * `❌ Error:` the action handlers print.
 *
 * Commander's own parse failures (unknown option, missing argument) report and
 * exit on their own and never reach the catch here.
 */
export function runCli(program: Command, ...parseArgs: Parameters<Command['parse']>): void {
  try {
    program.parse(...parseArgs);
  } catch (error) {
    if (!(error instanceof CliInputError)) throw error;
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}
