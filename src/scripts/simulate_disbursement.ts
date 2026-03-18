// scripts/simulate_disbursement.ts
import http from 'http';

/**
 * WEBHOOK SIMULATOR SCRIPT
 * Purpose: Demonstrates Happy Path, Failure/Retry logic, and Idempotency[cite: 280, 294].
 * Requirements: 
 * 1. Success -> disbursed [cite: 271, 272]
 * 2. Failure -> disbursement_failed (retryable) [cite: 273]
 * 3. Replay -> Idempotent (no state change) [cite: 274, 283]
 */

const API_URL = 'http://localhost:3000/webhook/disbursement';
const APPLICATION_ID = 'e4063d5e-77ac-47c7-9587-97377c6ca7a9'; // Use your specific test ID

interface WebhookPayload {
  application_id: string;
  status: 'success' | 'failed';
  transaction_id: string;
  timestamp: string;
}

async function sendWebhook(payload: WebhookPayload): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = http.request(API_URL, options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode || 0, data: body });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

async function runSimulation() {
  console.log('🚀 Starting Webhook Simulation...\n');

  // 1. SIMULATE FAILURE
  // Requirements: Create disbursement_attempts record and log unique retry ID[cite: 285, 286].
  console.log('--- Step 1: Sending FAILURE Webhook ---');
  const failTxn = `txn_fail_${Date.now()}`;
  const failRes = await sendWebhook({
    application_id: APPLICATION_ID,
    status: 'failed',
    transaction_id: failTxn,
    timestamp: new Date().toISOString(),
  });
  console.log(`Response [${failRes.status}]:`, failRes.data, '\n');

  // 2. SIMULATE SUCCESS
  // Requirements: Transition application state to "disbursed"[cite: 259, 272].
  console.log('--- Step 2: Sending SUCCESS Webhook ---');
  const successTxn = `txn_success_${Date.now()}`;
  const successRes = await sendWebhook({
    application_id: APPLICATION_ID,
    status: 'success',
    transaction_id: successTxn,
    timestamp: new Date().toISOString(),
  });
  console.log(`Response [${successRes.status}]:`, successRes.data, '\n');

  // 3. SIMULATE REPLAY
  // Requirements: Same transaction_id replayed = no-op (idempotent)[cite: 257, 258, 274].
  console.log('--- Step 3: Sending REPLAY (Same transaction_id as Step 2) ---');
  const replayRes = await sendWebhook({
    application_id: APPLICATION_ID,
    status: 'success',
    transaction_id: successTxn, // REUSING SUCCESS TXN ID
    timestamp: new Date().toISOString(),
  });
  console.log(`Response [${replayRes.status}]:`, replayRes.data, '\n');

  console.log(' Simulation Complete.');
  console.log('Requirement Check: Verify unique retry IDs in disbursement_attempts vs same transaction_id in webhook_events[cite: 260, 278].');
}

runSimulation().catch((err) => {
  console.error(' Simulation failed:', err.message);
  console.log('Ensure your server is running on http://localhost:3000');
});