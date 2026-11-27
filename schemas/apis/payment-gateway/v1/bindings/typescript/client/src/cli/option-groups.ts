/**
 * Which options belong to which half of `send-payment`.
 *
 * The command has two forms. One builds a payment request from the corridor arguments, signs it and
 * sends it; the other (`--submit`) sends a request that was built earlier. An option that only
 * shapes a request being BUILT has nothing to act on in the second form, so accepting it there and
 * quietly doing nothing is worse than refusing it: `--request-id` would silently not change the
 * payment's identity, and `--quote-deadline-seconds` would silently not widen any window.
 *
 * The grouping lives here, once, rather than in a condition inside the action, so it is declared
 * rather than implied. `send-payment` feeds BUILD_ONLY_OPTIONS straight into `--submit`'s conflict
 * list and SUBMIT_ONLY_OPTIONS into `--prepare-only`'s, and `entrypoints.test.ts` asserts that
 * every option the command publishes appears in exactly one group — so a new option cannot be
 * added without deciding which form it belongs to.
 */

/**
 * Options that only shape a request being built. Meaningless once a built request exists, and
 * therefore refused alongside `--submit`.
 */
export const BUILD_ONLY_OPTIONS = [
  '--request-id',
  '--request-id-prefix',
  '--max-source-amount',
  '--quote-deadline-seconds',
  '--fulfillment-deadline-seconds',
  '--allow-settler',
  '--provider',
  '--solana-rpc-url',
  '--stellar-rpc-url',
  '--stellar-delegate-epoch',
  '--delegate-signer',
] as const;

/** Old spellings, accepted but left out of the help, refused with --submit like what they alias. */
export const HIDDEN_BUILD_ONLY_OPTIONS = ['--whitelistSettler'] as const;

/**
 * Options that act only on the submit. Meaningless when `--prepare-only` stops before submitting,
 * and therefore refused alongside it.
 */
export const SUBMIT_ONLY_OPTIONS = [
  '--auto-accept',
  '--wait',
  '--wait-for',
  '--wait-seconds',
] as const;

/** Options that apply to sending a request, whichever form produced it. */
export const SEND_OPTIONS = ['--gateway', ...SUBMIT_ONLY_OPTIONS] as const;

/** The options that select a form, rather than configuring one. */
export const FORM_OPTIONS = ['--prepare-only', '--submit'] as const;

/**
 * Commander identifies an option in a conflict list by its camelCase attribute name, while the
 * groups above are written as the flags a person types. Converting here keeps one spelling of each
 * option in this file.
 *
 * @param flag - a long flag, e.g. `--request-id`
 * @returns the attribute name commander derives from it, e.g. `requestId`
 */
export function attributeNameOf(flag: string): string {
  return flag.replace(/^--/, '').replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
