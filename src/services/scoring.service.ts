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

// Factor 1: Income Verification (30%)
//
// TOLERANCE INTERPRETATION — ASYMMETRIC LOWER-BOUND ONLY:
//
//   The spec states a "10% tolerance" without specifying direction.
//   We deliberately chose a one-sided (lower-bound only) interpretation:
//
//   PASS:  documented_monthly_income >= stated_monthly_income * (1 - tolerance)
//   PASS:  documented_monthly_income > stated_monthly_income  ← never penalised
//   FAIL:  documented_monthly_income < stated_monthly_income * (1 - tolerance)
//
//   Rationale:
//   Applicants routinely understate total income — they quote only their
//   primary salary and exclude bonuses, freelance, rental income, etc.
//   So documented income running HIGHER than stated is actually a sign of
//   conservative self-reporting, not fraud. We should never penalise that.
//
//   The only genuinely suspicious signal is documented income coming in
//   SIGNIFICANTLY LOWER than stated — that suggests the applicant inflated
//   their income to qualify. The 10% band gives a reasonable buffer for
//   rounding, pay-period timing differences, and minor discrepancies.
//
//   Example outcomes:
//   - Stated $5,000 / Documented $4,800 → lower bound = $4,500 →  PASS
//   - Stated $5,000 / Documented $6,500 → above stated    →  PASS (no upper cap)
//   - Stated $10,000 / Documented $1,400 → lower bound = $9,000 →  FAIL
//
//   If documented_monthly_income is null → cannot verify → score 0
// ─────────────────────────────────────────────────────────────────────────────
function scoreIncomeVerification(input: ApplicationInput): number {
  // Cannot verify without documentation
  if (input.documented_monthly_income === null) return 0;

  const stated     = input.stated_monthly_income;
  const documented = input.documented_monthly_income;
  const tolerance  = ScoringConfig.incomeTolerance; // 0.10

  // Lower bound: documented must not be more than (tolerance)% below stated
  const lowerBound = stated * (1 - tolerance); // e.g. $5,000 * 0.90 = $4,500

  // No upper bound: earning MORE than stated is fine — never penalised
  return documented >= lowerBound ? 100 : 0;
}


// ─────────────────────────────────────────────
// Factor 2: Income Level (25%)
// Is monthly income >= 3x the requested loan amount?
// Graded: full score if >= 3x, partial if >= 2x, low if >= 1x, 0 if < 1x
// ─────────────────────────────────────────────
function scoreIncomeLevel(input: ApplicationInput): number {
  const ratio = input.stated_monthly_income / input.loan_amount;

  if (ratio >= 3) return 100;  // strong income 
  if (ratio >= 2) return 60;   // borderline
  if (ratio >= 1) return 30;   // weak income
  return 0;                    // income less than loan amount
}

// ─────────────────────────────────────────────
// Factor 3: Account Stability (20%)
// 3 sub-checks, each worth ~33 points (total 100 if all 3 are good):
//   - positive ending balance
//   - no overdrafts
//   - consistent deposits
// If all three conditions are met → 100 points, if one or more fail the score drops accordingly (e.g. 2/3 → ~67, 1/3 → ~33, 0/3 → 0)
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
// employed = 100 points (reflects stability and regular income)
// self-employed = 60 points (somewhat less stable, but still good)
// unemployed = 0 points (no income source)
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
// Reward applicants with lower ratios of withdrawals to deposits (i.e. less existing debt obligations relative to income)
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
export function getDecisionFromScore(score: number, input: ApplicationInput): "approved" | "flagged_for_review" | "denied" {
  const missingDocs =
    !input.documented_monthly_income ||
    input.bank_ending_balance === null ||
    input.bank_has_overdrafts === null ||
    input.bank_has_consistent_deposits === null ||
    input.monthly_withdrawals === null ||
    input.monthly_deposits === null;

    const incomeMismatch =
    input.documented_monthly_income &&
    input.stated_monthly_income / input.documented_monthly_income > 3;

    if (incomeMismatch) return "denied"; // deny for falsified income

    if (score >= ScoringConfig.thresholds.autoApprove) return "approved";
    if (missingDocs) return "flagged_for_review"; // override for missing docs
    if (score >= ScoringConfig.thresholds.manualReview) return "flagged_for_review";
    return "denied";
}
