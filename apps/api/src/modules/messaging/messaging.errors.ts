// modules/messaging/messaging.errors.ts
// One error for both channels. `retryable` is true only when the provider cannot
// have accepted the message (transport failure, 429) or the failure is
// transient (timeout, 5xx); a certain refusal (other 4xx, no config) is not.

export class MessagingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'MessagingError';
  }
}
