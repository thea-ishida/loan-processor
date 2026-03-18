import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/database";
import { scoreApplication, getDecisionFromScore } from "./scoring.service";
import { transition } from "../state-machine/application.state";
import { DuplicateApplicationError } from "../errors";
import { ScoringConfig } from "../config/scoring.config";
import {
  ApplicationInput,
  ApplicationStatus,
  Application,
} from "../models/application.model";

type ReviewAction = "approved" | "denied" | "partially_approved";

export function submitApplication(input: ApplicationInput): Application {
  const db = getDb();

  const windowMinutes = ScoringConfig.duplicateWindowMinutes;
  const windowStart = new Date(
    Date.now() - windowMinutes * 60 * 1000
  ).toISOString();

  const existing = db
    .prepare(
      `SELECT id FROM applications
       WHERE email = ? AND loan_amount = ? AND created_at > ?
       LIMIT 1`
    )
    .get(input.email, input.loan_amount, windowStart) as
    | { id: string }
    | undefined;

  if (existing) {
    throw new DuplicateApplicationError(existing.id);
  }

  const scoreBreakdown = scoreApplication(input);
  const decision = getDecisionFromScore(scoreBreakdown.total, input);

  const now = new Date().toISOString();
  const id = uuidv4();

  let status: ApplicationStatus = "submitted";
  status = transition(status, "processing");
  status = transition(status, decision);

  const application: Application = {
    id,
    status,
    input,
    score_breakdown: scoreBreakdown,
    total_score: scoreBreakdown.total,
    retry_count: 0,
    approved_amount: null,
    review_note: null,
    created_at: now,
    updated_at: now,
  };

  db.prepare(
    `INSERT INTO applications (
      id, status, applicant_name, email, loan_amount,
      input_json, score_breakdown_json, total_score,
      retry_count, approved_amount, review_note,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    application.id,
    application.status,
    input.applicant_name,
    input.email,
    input.loan_amount,
    JSON.stringify(input),
    JSON.stringify(scoreBreakdown),
    scoreBreakdown.total,
    0,
    null,
    null,
    now,
    now
  );

  writeAuditLog({
    application_id: id,
    event: "application_submitted_and_scored",
    from_status: "submitted",
    to_status: status,
    metadata: { total_score: scoreBreakdown.total },
  });

  if (status === "approved") {
    queueDisbursement(id);
  }

  return application;
}

export function getApplicationById(id: string): Application | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM applications WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return rowToApplication(row);
}

export function listApplications(status?: string): Application[] {
  const db = getDb();
  const rows = status
    ? (db
        .prepare(`SELECT * FROM applications WHERE status = ? ORDER BY created_at DESC`)
        .all(status) as Record<string, unknown>[])
    : (db
        .prepare(`SELECT * FROM applications ORDER BY created_at DESC`)
        .all() as Record<string, unknown>[]);

  return rows.map(rowToApplication);
}

export function reviewApplication(
  id: string,
  action: ReviewAction,
  note: string,
  approvedAmount?: number
): Application {
  const db = getDb();

  const app = getApplicationById(id);
  if (!app) throw new Error(`Application ${id} not found`);

  const newStatus = transition(app.status, action);
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE applications
     SET status = ?, review_note = ?, approved_amount = ?, updated_at = ?
     WHERE id = ?`
  ).run(newStatus, note, approvedAmount ?? null, now, id);

  writeAuditLog({
    application_id: id,
    event: "admin_review",
    from_status: app.status,
    to_status: newStatus,
    metadata: { note, approved_amount: approvedAmount },
  });

  if (newStatus === "approved" || newStatus === "partially_approved") {
    queueDisbursement(id);
  }

  return getApplicationById(id) as Application;
}


export function queueDisbursement(applicationId: string): void {
  const db = getDb();
  const app = getApplicationById(applicationId);
  if (!app) return;

  // FIX: Transition to 'disbursement_queued', not back to 'approved'
  const newStatus = transition(app.status, "disbursement_queued"); 
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE applications SET status = ?, updated_at = ? WHERE id = ?`
  ).run(newStatus, now, applicationId);

  writeAuditLog({
    application_id: applicationId,
    event: "disbursement_queued",
    from_status: app.status,
    to_status: newStatus,
    triggered_by: "system",
    metadata: {},
  });
}

export function writeAuditLog(params: {
  application_id: string;
  event: string;
  from_status?: string;
  to_status?: string;
  triggered_by?: string;
  transaction_id?: string; 
  metadata?: Record<string, unknown>;
}): void {
  const db = getDb();
  
  // Merge transaction_id into metadata if you don't have a dedicated column
  const finalMetadata = {
    ...params.metadata,
    ...(params.transaction_id ? { transaction_id: params.transaction_id } : {}),
  };

  db.prepare(`
    INSERT INTO audit_logs (
      id, application_id, event_type, from_status, to_status, triggered_by, event_data_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    params.application_id,
    params.event,
    params.from_status ?? null,
    params.to_status ?? null,
    params.triggered_by ?? "system",
    JSON.stringify(finalMetadata), // Using the merged metadata here
    new Date().toISOString()
  );
}

export function getAuditLog(applicationId: string): unknown[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM audit_logs WHERE application_id = ? ORDER BY created_at ASC`
    )
    .all(applicationId);
}

function rowToApplication(row: Record<string, unknown>): Application {
  return {
    id: row.id as string,
    status: row.status as ApplicationStatus,
    input: JSON.parse(row.input_json as string),
    score_breakdown: JSON.parse(row.score_breakdown_json as string),
    total_score: row.total_score as number,
    retry_count: row.retry_count as number,
    approved_amount: row.approved_amount as number | null,
    review_note: row.review_note as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}
