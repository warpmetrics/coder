// GitHub Projects v2 board adapter.
// Manages issue workflow state only — PR concerns live in pr.js.
// Uses `gh` CLI for all API interactions.

import { execFileSync } from 'child_process';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function ghJson(args) {
  const out = gh(args);
  return out ? JSON.parse(out) : null;
}

export function create({ project, owner, statusField = 'Status', columns = {} }) {
  const colNames = {
    todo: columns.todo || 'Todo',
    inProgress: columns.inProgress || 'In Progress',
    inReview: columns.inReview || 'In Review',
    done: columns.done || 'Done',
    blocked: columns.blocked || 'Blocked',
    waiting: columns.waiting || 'Waiting',
  };

  let projectNodeId = null;
  let fieldId = null;
  let optionIds = null;

  function discoverProject() {
    if (projectNodeId) return;
    const projects = ghJson(['project', 'list', '--owner', owner, '--format', 'json']);
    const proj = projects?.projects?.find(p => p.number === project);
    if (!proj) throw new Error(`Project #${project} not found for owner ${owner}`);
    projectNodeId = proj.id;
  }

  function discoverField() {
    if (fieldId) return;
    discoverProject();
    const fields = ghJson(['project', 'field-list', String(project), '--owner', owner, '--format', 'json']);
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

  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;
  let cachedItems = null;

  function fetchItemsPage(cursor) {
    discoverProject();
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `{
      node(id: "${projectNodeId}") {
        ... on ProjectV2 {
          items(first: ${PAGE_SIZE}${afterClause}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              fieldValueByName(name: "${statusField}") {
                ... on ProjectV2ItemFieldSingleSelectValue { name }
              }
              content {
                ... on Issue { number title body url repository { nameWithOwner } }
                ... on PullRequest { number title body url repository { nameWithOwner } }
                ... on DraftIssue { title body }
              }
            }
          }
        }
      }
    }`;
    return ghJson(['api', 'graphql', '-f', `query=${query}`]);
  }

  function normalizeNode(node) {
    if (!node) return null;
    return {
      id: node.id,
      status: node.fieldValueByName?.name || null,
      content: node.content ? {
        number: node.content.number,
        title: node.content.title,
        body: node.content.body,
        url: node.content.url,
        repository: node.content.repository?.nameWithOwner,
      } : null,
    };
  }

  function getItemsByStatus(statusName) {
    return (cachedItems || []).filter(item => item.status === statusName);
  }

  function enrichWithIssueId(items) {
    for (const item of items) {
      if (item.content?.number) {
        item._issueId = item.content.number;
      }
    }
    return items;
  }

  function moveItem(item, colKey) {
    discoverField();
    const optId = getOptionId(colKey);
    gh(['project', 'item-edit', '--id', item.id, '--project-id', projectNodeId, '--field-id', fieldId, '--single-select-option-id', optId]);
  }

  return {
    async refresh() {
      const items = [];
      let cursor = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = fetchItemsPage(cursor);
        const connection = result?.data?.node?.items;
        if (!connection) break;
        for (const node of connection.nodes) {
          const item = normalizeNode(node);
          if (item) items.push(item);
        }
        if (!connection.pageInfo.hasNextPage) break;
        cursor = connection.pageInfo.endCursor;
      }
      cachedItems = items;
    },

    async listTodo() {
      return enrichWithIssueId(getItemsByStatus(colNames.todo));
    },

    async listInProgress() {
      return enrichWithIssueId(getItemsByStatus(colNames.inProgress));
    },

    async listInReview() {
      return enrichWithIssueId(getItemsByStatus(colNames.inReview));
    },

    async listWaiting() {
      return enrichWithIssueId(getItemsByStatus(colNames.waiting));
    },

    moveToTodo(item) { return moveItem(item, 'todo'); },
    moveToInProgress(item) { return moveItem(item, 'inProgress'); },
    moveToReview(item) { return moveItem(item, 'inReview'); },
    moveToBlocked(item) { return moveItem(item, 'blocked'); },
    moveToWaiting(item) { return moveItem(item, 'waiting'); },
    moveToDone(item) { return moveItem(item, 'done'); },

    async listDone() {
      return enrichWithIssueId(getItemsByStatus(colNames.done));
    },
  };
}

// ---------------------------------------------------------------------------
// Field discovery for init wizard
// ---------------------------------------------------------------------------

export function discoverProjectFields(project, owner) {
  const fields = ghJson(['project', 'field-list', String(project), '--owner', owner, '--format', 'json']);
  return fields?.fields || [];
}
