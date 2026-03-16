// when soemthing goes wrong, instead of throwing a generic error throw a custom one
// so the api can return the right response
export class InvalidStateTransitionError extends Error {
  constructor(public readonly from: string, public readonly to: string) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

export class DuplicateApplicationError extends Error {
  constructor(public readonly originalApplicationId: string) {
    super(`Duplicate application. Original ID: ${originalApplicationId}`);
    this.name = "DuplicateApplicationError";
  }
}

export class WebhookReplayError extends Error {
  constructor(public readonly transactionId: string) {
    super(`Webhook already processed: ${transactionId}`);
    this.name = "WebhookReplayError";
  }
}
