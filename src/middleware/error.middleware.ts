import { Request, Response, NextFunction } from "express";
import {
  InvalidStateTransitionError,
  DuplicateApplicationError,
  WebhookReplayError,
} from "../errors";

export function errorMiddleware(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error(`[ERROR] ${err.name}: ${err.message}`);

  if (err instanceof InvalidStateTransitionError) {
    res.status(422).json({
      error: err.name,
      message: err.message,
      from: err.from,
      to: err.to,
    });
    return;
  }

  if (err instanceof DuplicateApplicationError) {
    res.status(409).json({
      error: err.name,
      message: err.message,
      originalApplicationId: err.originalApplicationId,
    });
    return;
  }

  if (err instanceof WebhookReplayError) {
    res.status(200).json({
      message: "Webhook already processed — idempotent no-op",
      transactionId: err.transactionId,
    });
    return;
  }

  res.status(500).json({
    error: "InternalServerError",
    message: err.message || "An unexpected error occurred",
  });
}
