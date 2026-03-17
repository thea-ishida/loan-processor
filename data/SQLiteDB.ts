import Database from 'better-sqlite3';
import { PathLike } from 'fs';
import path from 'path';
import fs from 'fs';

const DB_PATH = "loan_processor.db";

interface SampleApplication {
    scenario: number;
    applicant_name: string;
    email: string;
    loan_amount: number;
    stated_monthly_income: number;
    employment_status: string;
    documented_monthly_income: number | null;
    bank_ending_balance: number | null;
    bank_has_overdrafts: boolean | null;
    bank_has_consistent_deposits: boolean | null;
    monthly_withdrawals: number | null;
    monthly_deposits: number | null;
    note: string;
    expected_outcome: string;
}

const SAMPLE_APPLICATIONS: SampleApplication[] = [
    {
        scenario: 1,
        applicant_name: "Jane Doe",
        email: "jane.doe@example.com",
        loan_amount: 1500,
        stated_monthly_income: 5000,
        employment_status: "employed",
        documented_monthly_income: 4800,
        bank_ending_balance: 3200,
        bank_has_overdrafts: false,
        bank_has_consistent_deposits: true,
        monthly_withdrawals: 1200,
        monthly_deposits: 4800,
        note: "Strong financials",
        expected_outcome: "auto_approve",
    },
    {
        scenario: 2,
        applicant_name: "Bob Smith",
        email: "bob.smith@example.com",
        loan_amount: 2000,
        stated_monthly_income: 1400,
        employment_status: "self-employed",
        documented_monthly_income: 1350,
        bank_ending_balance: 150,
        bank_has_overdrafts: true,
        bank_has_consistent_deposits: false,
        monthly_withdrawals: 1100,
        monthly_deposits: 1350,
        note: "Weak financials",
        expected_outcome: "auto_deny",
    }
];

function connect(): Database.Database {
    const db = new Database(DB_PATH);
    db.pragma('foreign_keys = ON');
    return db;
}

function createSchema(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS applications (
            id TEXT PRIMARY KEY,
            scenario INTEGER,
            applicant_name TEXT NOT NULL,
            email TEXT NOT NULL,
            loan_amount REAL NOT NULL,
            stated_monthly_income REAL NOT NULL,
            employment_status TEXT NOT NULL,
            documented_monthly_income REAL,
            bank_ending_balance REAL,
            bank_has_overdrafts INTEGER,
            bank_has_consistent_deposits INTEGER,
            monthly_withdrawals REAL,
            monthly_deposits REAL,

            status TEXT NOT NULL DEFAULT 'submitted',
            score REAL,
            score_breakdown_json TEXT,
            review_note TEXT,
            reduced_loan_amount REAL,

            expected_outcome TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_applications_email_loan_created
        ON applications(email, loan_amount, created_at);

        CREATE TABLE IF NOT EXISTS webhook_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            application_id TEXT NOT NULL,
            transaction_id TEXT NOT NULL,
            status TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            received_at TEXT NOT NULL,
            is_replay INTEGER NOT NULL DEFAULT 0,
            UNIQUE(transaction_id),
            FOREIGN KEY (application_id) REFERENCES applications(id)
        );

        CREATE TABLE IF NOT EXISTS disbursement_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            application_id TEXT NOT NULL,
            retry_id TEXT NOT NULL,
            transaction_id TEXT,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (application_id) REFERENCES applications(id)
        );

        CREATE TABLE IF NOT EXISTS audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            application_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            event_data_json TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (application_id) REFERENCES applications(id)
        );
    `);
}

function insertSampleApplications(db: Database.Database): void {
    const now = new Date();

    const insertApp = db.prepare(`
        INSERT INTO applications (
            id, scenario, applicant_name, email, loan_amount,
            stated_monthly_income, employment_status, documented_monthly_income,
            bank_ending_balance, bank_has_overdrafts, bank_has_consistent_deposits,
            monthly_withdrawals, monthly_deposits, status, expected_outcome,
            created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertAudit = db.prepare(`
        INSERT INTO audit_events (
            application_id, event_type, event_data_json, created_at
        )
        VALUES (?, ?, ?, ?)
    `);

    const transaction = db.transaction((applications: SampleApplication[]) => {
        for (const row of applications) {
            const applicationId = `app-s${String(row.scenario).padStart(2, '0')}`;
            const createdAtDate = new Date(now.getTime() + row.scenario * 60000);
            const createdAt = createdAtDate.toISOString().split('.')[0] + "Z";

            insertApp.run(
                applicationId,
                row.scenario,
                row.applicant_name,
                row.email,
                row.loan_amount,
                row.stated_monthly_income,
                row.employment_status,
                row.documented_monthly_income,
                row.bank_ending_balance,
                row.bank_has_overdrafts === null ? null : (row.bank_has_overdrafts ? 1 : 0),
                row.bank_has_consistent_deposits === null ? null : (row.bank_has_consistent_deposits ? 1 : 0),
                row.monthly_withdrawals,
                row.monthly_deposits,
                "submitted",
                row.expected_outcome,
                createdAt,
                createdAt
            );

            insertAudit.run(
                applicationId,
                "application_seeded",
                JSON.stringify({
                    scenario: row.scenario,
                    note: row.note,
                    expected_outcome: row.expected_outcome,
                }),
                createdAt
            );
        }

        // Scenario 7: Duplicate
        const duplicateCreatedAt = new Date(now.getTime() + 90000).toISOString().split('.')[0] + "Z";
        insertApp.run(
            "app-s07-duplicate", 7, "Jane Doe", "jane.doe@example.com", 1500,
            5000, "employed", 4800, 3200, 0, 1, 1200, 4800,
            "duplicate_rejected", "duplicate_rejected", duplicateCreatedAt, duplicateCreatedAt
        );
        insertAudit.run(
            "app-s07-duplicate", "duplicate_detected",
            JSON.stringify({ original_application_id: "app-s01", reason: "Same email + loan amount within 5 minutes" }),
            duplicateCreatedAt
        );
    });

    transaction(SAMPLE_APPLICATIONS);
}

