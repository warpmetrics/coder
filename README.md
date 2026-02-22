# @warpmetrics/coder

Local agent loop that watches a GitHub Projects board, implements issues with Claude Code, reviews PRs, deploys, and publishes release notes — fully automated.

## Quick Start

```bash
npx @warpmetrics/coder init
npx @warpmetrics/coder watch
```

## Pipeline

Every issue moves through four phases:

```
Build → Review → Deploy → Release
```

Each phase is a group of steps tracked as outcomes in [WarpMetrics](https://warpmetrics.com):

```
Build:    Implement → (ask user → await reply →) PR Created
Review:   Evaluate → (request changes → Revise →) Approved → Merge
Deploy:   Await Deploy → Run Deploy → Deployed
Release:  Publish → Released
```

The full state machine is defined in [`graphs/issue.yaml`](graphs/issue.yaml) and can be inspected with `warp-coder verify`.

## Config

`warp-coder init` creates `.warp-coder/config.json`:

```json
{
  "board": {
    "provider": "github",
    "project": 1,
    "owner": "your-org",
    "columns": {
      "todo": "Todo",
      "inProgress": "In Progress",
      "inReview": "In Review",
      "deploy": "Deploy",
      "done": "Done",
      "blocked": "Blocked",
      "waiting": "Waiting"
    }
  },
  "hooks": {},
  "claude": {
    "maxTurns": 20
  },
  "pollInterval": 30,
  "maxRevisions": 3,
  "repos": [
    "git@github.com:your-org/your-repo.git"
  ]
}
```

Secrets go in `.env` at the project root:

```
WARP_CODER_WARPMETRICS_KEY=wm_...
WARP_CODER_GITHUB_TOKEN=ghp_...
WARP_CODER_REVIEW_TOKEN=ghp_...
WARP_CODER_TELEGRAM_BOT_TOKEN=...
```

### Multi-repo

Pass multiple URLs in `repos`. Each repo can have its own deploy command:

```json
{
  "repos": [
    { "url": "git@github.com:org/api.git", "deploy": "npm run deploy:prod" },
    { "url": "git@github.com:org/frontend.git", "deploy": "npm run deploy:prod" },
    { "url": "git@github.com:org/warp.git", "deploy": "npm run release:patch" }
  ]
}
```

When multiple issues touch the same repos, deploys are batched and ordered by dependency.

## CLI

```
warp-coder init                Set up config for a project
warp-coder watch               Start the poll loop
warp-coder release             Release shipped issues (packages + deploys)
warp-coder release --preview   Preview changelog entries without releasing
warp-coder debug [issue#]      Interactive state machine testing
warp-coder verify              Verify state machine graph consistency
warp-coder memory              Print current memory file
warp-coder compact             Force-rewrite memory file
```

## Lifecycle Hooks

| Hook | When | Use case |
|------|------|----------|
| `onBranchCreate` | After creating the implementation branch | Set up environment |
| `onBeforePush` | Before pushing (implement or revise) | Run tests/lint |
| `onPRCreated` | After opening a PR | Notify, add labels |
| `onBeforeMerge` | Before squash-merging | Final checks |
| `onMerged` | After merge completes | Deploy |

Hooks receive env vars: `ISSUE_NUMBER`, `PR_NUMBER`, `BRANCH`, `REPO`.

## Board Columns

The board state maps directly to the pipeline. Each outcome moves the card:

| Column | Outcomes |
|--------|----------|
| Todo | Started |
| In Progress | Building, Changes Requested, Clarified, Resumed |
| In Review | PR Created, Fixes Applied, Approved, Reviewing |
| Waiting | Needs Clarification, Waiting |
| Ready for Deploy | Merged, Awaiting Deploy |
| Deploy | Deploy Approved, Deployed, Releasing |
| Done | Released, Manual Release |
| Blocked | Implementation Failed, Revision Failed, Max Retries, Merge Failed, Review Failed, Deploy Failed, Release Failed, Aborted |

## Project Structure

```
bin/cli.js            CLI entrypoint
graphs/issue.yaml     State machine definition
src/
  graph/              State machine compiler, validator, names, constants
  agent/              Workspace setup, hooks, memory, reflection
  clients/            GitHub, WarpMetrics, notifications, git
  commands/           watch, debug, release
  executors/          implement, review, revise, merge, deploy, release, await_*
  workflows/          Executor registry, builtins
  runner.js           Core poll loop and act processing
  config.js           Config loader
  defaults.js         Named constants (timeouts, limits, concurrency)
```

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- A GitHub Projects v2 board with Status field

## License

MIT
