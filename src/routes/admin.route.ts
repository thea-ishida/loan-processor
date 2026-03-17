import { Router, Request, Response, NextFunction } from "express";
import {
  listApplications,
  getApplicationById,
  getAuditLog,
  reviewApplication,
} from "../services/application.service";

function getID(req: Request): string {
    const id = req.params.id;
    if (Array.isArray(id)) {
        return id.join("");
    }
    return id;
}



export const adminRouter = Router();

// Basic auth middleware — only for admin routes
function basicAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", "Basic realm='Admin'");
    res.status(401).json({ error: "Unauthorized", message: "Basic auth required" });
    return;
  }

  // Extract base64 portion after "Basic "
  const base64 = authHeader.substring(6);
  const decoded = Buffer.from(base64, "base64").toString("utf-8");
  const colonIndex = decoded.indexOf(":");
  const user = decoded.substring(0, colonIndex);
  const pass = decoded.substring(colonIndex + 1);

  const expectedUser = process.env.ADMIN_USER || "admin";
  const expectedPass = process.env.ADMIN_PASS || "secret";

  if (user !== expectedUser || pass !== expectedPass) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid credentials" });
    return;
  }

  next();
}


// Apply basic auth to ALL admin routes
adminRouter.use(basicAuth);

// GET /admin/applications?status=flagged_for_review
adminRouter.get(
  "/applications",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = req.query.status as string | undefined;
      const applications = listApplications(status);

      res.status(200).json({
        count: applications.length,
        applications: applications.map((app) => ({
          id: app.id,
          status: app.status,
          applicant_name: app.input.applicant_name,
          email: app.input.email,
          loan_amount: app.input.loan_amount,
          total_score: app.total_score,
          created_at: app.created_at,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);



// GET /admin/applications/:id
adminRouter.get(
  "/applications/:id",
  (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = getID(req);
        const app = getApplicationById(id);

      if (!app) {
        res.status(404).json({
          error: "NotFound",
          message: `Application ${id} not found`,
        });
        return;
      }

      const auditLog = getAuditLog(id);

      res.status(200).json({
        ...app,
        audit_log: auditLog,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /admin/applications/:id/review
adminRouter.post(
  "/applications/:id/review",
  (req: Request, res: Response, next: NextFunction) => {
    try {
        const id = getID(req);
        const { action, note, approved_amount } = req.body;
        const validActions = ["approved", "denied", "partially_approved"];
      
      if (!action || !validActions.includes(action)) {
        res.status(400).json({
          error: "ValidationError",
          message: `action must be one of: ${validActions.join(", ")}`,
        });
        return;
      }

      if (!note || typeof note !== "string") {
        res.status(400).json({
          error: "ValidationError",
          message: "note is required",
        });
        return;
      }

      if (action === "partially_approved" && !approved_amount) {
        res.status(400).json({
          error: "ValidationError",
          message: "approved_amount is required for partially_approved",
        });
        return;
      }

      const updated = reviewApplication(
        id,
        action as "approved" | "denied" | "partially_approved",
        note,
        approved_amount
      );

      res.status(200).json({
        message: `Application ${action}`,
        application_id: updated.id,
        new_status: updated.status,
        approved_amount: updated.approved_amount,
        review_note: updated.review_note,
      });
    } catch (err) {
      next(err);
    }
  }
);
