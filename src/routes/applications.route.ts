import { Router, Request, Response, NextFunction } from "express";
import { submitApplication } from "../services/application.service";

export const applicationRouter = Router();

// POST /applications
// Submit a new loan application
applicationRouter.post(
  "/",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = req.body;

      // Basic validation
      const required = [
        "applicant_name", "email", "loan_amount",
        "stated_monthly_income", "employment_status",
      ];
      for (const field of required) {
        if (input[field] === undefined || input[field] === null) {
          res.status(400).json({
            error: "ValidationError",
            message: `Missing required field: ${field}`,
          });
          return;
        }
      }

      const application = submitApplication(input);

      res.status(201).json({
        message: "Application submitted and processed",
        application_id: application.id,
        status: application.status,
        total_score: application.total_score,
        score_breakdown: application.score_breakdown,
      });
    } catch (err) {
      next(err); // passes to error middleware
    }
  });
  export default applicationRouter;

