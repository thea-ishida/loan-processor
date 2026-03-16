//All the numbers that control decisions — in one place, not scattered through code.


export const ScoringConfig = {
  weights: {
    incomeVerification: 0.30,
    incomeLevel: 0.25,
    accountStability: 0.20,
    employmentStatus: 0.15,
    debtToIncome: 0.10,
  },
  thresholds: {
    autoApprove: 75,   // score >= 75 → approved
    manualReview: 50,  // score 50-74 → flagged_for_review
                       // score < 50  → denied
  },
  // Interpretation: ±10% in EITHER direction
  // documented_income is acceptable if it falls within
  // [stated * 0.90, stated * 1.10]
  // Rationale: fairness — penalizing only underreporting
  // would ignore inflated bank statements
  incomeTolerance: 0.10,
  duplicateWindowMinutes: Number(process.env.DUPLICATE_WINDOW_MINUTES) || 5,
  disbursementTimeoutMinutes: Number(process.env.DISBURSEMENT_TIMEOUT_MINUTES) || 30,
  maxRetryAttempts: Number(process.env.MAX_RETRY_ATTEMPTS) || 3,
} as const;
