# @warpmetrics/coder

Agent pipeline for implementing GitHub issues with Claude Code. Label an issue with `agent` and it gets implemented, reviewed, and revised automatically.

## Quick Start

```bash
npx @warpmetrics/coder init
```

This will:
1. Set up `ANTHROPIC_API_KEY` and `WARPMETRICS_API_KEY` as GitHub secrets
2. Add two workflow files to `.github/workflows/`
3. Add pipeline scripts to `.github/scripts/`
4. Register outcome classifications with WarpMetrics

## How It Works

```
Issue labeled "agent"
  → agent-implement.yml runs Claude Code Action
    → Claude reads the issue, creates a branch, implements, opens PR
      → warp-review reviews the PR (if installed)
        → agent-revise.yml applies feedback and pushes fixes
          → Loop until approved or revision limit (3) reached
```

Every step is instrumented with [WarpMetrics](https://warpmetrics.com) — you get runs, groups, and outcomes tracking the full pipeline.

## Workflows

### agent-implement.yml

Triggered when an issue is labeled `agent`. Creates a branch `agent/issue-{number}`, implements the issue, and opens a PR.

### agent-revise.yml

Triggered when `github-actions[bot]` submits a review with comments (i.e., warp-review feedback). Applies the review feedback and pushes to the same branch. Stops after 3 revision attempts.

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

## Pairing with warp-review

For the full implement → review → revise loop, install [warp-review](https://github.com/warpmetrics/warp-review):

```bash
npx @warpmetrics/review init
```

## License

MIT
