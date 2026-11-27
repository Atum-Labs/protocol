/**
 * POSTs JSON to the node and returns the parsed response.
 *
 * Node's fetch rejects a refused connection with a bare "fetch failed" and keeps the reason in
 * `error.cause`, so a node that is down or not started yet would otherwise say nothing about which
 * URL or why.
 *
 * @param {string} url
 * @param {object} body
 * @param {Function} [fetchImpl] - defaults to the global fetch
 * @returns {Promise<object>}
 */
async function postJson(url, body, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(`POST ${url}: ${(error.cause && error.cause.code) || error.message}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`POST ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Returns one field of a node response, or throws with the node's own error when it is missing.
 *
 * A failed `wallet/` call answers with `result: {code, message}` and a failed `/jsonrpc` call with
 * `error`, and both would otherwise reach the caller as `undefined`.
 *
 * @param {string} url - the endpoint that answered, for the error
 * @param {object} response - the parsed body
 * @param {string} field - the field's name, for the error
 * @param {*} [value] - the field's value, when it is not `response[field]`
 * @returns {*} the value
 */
function requireField(url, response, field, value = response[field]) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`POST ${url}: no ${field} in response: ${JSON.stringify(response.result ?? response.error ?? response)}`);
  }
  return value;
}

module.exports = { postJson, requireField };
