import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/database";
import { transition } from "../state-machine/application.state";
import { WebhookReplayError } from "../errors";
import { ScoringConfig } from "../config/scoring.config";
import { getApplicationById, writeAuditLog } from "./application.service";

// ─────────────────────────────────────────────
// Webhook payload shape
// ─────────────────────────────────────────────
export interface WebhookPayload {
  application_id: string;
  status: "success" | "failed";
  transaction_id: string;
  timestamp: string;
}

// ─────────────────────────────────────────────
// Main: handle incoming disbursement webhook
// ─────────────────────────────────────────────
export function handleDisbursementWebhook(payload: WebhookPayload): {
  message: string;
  application_id: string;
  new_status: string;
} {
  const db = getDb();
  const { application_id, status, transaction_id, timestamp } = payload;

  // 1. IDEMPOTENCY CHECK
  // If we've seen this transaction_id before → return silently, no state change
  const alreadyProcessed = db
    .prepare(`SELECT transaction_id FROM processed_webhooks WHERE transaction_id = ?`)
    .get(transaction_id) as { transaction_id: string } | undefined;

  if (alreadyProcessed) {
    // This is a replay — spec says idempotent, not an error
    // We log it for audit trail but do NOT change state
    writeAuditLog({
      application_id,
      event: "webhook_replay_ignored",
      transaction_id,
      metadata: { reason: "transaction_id already processed", timestamp },
    });

    const app = getApplicationById(application_id);
    return {
      message: "Webhook already processed — idempotent no-op",
      application_id,
      new_status: app?.status ?? "unknown",
    };
  }

  // 2. GET THE APPLICATION
  const app = getApplicationById(application_id);
  if (!app) {
    throw new Error(`Application ${application_id} not found`);
  }

  // 3. PROCESS BASED ON STATUS
  const now = new Date().toISOString();
  let newStatus: string;

  if (status === "success") {
    // SUCCESS PATH: disbursement_queued → disbursed
    newStatus = transition(app.status, "disbursed");

    db.prepare(
      `UPDATE applications SET status = ?, updated_at = ? WHERE id = ?`
    ).run(newStatus, now, application_id);

    // Mark transaction as processed (idempotency key)
    db.prepare(
      `INSERT INTO processed_webhooks (transaction_id, application_id, status, processed_at)
       VALUES (?, ?, ?, ?)`
    ).run(transaction_id, application_id, "success", now);

    // Audit log
    writeAuditLog({
      application_id,
      event: "disbursement_succeeded",
      from_status: app.status,
      to_status: newStatus,
      transaction_id,
      metadata: { timestamp },
    });

  } else {
    // FAILURE PATH: disbursement_queued → disbursement_failed
    newStatus = transition(app.status, "disbursement_failed");
    const currentRetryCount = app.retry_count + 1;

    db.prepare(
      `UPDATE applications SET status = ?, retry_count = ?, updated_at = ? WHERE id = ?`
    ).run(newStatus, currentRetryCount, now, application_id);

    // Mark transaction as processed
    db.prepare(
      `INSERT INTO processed_webhooks (transaction_id, application_id, status, processed_at)
       VALUES (?, ?, ?, ?)`
    ).run(transaction_id, application_id, "failed", now);

    // Each retry gets a UNIQUE retry_id for the finance team audit trail
    // This reconciles: same transaction = idempotent, each retry = distinct audit record
    const retryId = uuidv4();

    writeAuditLog({
      application_id,
      event: "disbursement_failed",
      from_status: app.status,
      to_status: newStatus,
      transaction_id,
      retry_id: retryId,
      metadata: {
        retry_count: currentRetryCount,
        timestamp,
      },
    });

    // AUTO-RETRY LOGIC
    // Product team: auto-retry up to maxRetryAttempts before escalating
    if (currentRetryCount < ScoringConfig.maxRetryAttempts) {
      // Re-queue for retry
      const requeued = transition(newStatus as any, "disbursement_queued");
      const requeueRetryId = uuidv4();

      db.prepare(
        `UPDATE applications SET status = ?, updated_at = ? WHERE id = ?`
      ).run(requeued, now, application_id);

      writeAuditLog({
        application_id,
        event: "disbursement_requeued_for_retry",
        from_status: newStatus,
        to_status: requeued,
        retry_id: requeueRetryId,       // ← unique ID for finance audit trail
        metadata: {
          retry_count: currentRetryCount,
          max_retries: ScoringConfig.maxRetryAttempts,
        },
      });

      newStatus = requeued;

    } else {
      // MAX RETRIES EXCEEDED → escalate to manual review
      const escalated = "flagged_for_review";

      db.prepare(
        `UPDATE applications SET status = ?, updated_at = ? WHERE id = ?`
      ).run(escalated, now, application_id);

      writeAuditLog({
        application_id,
        event: "disbursement_escalated_to_manual_review",
        from_status: newStatus,
        to_status: escalated,
        metadata: {
          reason: `Failed ${currentRetryCount} times, exceeded max ${ScoringConfig.maxRetryAttempts}`,
        },
      });

      newStatus = escalated;
    }
  }

  return {
    message: `Webhook processed: ${status}`,
    application_id,
    new_status: newStatus,
  };
}

// ─────────────────────────────────────────────
// Timeout checker: runs periodically
// Applications in disbursement_queued with no webhook
// after timeout → flag for manual review
// ─────────────────────────────────────────────
export function checkDisbursementTimeouts(): void {
  const db = getDb();
  const timeoutMinutes = ScoringConfig.disbursementTimeoutMinutes;
  const cutoff = new Date(
    Date.now() - timeoutMinutes * 60 * 1000
  ).toISOString();

  // Find all apps still queued past the timeout window
  const timedOut = db
    .prepare(
      `SELECT id, status FROM applications
       WHERE status = 'disbursement_queued' AND updated_at < ?`
    )
    .all(cutoff) as { id: string; status: string }[];

  for (const app of timedOut) {
    const now = new Date().toISOString();

    db.prepare(
      `UPDATE applications SET status = 'flagged_for_review', updated_at = ? WHERE id = ?`
    ).run(now, app.id);

    writeAuditLog({
      application_id: app.id,
      event: "disbursement_timeout_flagged",
      from_status: "disbursement_queued",
      to_status: "flagged_for_review",
      metadata: {
        reason: `No webhook received within ${timeoutMinutes} minutes`,
        timeout_cutoff: cutoff,
      },
    });

    console.log(`Application ${app.id} timed out → flagged_for_review`);
  }
}


/**
 * 
 * CONFLICT:
  Product team → same transaction replayed = no-op (idempotent)
  Finance team → each retry = separate audit record with unique ID

SOLUTION:
  transaction_id  = idempotency key (stored in processed_webhooks table)
                    same txn_id = ignored, no state change

  retry_id        = unique UUID generated fresh for EACH retry attempt
                    stored in audit_log for finance team
                    completely separate from transaction_id

 * 
 */
