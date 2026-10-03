export class ProviderError extends Error {
  constructor(message, { status = null, code = '', networkFailure = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.networkFailure = networkFailure;
  }
}
