/**
 * Creates an Error whose `.userMessage` is safe to show directly to end users,
 * while `.message` keeps the technical detail for logs/devtools.
 * @param {string} message - technical message (console/logs)
 * @param {string} userMessage - short, friendly message safe for UI display
 * @param {unknown} [cause] - original error, if any, attached for debugging
 */
export function makeError(message, userMessage, cause) {
  const err = new Error(message);
  err.userMessage = userMessage;
  if (cause !== undefined) err.cause = cause;
  return err;
}

/** Wraps an unknown thrown value into our error shape, preserving a useful userMessage. */
export function wrapError(err, userMessage) {
  if (err && typeof err === 'object' && typeof err.userMessage === 'string') {
    return err;
  }
  const message = err && err.message ? err.message : String(err);
  return makeError(message, userMessage, err);
}
