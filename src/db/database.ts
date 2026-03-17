// "The Database Connection + Table Setup"
// 4 tables — each with a single, distinct responsibility.

import Database from "better-sqlite3";
import path from "path";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const DB_PATH = process.env.DB_PATH || "./data/loan.db";

// Ensure the directory exists before connecting
const dbDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(path.resolve(DB_PATH));
    db.pragma("journal_mode = WAL"); // safe concurrent reads during writes
    db.pragma("foreign_keys = ON");  // enforce FK constraints at DB level
  }
  return db;
}

export function initDb(): void {
  const database = getDb();

  database.exec(`
    -- TABLE 1: applications
    CREATE TABLE IF NOT EXISTS applications (
      id                    TEXT PRIMARY KEY,
      status                TEXT NOT NULL,
      applicant_name        TEXT NOT NULL,
      email                 TEXT NOT NULL,
      loan_amount           REAL NOT NULL,
      stated_monthly_income REAL NOT NULL,
      employment_status     TEXT NOT NULL,
      input_json            TEXT NOT NULL,       
      score_breakdown_json  TEXT,                
      total_score           REAL,                
      approved_amount       REAL,                
      review_note           TEXT,                
      retry_count           INTEGER DEFAULT 0,   
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_applications_email_loan
      ON applications(email, loan_amount, created_at);

    CREATE INDEX IF NOT EXISTS idx_applications_status
      ON applications(status);


    -- TABLE 2: disbursement_attempts
    CREATE TABLE IF NOT EXISTS disbursement_attempts (
      id                TEXT PRIMARY KEY,
      application_id    TEXT NOT NULL REFERENCES applications(id),
      retry_id          TEXT NOT NULL UNIQUE,    
      attempt_number    INTEGER NOT NULL,        
      transaction_id    TEXT,                    
      status            TEXT NOT NULL,           
      created_at        TEXT NOT NULL,
      resolved_at       TEXT                     
    );

    CREATE INDEX IF NOT EXISTS idx_disbursement_attempts_application
      ON disbursement_attempts(application_id);


    -- TABLE 3: webhook_events
    CREATE TABLE IF NOT EXISTS webhook_events (
      id                TEXT PRIMARY KEY,
      transaction_id    TEXT NOT NULL,           
      application_id    TEXT NOT NULL REFERENCES applications(id),
      status            TEXT NOT NULL,           
      payload_json      TEXT NOT NULL,           
      is_replay         INTEGER NOT NULL DEFAULT 0,  
      received_at       TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_transaction_id
      ON webhook_events(transaction_id);


    -- ─────────────────────────────────────────────────────────────────
    -- TABLE 4: audit_logs 
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS audit_logs (
      id                TEXT PRIMARY KEY,
      application_id    TEXT NOT NULL REFERENCES applications(id),
      event_type        TEXT NOT NULL,           
      from_status       TEXT,                    
      to_status         TEXT,                    
      triggered_by      TEXT NOT NULL,           
      event_data_json   TEXT,                    
      created_at        TEXT NOT NULL
    );

    -- Updated index name to match the new table name
    CREATE INDEX IF NOT EXISTS idx_audit_logs_application
      ON audit_logs(application_id, created_at);

  `);

  console.log("Database initialized — 4 tables ready including audit_logs");
}