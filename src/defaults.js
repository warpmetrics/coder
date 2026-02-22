// Named constants for values used across the codebase.

export const TIMEOUTS = {
  CLAUDE: 60 * 60 * 1000,       // claude-code.js — max runtime for a Claude subprocess
  CLAUDE_QUICK: 60_000,         // quick single-turn Claude calls (classify, reflect, changelog)
  HOOK: 5 * 60 * 1000,          // hooks.js — max runtime for a hook command
  DEPLOY: 10 * 60 * 1000,       // deploy/index.js — max runtime for a deploy step
  API_FETCH: 15_000,             // warp.js — timeout for API fetch calls
  SIGKILL_GRACE: 5000,           // claude-code.js — grace period before SIGKILL
};

export const LIMITS = {
  MAX_RETRIES: 3,                // runner.js, deploy/release.js — generic retry limit
  MAX_REVISIONS: 3,              // revise/index.js — max revision attempts per PR
  MAX_REVIEW_RETRIES: 3,         // review/index.js — max review retry attempts
  MAX_INFER_TURNS: 5,            // deploy/release.js — max Claude turns for dependency inference
  MAX_REVIEW_TURNS: 50,          // review/index.js — max Claude turns for review
  REVIEW_TEXT_TRUNCATE: 20_000,  // revise/index.js — truncate review text beyond this
  POLL_INTERVAL: 30,             // watch.js, runner.js — seconds between poll cycles
};

export const CONCURRENCY = {
  WAITING_MULTIPLIER: 5,         // runner.js — multiplier for max waiting acts
  WAITING_MIN: 10,               // runner.js — minimum max waiting acts
};
