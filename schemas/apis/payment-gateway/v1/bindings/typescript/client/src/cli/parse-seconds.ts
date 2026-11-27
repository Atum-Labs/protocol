import { CliInputError } from './cli-input-error';

/**
 * Commander coercion for an integer-seconds option. Requires a whole integer:
 * `parseInt` would silently accept partial input like "10oops" (as 10) and
 * truncate decimals like "1.5" (to 1), so we validate the full string instead.
 * The sign is allowed through here. For the two `*-deadline-seconds` options,
 * resolveDeadlines rejects a non-positive value, which guards direct library
 * callers too. `--wait-seconds` is not validated. Shared by the CLIs.
 * Rejects with {@link CliInputError}, which runCli reports as a single line.
 */
export function parseSeconds(optionName: string): (value: string) => number {
  return (value: string): number => {
    if (!/^-?\d+$/.test(value.trim())) {
      throw new CliInputError(`${optionName} must be an integer number of seconds`);
    }
    return Number(value);
  };
}
