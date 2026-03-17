import { Router, Request, Response, NextFunction } from "express";
import { handleDisbursementWebhook } from "../services/disbursement.service";

export const webhookRouter = Router();

// POST /webhook/disbursement
// Receives disbursement result from payment provider
webhookRouter.post(
  "/disbursement",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const { application_id, status, transaction_id, timestamp } = req.body;

      // Validate required fields
      if (!application_id || !status || !transaction_id || !timestamp) {
        res.status(400).json({
          error: "ValidationError",
          message: "Missing required fields: application_id, status, transaction_id, timestamp",
        });
        return;
      }

      if (status !== "success" && status !== "failed") {
        res.status(400).json({
          error: "ValidationError",
          message: "status must be 'success' or 'failed'",
        });
        return;
      }

      const result = handleDisbursementWebhook({
        application_id,
        status,
        transaction_id,
        timestamp,
      });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);
