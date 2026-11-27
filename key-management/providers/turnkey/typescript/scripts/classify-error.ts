/**
 * Classify a thrown Turnkey error into the outcome vocabulary the live policy harness compares
 * against an expectation.
 *
 * `DENY` is the policy engine refusing an operation it evaluated. `REJECTED` is the API refusing the
 * request before any policy ran (HTTP 400 or 404). Conflating them would let a pairing Turnkey starts accepting
 * report as a healthy `DENY`, which is the whole reason the two are distinct.
 *
 * Ordering is load bearing: the narrow policy-engine markers are tested before the generic HTTP 400/404
 * check, so a denial that carries a 400 anywhere in its message still reads as `DENY`. Lives in its
 * own module because `test-policies.ts` runs `main()` on import and so cannot be imported by a test.
 */
export type ErrorOutcome = 'DENY' | 'ERROR' | 'REJECTED';

export function classifyError(err: unknown): { actual: ErrorOutcome; detail: string } {
  const msg = err instanceof Error ? err.message : String(err);

  const isPolicyDeny =
    /PolicyEnginePermissionError/i.test(msg) ||
    /No policies evaluated to outcome: Allow/i.test(msg) ||
    /Turnkey error 7\b/i.test(msg) ||
    /"code":\s*7\b/.test(msg) ||
    /TURNKEY_AUTH\b/.test(msg) ||
    /sufficient permissions/i.test(msg) ||
    /HTTP 403\b/.test(msg);
  if (isPolicyDeny) {
    return { actual: 'DENY', detail: msg };
  }

  // A 404 names an object that does not exist (e.g. approving an activity by an unknown
  // fingerprint), which Turnkey answers before any policy runs.
  if (/HTTP 40[04]\b/.test(msg) || /"code":\s*[35]\b/.test(msg)) {
    return { actual: 'REJECTED', detail: msg };
  }

  // Last resort. Bare "deny" wording stays below the 400/404 check so an API refusal that happens
  // to use the word cannot be reported as a policy decision.
  return { actual: /\bdeny\b|\bdenied\b/i.test(msg) ? 'DENY' : 'ERROR', detail: msg };
}
