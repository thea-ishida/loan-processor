import { ApplicationInput, ScoreBreakdown } from "../models/application.model";
import { ScoringConfig } from "../config/scoring.config";

// take an application and apply the score
// Takes the raw application data

//Runs each of the 5 scoring factors

//Multiplies each by its weight

// Returns the full breakdown + total
// Score each factor 0-100, then apply weights
export function scoreApplication(input: ApplicationInput): ScoreBreakdown {
  const incomeVerification = scoreIncomeVerification(input);
  const incomeLevel        = scoreIncomeLevel(input);
  const accountStability   = scoreAccountStability(input);
  const employmentStatus   = scoreEmploymentStatus(input);
  const debtToIncome       = scoreDebtToIncome(input);

  const total =
    incomeVerification * ScoringConfig.weights.incomeVerification +
    incomeLevel        * ScoringConfig.weights.incomeLevel +
    accountStability   * ScoringConfig.weights.accountStability +
    employmentStatus   * ScoringConfig.weights.employmentStatus +
    debtToIncome       * ScoringConfig.weights.debtToIncome;

  return {
    incomeVerification,
    incomeLevel,
    accountStability,
    employmentStatus,
    debtToIncome,
    total: Math.round(total * 100) / 100, // round to 2 decimal places
  };
}

// ─────────────────────────────────────────────
// Factor 1: Income Verification (30%)
// Interpretation: documented income must be within ±10% of stated income
// i.e. documented must fall in [stated * 0.90, stated * 1.10]
// If documented_monthly_income is null → cannot verify → score 0
// ─────────────────────────────────────────────
function scoreIncomeVerification(input: ApplicationInput): number {
  if (input.documented_monthly_income === null) return 0;

  const stated       = input.stated_monthly_income;
  const documented   = input.documented_monthly_income;
  const tolerance    = ScoringConfig.incomeTolerance;

  const lowerBound = stated * (1 - tolerance); // stated * 0.90
  const upperBound = stated * (1 + tolerance); // stated * 1.10

  if (documented >= lowerBound && documented <= upperBound) {
    return 100; // within tolerance → full score
  }

  return 0; // outside tolerance → no score
}

// ─────────────────────────────────────────────
// Factor 2: Income Level (25%)
// Is monthly income >= 3x the requested loan amount?
// Graded: full score if >= 3x, partial if >= 2x, low if >= 1x, 0 if < 1x
// ─────────────────────────────────────────────
function scoreIncomeLevel(input: ApplicationInput): number {
  const ratio = input.stated_monthly_income / input.loan_amount;

  if (ratio >= 3) return 100;  // strong ✅
  if (ratio >= 2) return 60;   // borderline
  if (ratio >= 1) return 30;   // weak
  return 0;                    // income less than loan amount
}

// ─────────────────────────────────────────────
// Factor 3: Account Stability (20%)
// 3 sub-checks, each worth ~33 points:
//   - positive ending balance
//   - no overdrafts
//   - consistent deposits
// If data is null → treat as failing that check (0 points)
// ─────────────────────────────────────────────
function scoreAccountStability(input: ApplicationInput): number {
  let score = 0;

  // Positive ending balance
  if (input.bank_ending_balance !== null && input.bank_ending_balance > 0) {
    score += 34;
  }

  // No overdrafts
  if (input.bank_has_overdrafts !== null && input.bank_has_overdrafts === false) {
    score += 33;
  }

  // Consistent deposits
  if (input.bank_has_consistent_deposits !== null && input.bank_has_consistent_deposits === true) {
    score += 33;
  }

  return score; // 0, 33, 34, 66, 67, 67, or 100
}

// ─────────────────────────────────────────────
// Factor 4: Employment Status (15%)
// employed > self-employed > unemployed
// ─────────────────────────────────────────────
function scoreEmploymentStatus(input: ApplicationInput): number {
  switch (input.employment_status) {
    case "employed":      return 100;
    case "self-employed": return 60;
    case "unemployed":    return 0;
    default:              return 0;
  }
}

// ─────────────────────────────────────────────
// Factor 5: Debt-to-Income (10%)
// Ratio = monthly_withdrawals / monthly_deposits
// Lower ratio = better (less existing debt obligations)
// If data is null → treat as worst case (score 0)
// ─────────────────────────────────────────────
function scoreDebtToIncome(input: ApplicationInput): number {
  if (
    input.monthly_withdrawals === null ||
    input.monthly_deposits === null ||
    input.monthly_deposits === 0
  ) {
    return 0;
  }

  const ratio = input.monthly_withdrawals / input.monthly_deposits;

  if (ratio <= 0.3)  return 100; // very low debt
  if (ratio <= 0.5)  return 75;  // manageable
  if (ratio <= 0.7)  return 50;  // moderate
  if (ratio <= 0.9)  return 25;  // high
  return 0;                      // >= 90% of income going to withdrawals
}

// ─────────────────────────────────────────────
// Decision: convert total score to status
// ─────────────────────────────────────────────
export function getDecisionFromScore(
  score: number
): "approved" | "flagged_for_review" | "denied" {
  if (score >= ScoringConfig.thresholds.autoApprove) return "approved";
  if (score >= ScoringConfig.thresholds.manualReview) return "flagged_for_review";
  return "denied";
}
