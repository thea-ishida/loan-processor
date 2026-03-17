// All the numbers that control decisions — in one place, not scattered through code.

export const ScoringConfig = {
  weights: {
    incomeVerification: 0.15,
    incomeLevel:        0.15,
    accountStability:   0.20,
    employmentStatus:   0.40,
    debtToIncome:       0.10,
  },

  thresholds: {
    autoApprove:  75,  // score >= 75  → approved
    manualReview: 50 // score 50-74  → flagged_for_review
                       // score < 50   → denied
  },

  // ─────────────────────────────────────────────────────────────────
  // INCOME TOLERANCE — ASYMMETRIC LOWER-BOUND ONLY
  //
  // Interpretation chosen: one-sided — only fail if documented income
  // is MORE than (incomeTolerance)% BELOW stated income.
  //
  // Formula used in scorer.ts:
  //   lowerBound = stated * (1 - incomeTolerance)   → e.g. $5,000 * 0.90 = $4,500
  //   PASS if:  documented >= lowerBound
  //   PASS if:  documented > stated   ← no upper cap, never penalised
  //   FAIL if:  documented < lowerBound
  //
  // Why NOT symmetric (±10%):
  //   Applicants routinely quote only their primary salary when asked
  //   for income. Their actual bank deposits will often run higher due
  //   to bonuses, overtime, side income, and irregular deposits they
  //   didn't think to include. Penalising someone because their
  //   documented income is HIGHER than stated punishes conservative
  //   self-reporting — the opposite of fraud.
  //
  // Why lower-bound matters:
  //   Documented income coming in significantly BELOW stated is the
  //   genuine red flag — it suggests the applicant inflated their
  //   income figure to qualify. The 10% buffer absorbs legitimate
  //   variance: pay-period timing differences, rounding, and minor
  //   discrepancies between mental accounting and actual deposits.
  //
  // Real-world validation against test scenarios:
  //   Scenario 1  stated $5,000  doc $4,800  bound $4,500  →  PASS
  //   Scenario 5  stated $8,000  doc null    bound —       →  FAIL (no data)
  //   Scenario 6  stated $10,000 doc $1,400  bound $9,000  →  FAIL (fraud signal)
  //
  // To switch to symmetric tolerance, update scoreIncomeVerification()
  // in scorer.ts to also enforce: documented <= stated * (1 + incomeTolerance)
  // No other files need to change.
  // ─────────────────────────────────────────────────────────────────
  incomeTolerance: 0.10,

  duplicateWindowMinutes:      Number(process.env.DUPLICATE_WINDOW_MINUTES)      || 5,
  disbursementTimeoutMinutes:  Number(process.env.DISBURSEMENT_TIMEOUT_MINUTES)  || 30,
  maxRetryAttempts:            Number(process.env.MAX_RETRY_ATTEMPTS)            || 3,
} as const;
