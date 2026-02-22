// Centralized name constants for outcomes, acts, labels, and classifications.
// Single source of truth — no hardcoded strings elsewhere.

// Bump when the state machine changes in a way that makes old runs incompatible.
export const VERSION = '2';

// Outcome names
export const OUTCOMES = {
  PR_CREATED: 'PR Created',
  FIXES_APPLIED: 'Fixes Applied',
  MERGED: 'Merged',
  MANUAL_RELEASE: 'Manual Release',
  ISSUE_UNDERSTOOD: 'Issue Understood',
  NEEDS_CLARIFICATION: 'Needs Clarification',
  NEEDS_HUMAN: 'Needs Human',
  IMPLEMENTATION_FAILED: 'Implementation Failed',
  TESTS_FAILED: 'Tests Failed',
  REVISION_FAILED: 'Revision Failed',
  MERGE_FAILED: 'Merge Failed',
  AWAITING_DEPLOY: 'Awaiting Deploy',
  DEPLOY_APPROVED: 'Deploy Approved',
  DEPLOYED: 'Deployed',
  DEPLOY_FAILED: 'Deploy Failed',
  MAX_RETRIES: 'Max Retries',
  STARTED: 'Started',
  RESUMED: 'Resumed',
  CLARIFIED: 'Clarified',
  RELEASED: 'Released',
  RELEASE_FAILED: 'Release Failed',
  REVIEW_FAILED: 'Review Failed',
  RETRIED: 'Retried',
  ABORTED: 'Aborted',
  REVISED: 'Revised',
  CHANGES_REQUESTED: 'Changes Requested',
  APPROVED: 'Approved',
  WAITING: 'Waiting',
  BUILDING: 'Building',
  REVIEWING: 'Reviewing',
  RELEASING: 'Releasing',
};

// Act names
export const ACTS = {
  BUILD: 'Build',
  IMPLEMENT: 'Implement',
  AWAIT_REPLY: 'Await Reply',
  REVIEW: 'Review',
  EVALUATE: 'Evaluate',
  REVISE: 'Revise',
  MERGE: 'Merge',
  DEPLOY: 'Deploy',
  AWAIT_DEPLOY: 'Await Deploy',
  RUN_DEPLOY: 'Run Deploy',
  RELEASE: 'Release',
  PUBLISH: 'Publish',
};

// Run labels
export const LABELS = {
  ISSUE: 'Issue',
  REVISE: 'Revise',
  RELEASE: 'Release',
  CLARIFY: 'Clarify',
};

// Classification list (derived from OUTCOMES)
export const CLASSIFICATIONS = [
  { name: OUTCOMES.PR_CREATED, classification: 'success' },
  { name: OUTCOMES.FIXES_APPLIED, classification: 'success' },
  { name: OUTCOMES.MERGED, classification: 'success' },
  { name: OUTCOMES.MANUAL_RELEASE, classification: 'success' },
  { name: OUTCOMES.ISSUE_UNDERSTOOD, classification: 'success' },
  { name: OUTCOMES.NEEDS_CLARIFICATION, classification: 'neutral' },
  { name: OUTCOMES.NEEDS_HUMAN, classification: 'neutral' },
  { name: OUTCOMES.IMPLEMENTATION_FAILED, classification: 'failure' },
  { name: OUTCOMES.TESTS_FAILED, classification: 'failure' },
  { name: OUTCOMES.REVISION_FAILED, classification: 'failure' },
  { name: OUTCOMES.MERGE_FAILED, classification: 'failure' },
  { name: OUTCOMES.AWAITING_DEPLOY, classification: 'neutral' },
  { name: OUTCOMES.DEPLOY_APPROVED, classification: 'neutral' },
  { name: OUTCOMES.DEPLOYED, classification: 'success' },
  { name: OUTCOMES.DEPLOY_FAILED, classification: 'failure' },
  { name: OUTCOMES.MAX_RETRIES, classification: 'failure' },
  { name: OUTCOMES.STARTED, classification: 'neutral' },
  { name: OUTCOMES.RESUMED, classification: 'neutral' },
  { name: OUTCOMES.CLARIFIED, classification: 'success' },
  { name: OUTCOMES.RELEASED, classification: 'success' },
  { name: OUTCOMES.RELEASE_FAILED, classification: 'failure' },
  { name: OUTCOMES.REVIEW_FAILED, classification: 'failure' },
  { name: OUTCOMES.RETRIED, classification: 'neutral' },
  { name: OUTCOMES.ABORTED, classification: 'failure' },
  { name: OUTCOMES.REVISED, classification: 'success' },
  { name: OUTCOMES.CHANGES_REQUESTED, classification: 'neutral' },
  { name: OUTCOMES.APPROVED, classification: 'success' },
  { name: OUTCOMES.WAITING, classification: 'neutral' },
  { name: OUTCOMES.BUILDING, classification: 'neutral' },
  { name: OUTCOMES.REVIEWING, classification: 'neutral' },
  { name: OUTCOMES.RELEASING, classification: 'neutral' },
];
