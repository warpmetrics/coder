// Linear board adapter.
// Uses Linear GraphQL API. Same interface as GitHub Projects adapter.

const API_URL = 'https://api.linear.app/graphql';

async function query(apiKey, q, variables = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query: q, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Linear API ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL: ${json.errors[0].message}`);
  }
  return json.data;
}

export function create({ teamKey, apiKey, columns = {} }) {
  if (!apiKey) throw new Error('Linear adapter requires "apiKey" in board config');
  if (!teamKey) throw new Error('Linear adapter requires "teamKey" in board config');

  const colNames = {
    todo: columns.todo || 'Todo',
    inProgress: columns.inProgress || 'In Progress',
    inReview: columns.inReview || 'In Review',
    readyForDeploy: columns.readyForDeploy || 'Ready for Deploy',
    deploy: columns.deploy || 'Deploy',
    done: columns.done || 'Done',
    blocked: columns.blocked || 'Blocked',
    waiting: columns.waiting || 'Waiting for Input',
    aborted: columns.aborted || 'Aborted',
  };

  let cachedIssues = [];
  let workflowStates = null; // name → id
  let teamId = null;

  async function resolveTeam() {
    if (teamId) return;
    const data = await query(apiKey, `
      query($key: String!) {
        teams(filter: { key: { eq: $key } }) {
          nodes { id key }
        }
      }
    `, { key: teamKey });
    const team = data.teams.nodes[0];
    if (!team) throw new Error(`Linear team with key "${teamKey}" not found`);
    teamId = team.id;
  }

  async function fetchWorkflowStates() {
    if (workflowStates) return;
    await resolveTeam();
    const data = await query(apiKey, `
      query($teamId: String!) {
        workflowStates(filter: { team: { id: { eq: $teamId } } }) {
          nodes { id name type }
        }
      }
    `, { teamId });
    workflowStates = {};
    for (const s of data.workflowStates.nodes) {
      workflowStates[s.name] = s.id;
    }
  }

  function getStateId(colKey) {
    const name = colNames[colKey];
    const id = workflowStates?.[name];
    if (!id) throw new Error(`Linear state "${name}" not found. Available: ${Object.keys(workflowStates || {}).join(', ')}`);
    return id;
  }

  function issuesByState(stateName) {
    return cachedIssues.filter(i => i._stateName === stateName);
  }

  function toItem(issue) {
    return {
      id: issue.id,
      _issueId: issue.identifier, // e.g. "FE-123"
      _stateName: issue.state?.name,
      content: {
        number: issue.identifier,
        title: issue.title,
        body: issue.description || '',
        type: 'Issue',
      },
    };
  }

  async function moveItem(item, colKey) {
    await fetchWorkflowStates();
    const stateId = getStateId(colKey);
    await query(apiKey, `
      mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
        }
      }
    `, { id: item.id, stateId });
  }

  return {
    async refresh() {
      await resolveTeam();
      await fetchWorkflowStates();

      // Paginate through all active issues (100 per page)
      const allIssues = [];
      let cursor = null;
      const PAGE_SIZE = 100;
      const MAX_PAGES = 10;

      for (let page = 0; page < MAX_PAGES; page++) {
        const vars = { teamId, first: PAGE_SIZE };
        if (cursor) vars.after = cursor;
        const data = await query(apiKey, `
          query($teamId: String!, $first: Int!, $after: String) {
            issues(
              filter: {
                team: { id: { eq: $teamId } }
                state: { type: { nin: ["canceled", "completed"] } }
              }
              first: $first
              after: $after
              orderBy: updatedAt
            ) {
              nodes {
                id
                identifier
                title
                description
                state { name }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `, vars);

        const nodes = data.issues.nodes || [];
        allIssues.push(...nodes);

        if (!data.issues.pageInfo?.hasNextPage) break;
        cursor = data.issues.pageInfo.endCursor;
      }

      cachedIssues = allIssues.map(toItem);
    },

    async listTodo() {
      return issuesByState(colNames.todo);
    },

    async listInProgress() {
      return issuesByState(colNames.inProgress);
    },

    async listInReview() {
      return issuesByState(colNames.inReview);
    },

    async listWaiting() {
      return issuesByState(colNames.waiting);
    },

    moveToTodo(item) { return moveItem(item, 'todo'); },
    moveToInProgress(item) { return moveItem(item, 'inProgress'); },
    moveToReview(item) { return moveItem(item, 'inReview'); },
    moveToReadyForDeploy(item) { return moveItem(item, 'readyForDeploy'); },
    moveToDeploy(item) { return moveItem(item, 'deploy'); },
    moveToBlocked(item) { return moveItem(item, 'blocked'); },
    moveToWaiting(item) { return moveItem(item, 'waiting'); },
    moveToDone(item) { return moveItem(item, 'done'); },

    async listReadyForDeploy() {
      return issuesByState(colNames.readyForDeploy);
    },

    async listDeploy() {
      return issuesByState(colNames.deploy);
    },

    async listBlocked() {
      return issuesByState(colNames.blocked);
    },

    async listDone() {
      return issuesByState(colNames.done);
    },

    async listAborted() {
      return issuesByState(colNames.aborted);
    },
  };
}
