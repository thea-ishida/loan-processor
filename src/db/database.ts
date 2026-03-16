// "The Database Connection + Table Setup"

import Database from "better-sqlite3";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const DB_PATH = process.env.DB_PATH || "./data/loan.db";

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(path.resolve(DB_PATH));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  return db;
}

export function initDb(): void {
  const database = getDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      applicant_name TEXT NOT NULL,
      email TEXT NOT NULL,
      loan_amount REAL NOT NULL,
      input_json TEXT NOT NULL,
      score_breakdown_json TEXT NOT NULL,
      total_score REAL NOT NULL,
      retry_count INTEGER DEFAULT 0,
      approved_amount REAL,
      review_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      event TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      retry_id TEXT,
      transaction_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_webhooks (
      transaction_id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      status TEXT NOT NULL,
      processed_at TEXT NOT NULL
    );
  `);

  console.log("Database initialized");
}
