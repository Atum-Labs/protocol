/**
 * A failed tronweb send throws only "REVERT opcode executed"; the revert data, whose selector names
 * the custom error, is left in `error.output.contractResult[0]`.
 */

/**
 * @param {Error} error - what tronweb's send threw
 * @returns {Error} the same error if it carries no revert data, otherwise one whose message adds it
 */
function withRevertData(error) {
  const data = error && error.output && Array.isArray(error.output.contractResult) && error.output.contractResult[0];
  if (!data) {
    return error;
  }
  return new Error(`${error.message} (revert data 0x${data})`, { cause: error });
}

module.exports = { withRevertData };
