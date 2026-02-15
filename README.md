# @warpmetrics/coder

Local agent loop that watches a GitHub Projects board for tasks, implements them using Claude Code, and pushes PRs.

## Quick Start

```bash
npx @warpmetrics/coder init
npx @warpmetrics/coder watch
```

## How It Works

```
Board: "Todo" column
  → warp-coder picks up the task
    → clones repo, creates branch, runs Claude Code
      → pushes branch, opens PR, moves to "In Review"
        → if review feedback arrives: applies fixes, pushes again
          → if approved: squash-merges, moves to "Done"
```

The agent polls your GitHub Projects board and processes tasks sequentially:

1. **Todo** — picks the first item, implements it, opens a PR
2. **In Review** — detects new review comments, applies feedback (up to 3 revisions)
3. **Approved** — squash-merges the PR, runs `onMerged` hook, moves to "Done"

Every step is instrumented with [WarpMetrics](https://warpmetrics.com) — you get runs, groups, and outcomes tracking the full pipeline.

## Config

`warp-coder init` creates `.warp-coder/config.json`:

```json
{
  "board": {
    "provider": "github-projects",
    "project": 1,
    "owner": "your-org",
    "columns": {
      "todo": "Todo",
      "inProgress": "In Progress",
      "inReview": "In Review",
      "done": "Done",
      "blocked": "Blocked"
    }
  },
  "hooks": {
    "onBeforePush": "npm test",
    "onMerged": "npm run deploy:prod"
  },
  "claude": {
    "allowedTools": "Bash,Read,Edit,Write,Glob,Grep",
    "maxTurns": 20
  },
  "pollInterval": 30,
  "maxRevisions": 3,
  "repo": "git@github.com:your-org/your-repo.git"
}
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

## Outcome Classifications

| Name | Classification |
|------|---------------|
| PR Created | success |
| Fixes Applied | success |
| Issue Understood | success |
| Needs Clarification | neutral |
| Needs Human | neutral |
| Implementation Failed | failure |
| Tests Failed | failure |
| Revision Failed | failure |
| Max Retries | failure |

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- A GitHub Projects v2 board with Status field

## License

MIT
