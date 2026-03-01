// GitHub Projects v2 board adapter.
// Manages issue workflow state only — PR concerns live in pr.js.
// Uses `gh` CLI for all API interactions.

import { execAsync } from '../exec.js';
import { TIMEOUTS } from '../../defaults.js';

async function gh(args) {
  try {
    const out = await execAsync('gh', args, { timeout: TIMEOUTS.GH });
    return out.trim();
  } catch (err) {
    const stderr = err.stderr?.toString().trim();
    const msg = stderr || err.message?.split('\n')[0] || 'gh command failed';
    throw new Error(msg);
  }
}

async function ghJson(args) {
  const out = await gh(args);
  if (!out) return null;
  try { return JSON.parse(out); } catch { throw new Error(`Failed to parse gh JSON output: ${out.slice(0, 200)}`); }
}

export function create({ project, owner, statusField = 'Status', columns = {} }) {
  const colNames = {
    todo: columns.todo || 'Todo',
    inProgress: columns.inProgress || 'In Progress',
    inReview: columns.inReview || 'In Review',
    readyForDeploy: columns.readyForDeploy || 'Ready for Deploy',
    deploy: columns.deploy || 'Deploy',
    done: columns.done || 'Done',
    blocked: columns.blocked || 'Blocked',
    waiting: columns.waiting || 'Waiting for Input',
    cancelled: columns.cancelled || 'Cancelled',
  };

  let projectNodeId = null;
  let fieldId = null;
  let optionIds = null;

  async function discoverProject() {
    if (projectNodeId) return;
    const projects = await ghJson(['project', 'list', '--owner', owner, '--format', 'json']);
    const proj = projects?.projects?.find(p => p.number === project);
    if (!proj) throw new Error(`Project #${project} not found for owner ${owner}`);
    projectNodeId = proj.id;
  }

  async function discoverField() {
    if (fieldId) return;
    await discoverProject();
    const fields = await ghJson(['project', 'field-list', String(project), '--owner', owner, '--format', 'json']);
    const field = fields?.fields?.find(f => f.name === statusField);
    if (!field) throw new Error(`Status field "${statusField}" not found in project ${project}`);
    fieldId = field.id;
    optionIds = {};
    for (const opt of field.options || []) {
      optionIds[opt.name] = opt.id;
    }
  }

  async function getOptionId(colKey) {
    await discoverField();
    const name = colNames[colKey];
    const id = optionIds[name];
    if (!id) throw new Error(`Column "${name}" not found. Available: ${Object.keys(optionIds).join(', ')}`);
    return id;
  }

  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;
  let cachedItems = null;

  async function fetchItemsPage(cursor) {
    await discoverProject();
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

  async function moveItem(item, colKey) {
    await discoverField();
    const optId = await getOptionId(colKey);
    await gh(['project', 'item-edit', '--id', item.id, '--project-id', projectNodeId, '--field-id', fieldId, '--single-select-option-id', optId]);
  }

  return {
    async refresh() {
      const items = [];
      let cursor = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await fetchItemsPage(cursor);
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

    async moveToTodo(item) { await moveItem(item, 'todo'); },
    async moveToInProgress(item) { await moveItem(item, 'inProgress'); },
    async moveToReview(item) { await moveItem(item, 'inReview'); },
    async moveToReadyForDeploy(item) { await moveItem(item, 'readyForDeploy'); },
    async moveToDeploy(item) { await moveItem(item, 'deploy'); },
    async moveToBlocked(item) { await moveItem(item, 'blocked'); },
    async moveToWaiting(item) { await moveItem(item, 'waiting'); },
    async moveToDone(item) { await moveItem(item, 'done'); },

    async listReadyForDeploy() {
      return enrichWithIssueId(getItemsByStatus(colNames.readyForDeploy));
    },

    async listDeploy() {
      return enrichWithIssueId(getItemsByStatus(colNames.deploy));
    },

    async listBlocked() {
      return enrichWithIssueId(getItemsByStatus(colNames.blocked));
    },

    async listDone() {
      return enrichWithIssueId(getItemsByStatus(colNames.done));
    },

    async listCancelled() {
      return enrichWithIssueId(getItemsByStatus(colNames.cancelled));
    },
    async moveToCancelled(item) { await moveItem(item, 'cancelled'); },
  };
}

// ---------------------------------------------------------------------------
// Field discovery for init wizard
// ---------------------------------------------------------------------------

export async function discoverProjectFields(project, owner) {
  const fields = await ghJson(['project', 'field-list', String(project), '--owner', owner, '--format', 'json']);
  return fields?.fields || [];
}