function insertSampleWebhookReplay(db: Database.Database): void {
    const payload = {
        application_id: "app-s01",
        status: "success",
        transaction_id: "txn_replay_001",
        timestamp: new Date().toISOString().split('.')[0] + "Z",
    };

    db.prepare(`
        INSERT OR IGNORE INTO webhook_events (
            application_id, transaction_id, status, payload_json, received_at, is_replay
        )
        VALUES (?, ?, ?, ?, ?, 0)
    `).run(
        payload.application_id,
        payload.transaction_id,
        payload.status,
        JSON.stringify(payload),
        payload.timestamp
    );

    db.prepare(`
        INSERT INTO audit_events (
            application_id, event_type, event_data_json, created_at
        )
        VALUES (?, ?, ?, ?)
    `).run(
        "app-s01",
        "webhook_replay_received",
        JSON.stringify({ transaction_id: "txn_replay_001", note: "Second delivery ignored as idempotent replay" }),
        new Date().toISOString().split('.')[0] + "Z"
    );
}

function printSummary(db: Database.Database): void {
    const appCount = (db.prepare("SELECT COUNT(*) AS c FROM applications").get() as any).c;
    const webhookCount = (db.prepare("SELECT COUNT(*) AS c FROM webhook_events").get() as any).c;
    const auditCount = (db.prepare("SELECT COUNT(*) AS c FROM audit_events").get() as any).c;

    console.log(`Database created: ${path.resolve(DB_PATH)}`);
    console.log(`Applications inserted: ${appCount}`);
    console.log(`Webhook events inserted: ${webhookCount}`);
    console.log(`Audit events inserted: ${auditCount}`);

    console.log("\nSample applications:");
    const rows = db.prepare(`
        SELECT id, scenario, applicant_name, email, loan_amount, status, expected_outcome
        FROM applications
        ORDER BY scenario, created_at
    `).all() as any[];

    for (const r of rows) {
        console.log(
            `- ${r.id}: scenario=${r.scenario}, ${r.applicant_name}, $${r.loan_amount}, ` +
            `status=${r.status}, expected=${r.expected_outcome}`
        );
    }
}

function main(): void {
    if (fs.existsSync(DB_PATH)) {
        fs.unlinkSync(DB_PATH);
    }

    const db = connect();
    try {
        createSchema(db);
        insertSampleApplications(db);
        insertSampleWebhookReplay(db);
        printSummary(db);
    } finally {
        db.close();
    }
}

main();