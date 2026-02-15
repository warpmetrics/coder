// GitHub Projects v2 board adapter.
// Uses `gh` CLI for all API interactions.

import { execSync } from 'child_process';

function gh(args, opts = {}) {
  return execSync(`gh ${args}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

function ghJson(args, opts = {}) {
  const out = gh(args, opts);
  return out ? JSON.parse(out) : null;
}

export function create({ project, owner, statusField = 'Status', columns = {} }) {
  const colNames = {
    todo: columns.todo || 'Todo',
    inProgress: columns.inProgress || 'In Progress',
    inReview: columns.inReview || 'In Review',
    done: columns.done || 'Done',
    blocked: columns.blocked || 'Blocked',
  };

  // PR lookup cache (issue number → PR number or null). Persists across polls.
  const prCache = new Map();

  // Find the PR linked to an issue item (via "Closes #N" convention)
  function findLinkedPR(item) {
    // If the item is already a PR, use its number directly
    if (item.content?.type === 'PullRequest') return item.content.number;
    // Otherwise look for a linked PR via the branch naming convention
    const issueNumber = item.content?.number;
    if (!issueNumber) return null;
    if (prCache.has(issueNumber)) return prCache.get(issueNumber);
    let result = null;
    try {
      const repo = item.content.repository || `${owner}/${item.content.repository}`;
      // Search for PRs that reference this issue
      const prs = ghJson(`api repos/${repo}/pulls?state=open&head=agent/issue-${issueNumber} --jq '.[0].number'`);
      if (prs && typeof prs === 'number') result = prs;
    } catch {}
    if (!result) {
      try {
        // Fallback: search via gh pr list
        const repo = item.content.repository;
        const out = gh(`pr list --repo ${repo} --search "Closes #${issueNumber}" --json number --jq '.[0].number'`);
        if (out) result = parseInt(out, 10);
      } catch {}
    }
    prCache.set(issueNumber, result);
    return result;
  }

  // Cache field/option IDs and project node ID (discovered on first use)
  let projectNodeId = null;
  let fieldId = null;
  let optionIds = null;

  function discoverProject() {
    if (projectNodeId) return;
    const projects = ghJson(`project list --owner ${owner} --format json`);
    const proj = projects?.projects?.find(p => p.number === project);
    if (!proj) throw new Error(`Project #${project} not found for owner ${owner}`);
    projectNodeId = proj.id;
  }

  function discoverField() {
    if (fieldId) return;
    discoverProject();
    const fields = ghJson(`project field-list ${project} --owner ${owner} --format json`);
    const field = fields?.fields?.find(f => f.name === statusField);
    if (!field) throw new Error(`Status field "${statusField}" not found in project ${project}`);
    fieldId = field.id;
    optionIds = {};
    for (const opt of field.options || []) {
      optionIds[opt.name] = opt.id;
    }
  }

  function getOptionId(colKey) {
    discoverField();
    const name = colNames[colKey];
    const id = optionIds[name];
    if (!id) throw new Error(`Column "${name}" not found. Available: ${Object.keys(optionIds).join(', ')}`);
    return id;
  }

  // Cached item list — refreshed once per poll cycle via refresh()
  let cachedItems = null;
  let cachedReviewClassification = null;

  function getItemsByStatus(statusName) {
    return (cachedItems?.items || []).filter(item => {
      const status = item.status || item.fields?.find(f => f.name === statusField)?.value;
      return status === statusName;
    });
  }

  // Classify "In Review" items in a single pass — one review API call per item.
  // Result is cached per poll cycle so listInReview + listApproved share one pass.
  function classifyInReview() {
    if (cachedReviewClassification) return cachedReviewClassification;
    const items = getItemsByStatus(colNames.inReview);
    const needsRevision = [];
    const approved = [];
    for (const item of items) {
      if (!item.content?.number) continue;
      try {
        const prNumber = findLinkedPR(item);
        if (!prNumber) continue;
        const repo = item.content.repository || `${owner}/${item.content.repository}`;
        const reviews = ghJson(`api repos/${repo}/pulls/${prNumber}/reviews`);
        item._prNumber = prNumber;
        if (reviews?.some(r => r.state === 'APPROVED')) {
          approved.push(item);
        } else if (reviews?.some(r => r.state === 'COMMENTED' || r.state === 'CHANGES_REQUESTED')) {
          needsRevision.push(item);
        }
      } catch {
        // Skip items we can't check
      }
    }
    cachedReviewClassification = { needsRevision, approved };
    return cachedReviewClassification;
  }

  async function moveItem(item, colKey) {
    discoverField();
    const optId = getOptionId(colKey);
    gh(`project item-edit --id ${item.id} --project-id ${projectNodeId} --field-id ${fieldId} --single-select-option-id ${optId}`);
  }

  return {
    refresh() {
      cachedItems = ghJson(`project item-list ${project} --owner ${owner} --format json`);
      cachedReviewClassification = null;
    },

    async listTodo() {
      return getItemsByStatus(colNames.todo);
    },

    async listInReview() {
      return classifyInReview().needsRevision;
    },

    async listApproved() {
      return classifyInReview().approved;
    },

    moveToInProgress(item) { return moveItem(item, 'inProgress'); },
    moveToReview(item) { return moveItem(item, 'inReview'); },
    moveToBlocked(item) { return moveItem(item, 'blocked'); },
    moveToDone(item) { return moveItem(item, 'done'); },
  };
}

// ---------------------------------------------------------------------------
// Field discovery for init wizard
// ---------------------------------------------------------------------------

export function discoverProjectFields(project, owner) {
  const fields = ghJson(`project field-list ${project} --owner ${owner} --format json`);
  return fields?.fields || [];
}
