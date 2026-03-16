// defines the shape of every object. Form template -> every part of the app uses these defs to stay consistent


export type EmploymentStatus = "employed" | "self-employed" | "unemployed";

export type ApplicationStatus =
  | "submitted"
  | "processing"
  | "approved"
  | "denied"
  | "flagged_for_review"
  | "partially_approved"
  | "disbursement_queued"
  | "disbursed"
  | "disbursement_failed";

export interface ApplicationInput {
  applicant_name: string;
  email: string;
  loan_amount: number;
  stated_monthly_income: number;
  employment_status: EmploymentStatus;
  documented_monthly_income: number | null;
  bank_ending_balance: number | null;
  bank_has_overdrafts: boolean | null;
  bank_has_consistent_deposits: boolean | null;
  monthly_withdrawals: number | null;
  monthly_deposits: number | null;
}

export interface ScoreBreakdown {
  incomeVerification: number;
  incomeLevel: number;
  accountStability: number;
  employmentStatus: number;
  debtToIncome: number;
  total: number;
}

export interface Application {
  id: string;
  status: ApplicationStatus;
  input: ApplicationInput;
  score_breakdown: ScoreBreakdown;
  total_score: number;
  retry_count: number;
  approved_amount: number | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: string;
  application_id: string;
  event: string;
  from_status: string | null;
  to_status: string | null;
  retry_id: string | null;
  transaction_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
