# Architecture Overview
The project follows a Controller-Service-Repository pattern to ensure a clean separation of concerns.
* **Routes/Controllers**: Handle HTTP parsing and validation of JSON input.
* **Services**: Contain core business logic, including the scoring engine and disbursement layer.
* **State Machine**: A dedicated, enforced transition layer that prevents invalid status changes.
* **Database**: SQLite is used for zero-friction setup, utilizing the schema provided in the technical requirements.

---

# State Machine Design
The state machine is enforced, not just tracked. Any attempt to bypass a valid flow throws a typed `InvalidStateTransitionError`.

### Valid Transitions:
* **submitted** -> **processing**
* **processing** -> **approved** | **denied** | **flagged_for_review**
* **approved** -> **disbursement_queued**
* **disbursement_queued** -> **disbursed** | **disbursement_failed**
* **disbursement_failed** -> **disbursement_queued** (Automatic Retry)
* **flagged_for_review** -> **approved** | **denied** | **partially_approved**

### Mid-Spec Migration: partially_approved
To accommodate the product request for reduced loan amounts, a `partially_approved` state was added. It slots between `flagged_for_review` and `disbursement_queued`, allowing reviewers to specify a `reduced_loan_amount`.

---

# Scoring Explanation
### Decision Thresholds
Weights and thresholds are managed via `ScoringConfig` to avoid hardcoding:
* **Score >= 75**: Auto-approve
* **Score 50-74**: Flag for manual review
* **Score < 50**: Auto-deny

### Income Verification: The 10% Tolerance
**Interpretation**: Asymmetric Lower-Bound Only.
* **The Rule**: An applicant fails this check only if their documented income is more than 10% below their stated income.
* **The Reasoning**: Real-world applicants typically quote primary salary, while bank statements often capture additional income like bonuses or overtime. Penalizing an applicant for having higher documented income than stated does not align with credit risk perspectives.

---

# Webhook Flow and Idempotency
### The Tradeoff: Retry Idempotency vs. Audit Trail
**The Conflict**: Product wants 3 auto-retries on failure, but Finance requires a unique audit record for every single attempt.

**The Solution**: We separate Transaction Identity from Retry Identity:
1. **transaction_id (External)**: Provided by the payment system. If we receive the same `transaction_id` twice, it is treated as a replay. We log the receipt in the audit log but make no state changes.
2. **retry_id (Internal)**: Our system generates a unique UUID for every new disbursement attempt triggered after a failure.
3. **disbursement_attempts Table**: Stores every unique attempt with its own `retry_id`, `attempt_number`, and timestamp, satisfying Finance requirements.

### Timeout Handling
A background poller checks for applications stuck in `disbursement_queued` longer than the configured timeout and moves them to `flagged_for_review`.

---

# Duplicate Prevention and Idempotency
* **Duplicate Check**: Submissions with the same Email + Loan Amount within a 5-minute window are rejected. The response returns a `DuplicateApplicationError` and the original application ID.
* **Webhook Replay**: Replayed webhooks are idempotent based on the `transaction_id`, ensuring no duplicate state transitions occur.

---

# API Endpoints
### Application Endpoints
* **POST /applications**: Submit a new loan application.

### Admin Endpoints (Basic Auth)
* **GET /admin/applications?status=flagged_for_review**: List filtered applications.
* **GET /admin/applications/:id**: View full detail including score breakdown.
* **POST /admin/applications/:id/review**: Approve, deny, or partially_approve with a note.

### Webhook Endpoint
* **POST /webhook/disbursement**: Asynchronous callback for disbursement results.

---

# Tradeoffs and Assumptions
| Decision | Tradeoff |
| :--- | :--- |
| **SQLite over PostgreSQL** | Chosen for zero-setup friction in a local environment; not suitable for concurrent production loads. |
| **Null Bank Data Score 0** | Incomplete applications should not receive the benefit of the doubt on missing data. |
| **Asymmetric Tolerance** | Prioritizes fairness for conservative self-reporters over a strict symmetric match. |
| **Binary Income Score (0/100)** | Simple and auditable; avoids unrequested complexity. |