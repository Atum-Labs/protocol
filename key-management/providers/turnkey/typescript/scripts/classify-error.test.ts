import { describe, expect, it } from 'vitest';

import { classifyError } from './classify-error';

const outcome = (msg: string): string => classifyError(new Error(msg)).actual;

describe('classifyError', () => {
  it('reports a policy denial as DENY', () => {
    expect(outcome('PolicyEnginePermissionError: not authorized')).toBe('DENY');
    expect(outcome('No policies evaluated to outcome: Allow')).toBe('DENY');
    expect(outcome('Turnkey error 7: forbidden')).toBe('DENY');
    expect(outcome('{"code": 7, "message": "denied"}')).toBe('DENY');
    expect(outcome('HTTP 403 Forbidden')).toBe('DENY');
    expect(outcome('caller lacks sufficient permissions')).toBe('DENY');
  });

  it('reports a request-shape refusal as REJECTED', () => {
    expect(outcome('HTTP 400 unsupported hash function: NotApplicable')).toBe('REJECTED');
    expect(outcome('{"code": 3, "message": "invalid argument"}')).toBe('REJECTED');
  });

  it('keeps a policy denial as DENY even when the message carries an HTTP 400', () => {
    // The ordering this pins: a denial whose message happens to include a 400 must not read as a
    // request-shape refusal, or a pairing Turnkey starts accepting would pass as a healthy DENY.
    expect(outcome('HTTP 400 PolicyEnginePermissionError: not authorized')).toBe('DENY');
    expect(outcome('HTTP 400 body={"code": 7, "message": "policy denied"}')).toBe('DENY');
    expect(outcome('upstream HTTP 400 while proxying HTTP 403 Forbidden')).toBe('DENY');
  });

  it('keeps a request-shape refusal as REJECTED even when it uses the word denied', () => {
    // Bare "deny" wording sits below the 400 check, so generic phrasing cannot promote a 400 into a
    // policy decision.
    expect(outcome('HTTP 400 request denied: malformed payload')).toBe('REJECTED');
  });

  // Turnkey's live answer to approving an activity by a fingerprint that names none.
  it('classifies a not-found answer as REJECTED, since no policy ran', () => {
    expect(
      outcome(
        'TURNKEY_BAD_RESPONSE: Turnkey /public/v1/submit/approve_activity → HTTP 404: {"code":5, "message":"no activity found with fingerprint"}',
      ),
    ).toBe('REJECTED');
  });

  it('falls back to DENY on bare deny wording and ERROR otherwise', () => {
    expect(outcome('operation was denied')).toBe('DENY');
    expect(outcome('socket hang up')).toBe('ERROR');
    expect(outcome('HTTP 500 internal error')).toBe('ERROR');
  });

  it('accepts a non Error throwable', () => {
    expect(classifyError('HTTP 400 bad shape').actual).toBe('REJECTED');
    expect(classifyError(undefined).actual).toBe('ERROR');
  });
});
