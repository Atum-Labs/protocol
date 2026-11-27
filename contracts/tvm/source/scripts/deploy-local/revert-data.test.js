const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { withRevertData } = require('./revert-data');

// What Escrow's allowTokenAndSetFeeConfig reverts with for a USDT double at 18 decimals:
// TokenDecimalsMismatch(6, 18).
const word = (n) => n.toString(16).padStart(64, '0');
const TOKEN_DECIMALS_MISMATCH = '0f6ce477' + word(6) + word(18);

// The shape tronweb's send({shouldPollResponse: true}) throws when the transaction failed.
function tronwebRevert(contractResult) {
  const error = new Error('REVERT opcode executed');
  error.output = { result: 'FAILED', contractResult };
  return error;
}

describe('withRevertData', () => {
  it('adds the revert data tronweb keeps in output.contractResult to the message', () => {
    const error = tronwebRevert([TOKEN_DECIMALS_MISMATCH]);
    const wrapped = withRevertData(error);
    assert.equal(wrapped.message, `REVERT opcode executed (revert data 0x${TOKEN_DECIMALS_MISMATCH})`);
    assert.equal(wrapped.cause, error);
  });

  it('leaves an error with no revert data as it is', () => {
    for (const error of [new Error('ECONNREFUSED'), tronwebRevert(['']), tronwebRevert([])]) {
      assert.equal(withRevertData(error), error);
    }
  });
});
