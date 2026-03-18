# AI-Powered Loan Application Processor

This backend system handles loan application scoring, state management, and asynchronous disbursement orchestration via webhooks.

## Quick Start

### Installation
```bash
# Clone the repository
git clone [https://github.com/thea-ishida/loan-processor](https://github.com/thea-ishida/loan-processor)
cd loan-processor

# Install dependencies
npm install

# Initialize the SQLite database and start the server
npm start

## Running the Webhook Simulator
# To demonstrate the happy path, failure/retry logic, and idempotency as required by the spec:
# In a separate terminal window
npm run simulate

# Architecture Overview
[cite_start]The project follows a Controller-Service-Repository pattern to ensure a clean separation of concerns[cite: 299, 608].
* [cite_start]**Routes/Controllers**: Handle HTTP parsing and validation of JSON input[cite: 216, 255].
* [cite_start]**Services**: Contain core business logic, including the scoring engine and disbursement layer[cite: 415, 416].
* [cite_start]**State Machine**: A dedicated, enforced transition layer that prevents invalid status changes[cite: 196, 445].
* [cite_start]**Database**: SQLite is used for zero-friction setup, utilizing the schema provided in the technical requirements[cite: 63, 240, 500].

---

# State Machine Design
[cite_start]The state machine is enforced, not just tracked[cite: 196, 333, 445]. [cite_start]Any attempt to bypass a valid flow throws a typed `InvalidStateTransitionError`[cite: 174, 241, 334, 501].



### Valid Transitions:
* [cite_start]**submitted** -> **processing** [cite: 120, 121, 224, 225]
* **processing** -> **approved** | **denied** | [cite_start]**flagged_for_review** [cite: 124, 125, 228, 229, 230, 231]
* [cite_start]**approved** -> **disbursement_queued** [cite: 128, 129, 233]
* **disbursement_queued** -> **disbursed** | [cite_start]**disbursement_failed** [cite: 165]
* **disbursement_failed** -> **disbursement_queued** (Automatic Retry) [cite: 167, 201, 449]
* **flagged_for_review** -> **approved** | **denied** | [cite_start]**partially_approved** [cite: 136, 137, 202, 450]

### Mid-Spec Migration: partially_approved
[cite_start]To accommodate the product request for reduced loan amounts, a `partially_approved` state was added[cite: 204, 336, 452]. [cite_start]It slots between `flagged_for_review` and `disbursement_queued`, allowing reviewers to specify a `reduced_loan_amount`[cite: 205, 338, 453].

---

# Scoring Explanation
### Decision Thresholds
[cite_start]Weights and thresholds are managed via `ScoringConfig` to avoid hardcoding[cite: 211, 242, 438, 502]:
* **Score >= 75**: Auto-approve [cite: 213, 439]
* [cite_start]**Score 50-74**: Flag for manual review [cite: 213, 440]
* [cite_start]**Score < 50**: Auto-deny [cite: 213, 441]

### Income Verification: The 10% Tolerance
[cite_start]**Interpretation**: Asymmetric Lower-Bound Only[cite: 208, 309, 410].
* [cite_start]**The Rule**: An applicant fails this check only if their documented income is more than 10% below their stated income[cite: 308, 316, 410].
* **The Reasoning**: Real-world applicants typically quote primary salary, while bank statements often capture additional income like bonuses or overtime[cite: 209, 312, 313, 410]. Penalizing an applicant for having higher documented income than stated does not align with credit risk perspectives[cite: 314, 315, 410].

---

# Webhook Flow and Idempotency
### The Tradeoff: Retry Idempotency vs. Audit Trail
**The Conflict**: Product wants 3 auto-retries on failure, but Finance requires a unique audit record for every single attempt[cite: 276, 277, 346, 347, 471, 472].

**The Solution**: We separate Transaction Identity from Retry Identity[cite: 349]:
1. **transaction_id (External)**: Provided by the payment system[cite: 350]. [cite_start]If we receive the same `transaction_id` twice, it is treated as a replay[cite: 257, 258, 351, 469]. [cite_start]We log the receipt in the audit log but make no state changes[cite: 258, 260, 274, 351, 469].
2. [cite_start]**retry_id (Internal)**: Our system generates a unique UUID for every new disbursement attempt triggered after a failure[cite: 286, 354].
3. **disbursement_attempts Table**: Stores every unique attempt with its own `retry_id`, `attempt_number`, and timestamp, satisfying Finance requirements[cite: 285, 359].

### Timeout Handling
[cite_start]A background poller checks for applications stuck in `disbursement_queued` longer than the configured timeout and moves them to `flagged_for_review`[cite: 275, 290, 291, 292, 470].

---

# Duplicate Prevention and Idempotency
* **Duplicate Check**: Submissions with the same Email + Loan Amount within a 5-minute window are rejected[cite: 217, 218, 219, 221, 236, 362, 478]. The response returns a `DuplicateApplicationError` and the original application ID[cite: 222, 236, 363, 478].
* [cite_start]**Webhook Replay**: Replayed webhooks are idempotent based on the `transaction_id`, ensuring no duplicate state transitions occur[cite: 237, 257, 258, 274, 282, 283, 351, 469, 478, 480].

---

# API Endpoints
### Application Endpoints
* **POST /applications**: Submit a new loan application[cite: 214].

### Admin Endpoints (Basic Auth) [cite: 248, 483]
* [cite_start]**GET /admin/applications?status=flagged_for_review**: List filtered applications[cite: 245, 482].
* [cite_start]**GET /admin/applications/:id**: View full detail including score breakdown[cite: 246, 482].
* **POST /admin/applications/:id/review**: Approve, deny, or partially_approve with a note[cite: 247, 251, 482].

### Webhook Endpoint
* [cite_start]**POST /webhook/disbursement**: Asynchronous callback for disbursement results[cite: 253, 263, 457].

---

# Tradeoffs and Assumptions
| Decision | Tradeoff |
| :--- | :--- |
| **SQLite over PostgreSQL** | [cite_start]Chosen for zero-setup friction in a local environment; not suitable for concurrent production loads[cite: 240, 403, 500]. |
| **Null Bank Data Score 0** | [cite_start]Incomplete applications should not receive the benefit of the doubt on missing data[cite: 367, 368, 406]. |
| **Asymmetric Tolerance** | [cite_start]Prioritizes fairness for conservative self-reporters over a strict symmetric match[cite: 408]. |
| **Binary Income Score (0/100)** | [cite_start]Simple and auditable; avoids unrequested complexity[cite: 404, 405]. |