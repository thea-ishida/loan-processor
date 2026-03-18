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
  replay: boolean;
}
 {
  const db = getDb();
  const { application_id, status, transaction_id, timestamp } = payload;
  const raw_payload = JSON.stringify(payload);
  const received_at = new Date().toISOString();

   // ─────────────────────────────────────────────────────────────────
  // 1. IDEMPOTENCY CHECK
  //
  // webhook_events has a UNIQUE index on transaction_id, so if the
  // same transaction_id arrives again it's a replay.
  //
  // We do NOT insert another webhook_events row for a replay (the
  // unique constraint would reject it anyway). Instead we log the
  // replay in audit_logs only, and return the current app state.
  // ─────────────────────────────────────────────────────────────────
  const alreadyProcessed = db
    .prepare(`SELECT id FROM webhook_events WHERE transaction_id = ? LIMIT 1`)
    .get(transaction_id) as { id: string } | undefined;

  if (alreadyProcessed) {
    writeAuditLog({
      application_id,
      event: "webhook_replay_ignored",
      triggered_by: "webhook",
      metadata: {
        reason: "transaction_id already processed — idempotent no-op",
        transaction_id,
        original_event_id: alreadyProcessed.id,
        timestamp,
      },
    });

    const app = getApplicationById(application_id);
    return {
      message: "Webhook already processed — idempotent no-op",
      application_id,
      new_status: app?.status ?? "unknown",
      replay: true,
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

    // Record in webhook_events (transaction_id is the idempotency key)
    db.prepare(`
      INSERT INTO webhook_events
        (id, transaction_id, application_id, status, payload_json, is_replay, received_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(
      uuidv4(),
      transaction_id,
      application_id,
      "success",
      raw_payload,
      received_at
    );

     // Record in disbursement_attempts
    // retry_id is unique per delivery — satisfies finance team audit requirement
    const retryId = uuidv4();
    const attemptNumber = (app.retry_count ?? 0) + 1;

    db.prepare(`
      INSERT INTO disbursement_attempts
        (id, application_id, retry_id, attempt_number, transaction_id, status, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      application_id,
      retryId,
      attemptNumber,
      transaction_id,
      "success",
      received_at,
      now
    );

    writeAuditLog({
      application_id,
      event: "disbursement_succeeded",
      from_status: app.status,
      to_status: newStatus,
      triggered_by: "webhook",
      metadata: {
        retry_id: retryId,
        transaction_id,
        attempt_number: attemptNumber,
        timestamp,
      },
    });

  // ─────────────────────────────────────────────────────────────────
  // 4. FAILURE PATH — disbursement_queued → disbursement_failed
  //
  // Key design decision:
  //   transaction_id  = idempotency key (same txn replayed = no-op)
  //   retry_id        = unique UUID per delivery attempt, stored in
  //                     disbursement_attempts for finance team audit
  //
  // Each failure gets its own retry_id, satisfying the finance
  // requirement of a distinct audit record per retry, while the
  // transaction_id uniqueness in webhook_events ensures replays
  // of the same payment event never mutate state twice.
  // ─────────────────────────────────────────────────────────────────
  } else {
    newStatus = transition(app.status, "disbursement_failed");
    const currentRetryCount = (app.retry_count ?? 0) + 1;

    // Unique retry_id per failure attempt — finance team audit trail
    const retryId = uuidv4();

    db.prepare(
      `UPDATE applications SET status = ?, retry_count = ?, updated_at = ? WHERE id = ?`
    ).run(newStatus, currentRetryCount, now, application_id);

    // Record in webhook_events
    db.prepare(`
      INSERT INTO webhook_events
        (id, transaction_id, application_id, status, payload_json, is_replay, received_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(
      uuidv4(),
      transaction_id,
      application_id,
      "failed",
      raw_payload,
      received_at
    );
      // Record in disbursement_attempts with unique retry_id
    db.prepare(`
      INSERT INTO disbursement_attempts
        (id, application_id, retry_id, attempt_number, transaction_id, status, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      application_id,
      retryId,
      currentRetryCount,
      transaction_id,
      "failed",
      received_at,
      now
    );

     writeAuditLog({
      application_id,
      event: "disbursement_failed",
      from_status: app.status,
      to_status: newStatus,
      triggered_by: "webhook",
      metadata: {
        retry_id: retryId,
        transaction_id,
        retry_count: currentRetryCount,
        timestamp,
      },
    });

     // ── AUTO-RETRY OR ESCALATE ────────────────────────────────────
    if (currentRetryCount < ScoringConfig.maxRetryAttempts) {
      const requeued = transition(newStatus as any, "disbursement_queued");

      db.prepare(
        `UPDATE applications SET status = ?, updated_at = ? WHERE id = ?`
      ).run(requeued, now, application_id);

      writeAuditLog({
        application_id,
        event: "disbursement_requeued_for_retry",
        from_status: newStatus,
        to_status: requeued,
        triggered_by: "system",
        metadata: {
          retry_id: retryId,
          retry_count: currentRetryCount,
          max_retries: ScoringConfig.maxRetryAttempts,
        },
      });

      newStatus = requeued;

    } else {
      // Max retries exceeded → escalate
      const escalated = "flagged_for_review";

      db.prepare(
        `UPDATE applications SET status = ?, updated_at = ? WHERE id = ?`
      ).run(escalated, now, application_id);

      writeAuditLog({
        application_id,
        event: "disbursement_escalated_to_manual_review",
        from_status: newStatus,
        to_status: escalated,
        triggered_by: "system",
        metadata: {
          retry_id: retryId,
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
    replay: false,
  };
}


// ─────────────────────────────────────────────
// Timeout checker: runs periodically
// ─────────────────────────────────────────────
export function checkDisbursementTimeouts(): void {
  const db = getDb();
  const timeoutMinutes = ScoringConfig.disbursementTimeoutMinutes;
  const cutoff = new Date(
    Date.now() - timeoutMinutes * 60 * 1000
  ).toISOString();

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
      triggered_by: "system",
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
  transaction_id  = idempotency key (stored in webhook_events table)
                    same txn_id = ignored, no state change

  retry_id        = unique UUID generated fresh for EACH retry attempt
                    stored in audit_logs for finance team
                    completely separate from transaction_id

 * 
 */
