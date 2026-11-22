/** Error thrown by stores; `retryable` tells the sync engine whether to back off and retry. */
export class StoreError extends Error {
  constructor(message, { retryable = false, cause, code } = {}) {
    super(message);
    this.name = 'StoreError';
    this.retryable = retryable;
    this.code = code;
    if (cause) this.cause = cause;
  }
}
