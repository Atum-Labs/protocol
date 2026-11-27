/**
 * A bad option value, thrown by the commander coercions (see parse-seconds.ts).
 * Those run inside `program.parse()`, outside any action handler's try/catch, so
 * the distinct type is what lets runCli report them as one line while a genuine
 * bug keeps its stack. Errors raised inside an action handler are already caught
 * there and do not need this type.
 */
export class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliInputError';
  }
}
