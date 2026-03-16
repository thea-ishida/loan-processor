import { ApplicationStatus } from "../models/application.model";
import { InvalidStateTransitionError } from "../errors";

// The single source of truth for ALL valid transitions
const VALID_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  submitted:           ["processing"],
  processing:          ["approved", "denied", "flagged_for_review"],
  approved:            ["disbursement_queued"],
  denied:              [],  // terminal state
  flagged_for_review:  ["approved", "denied", "partially_approved"],
  partially_approved:  ["disbursement_queued", "denied"],
  disbursement_queued: ["disbursed", "disbursement_failed"],
  disbursed:           [],  // terminal state
  disbursement_failed: ["disbursement_queued"],  // retryable
};

export function transition(
  current: ApplicationStatus,
  next: ApplicationStatus
): ApplicationStatus {
  const allowed = VALID_TRANSITIONS[current];

  if (!allowed || !allowed.includes(next)) {
    throw new InvalidStateTransitionError(current, next);
  }

  return next;
}

export function getValidTransitions(current: ApplicationStatus): ApplicationStatus[] {
  return VALID_TRANSITIONS[current] ?? [];
}

export function isTerminalState(status: ApplicationStatus): boolean {
  return VALID_TRANSITIONS[status].length === 0;
}
