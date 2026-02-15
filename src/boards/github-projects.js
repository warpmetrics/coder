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

  // Cache field/option IDs (discovered on first use)
  let fieldId = null;
  let optionIds = null;

  function discoverField() {
    if (fieldId) return;
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

  async function listItemsByStatus(statusName) {
    const items = ghJson(`project item-list ${project} --owner ${owner} --format json`);
    return (items?.items || []).filter(item => {
      const status = item.status || item.fields?.find(f => f.name === statusField)?.value;
      return status === statusName;
    });
  }

  async function moveItem(item, colKey) {
    discoverField();
    const optId = getOptionId(colKey);
    gh(`project item-edit --id ${item.id} --project-id ${item.projectId || project} --field-id ${fieldId} --single-select-option-id ${optId}`);
  }

  return {
    async listTodo() {
      return listItemsByStatus(colNames.todo);
    },

    async listInReview() {
      const items = await listItemsByStatus(colNames.inReview);
      // Filter to items that have new reviews
      const withReviews = [];
      for (const item of items) {
        if (!item.content?.number) continue;
        try {
          const reviews = ghJson(`api repos/${owner}/${item.content.repository}/pulls/${item.content.number}/reviews`);
          const hasNew = reviews?.some(r => r.state === 'COMMENTED' || r.state === 'CHANGES_REQUESTED');
          if (hasNew) withReviews.push(item);
        } catch {
          // Skip items we can't check
        }
      }
      return withReviews;
    },

    async listApproved() {
      const items = await listItemsByStatus(colNames.inReview);
      const approved = [];
      for (const item of items) {
        if (!item.content?.number) continue;
        try {
          const reviews = ghJson(`api repos/${owner}/${item.content.repository}/pulls/${item.content.number}/reviews`);
          const isApproved = reviews?.some(r => r.state === 'APPROVED');
          if (isApproved) approved.push(item);
        } catch {
          // Skip
        }
      }
      return approved;
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
