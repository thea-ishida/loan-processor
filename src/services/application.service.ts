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

// ─────────────────────────────────────────────
// Submit a new application
// Handles: duplicate check, scoring, state transitions, DB save
// ─────────────────────────────────────────────
export function submitApplication(input: ApplicationInput): Application {
  const db = getDb();

  // 1. DUPLICATE CHECK
  // Same email + loan_amount within configured time window = duplicate
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

  // 2. SCORE THE APPLICATION
  const scoreBreakdown = scoreApplication(input);
  const decision = getDecisionFromScore(scoreBreakdown.total);

  // 3. BUILD THE APPLICATION OBJECT
  const now = new Date().toISOString();
  const id = uuidv4();

  // State machine: submitted → processing → decision
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

  // 4. SAVE TO DATABASE
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

  // 5. WRITE AUDIT LOG
  writeAuditLog({
    application_id: id,
    event: "application_submitted_and_scored",
    from_status: "submitted",
    to_status: status,
    metadata: { total_score: scoreBreakdown.total },
  });

  // 6. IF APPROVED → QUEUE DISBURSEMENT
  if (status === "approved") {
    queueDisbursement(id);
  }

  return application;
}

// ─────────────────────────────────────────────
// Get a single application by ID
// ─────────────────────────────────────────────
export function getApplicationById(id: string): Application | null {
  const db = getDb();

  const row = db
    .prepare(`SELECT * FROM applications WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return rowToApplication(row);
}

// ─────────────────────────────────────────────
// List applications with optional status filter
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// Admin review: approve / deny / partially_approve
// ─────────────────────────────────────────────
export function reviewApplication(
  id: string,
  action: "approved" | "denied" | "partially_approved",
  note: string,
  approvedAmount?: number
): Application {
  const db = getDb();

  const app = getApplicationById(id);
  if (!app) throw new Error(`Application ${id} not found`);

  // Enforce state machine transition
  const newStatus = transition(app.status, action);
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE applications
     SET status = ?, review_note = ?, approved_amount = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    newStatus,
    note,
    approvedAmount ?? null,
    now,
    id
  );

  // Write audit log
  writeAuditLog({
    application_id: id,
    event: "admin_review",
    from_status: app.status,
    to_status: newStatus,
    metadata: { note, approved_amount: approvedAmount },
  });

  // If approved or partially_approved → queue disbursement
  if (newStatus === "approved" || newStatus === "partially_approved") {
    queueDisbursement(id);
  }

  return getApplicationById(id)!;
}

// ─────────────────────────────────────────────
// Queue disbursement after approval
// ─────────────────────────────────────────────
export function queueDisbursement(applicationId: string): void {
  const db = getDb();
  const app = getApplicationById(applicationId);
  if (!app) return;

  const newStatus = transition(app.status, "disbursement_queued");
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE applications SET status = ?, updated_at = ? WHERE id = ?`
  ).run(newStatus, now, applicationId);

  writeAuditLog({
    application_id: applicationId,
    event: "disbursement_queued",
    from_status: app.status,
    to_status: "disbursement_queued",
    metadata: {},
  });
}

// ─────────────────────────────────────────────
// Write an audit log entry
// ─────────────────────────────────────────────
export function writeAuditLog(params: {
  application_id: string;
  event: string;
  from_status?: string;
  to_status?: string;
  retry_id?: string;
  transaction_id?: string;
  metadata?: Record<string, unknown>;
}): void {
  const db = getDb();

  db.prepare(
    `INSERT INTO audit_log (
      id, application_id, event, from_status, to_status,
      retry_id, transaction_id, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuidv4(),
    params.application_id,
    params.event,
    params.from_status ?? null,
    params.to_status ?? null,
    params.retry_id ?? null,
    params.transaction_id ?? null,
    JSON.stringify(params.metadata ?? {}),
    new Date().toISOString()
  );
}

// ─────────────────────────────────────────────
// Get full audit log for an application
// ─────────────────────────────────────────────
export function getAuditLog(applicationId: string): unknown[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM audit_log WHERE application_id = ? ORDER BY created_at ASC`)
    .all(applicationId);
}

// ─────────────────────────────────────────────
// Helper: convert DB row → Application object
// ─────────────────────────────────────────────
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


/**
 * 
 * User POSTs application
        ↓
1. Check for duplicate (same email + amount in last 5 min)
        ↓
2. Score it using scoring.service.ts
        ↓
3. Run state machine: submitted → processing → approved/denied/flagged
        ↓
4. Save to SQLite database
        ↓
5. Write audit log entry
        ↓
6. If approved → automatically queue disbursement
 * 
 */