// Pure release planning functions — no side effects.

/**
 * Merge release plans from multiple issues into a single plan.
 * Each plan has a `release` array: [{ repo, command, dependsOn }]
 */
export function mergeDAGs(plans) {
  const allSteps = new Map(); // repo → step info (merged)
  const dag = {};
  const issuesByRepo = new Map(); // repo → Set of issue numbers

  for (const plan of plans) {
    const issueNum = plan.issue?.opts?.issue ?? plan.issueId;

    for (const step of (plan.release || [])) {
      if (!allSteps.has(step.repo)) {
        allSteps.set(step.repo, { ...step });
        dag[step.repo] = [];
        issuesByRepo.set(step.repo, new Set());
      }
      if (issueNum) issuesByRepo.get(step.repo).add(issueNum);

      for (const dep of (step.dependsOn || [])) {
        if (!dag[step.repo].includes(dep)) {
          dag[step.repo].push(dep);
        }
      }
    }
  }

  return { steps: allSteps, dag, issuesByRepo };
}

/**
 * Compute parallel execution levels from a topological order.
 */
export function computeLevels(ordered, dag) {
  const levels = new Map();
  for (const repo of ordered) {
    const deps = (dag[repo] || []).filter(d => levels.has(d));
    const maxDepLevel = deps.length > 0 ? Math.max(...deps.map(d => levels.get(d))) : -1;
    levels.set(repo, maxDepLevel + 1);
  }
  return levels;
}

/**
 * Build ordered step list from topoSort output and merged plan.
 */
export function buildSteps(ordered, merged) {
  const steps = [];
  const levels = computeLevels(ordered, merged.dag);

  for (const repo of ordered) {
    const info = merged.steps.get(repo);
    const issues = merged.issuesByRepo.get(repo);
    const level = levels.get(repo);

    steps.push({
      repo,
      command: info?.command,
      issues: issues ? [...issues] : [],
      level,
      dependsOn: (merged.dag[repo] || []).filter(d => merged.steps.has(d)),
    });
  }

  return steps;
}

/**
 * Compute a deploy batch by transitive repo overlap.
 * Returns { issueIds, issues } or null if trigger issue not found.
 */
export function computeDeployBatch(triggerIssueId, awaitingIssues) {
  const trigger = awaitingIssues.find(i => i.issueId === triggerIssueId);
  if (!trigger) return null;

  const batch = new Map(); // issueId → issue
  batch.set(trigger.issueId, trigger);

  const repos = new Set((trigger.release || []).map(s => s.repo));

  // Fixed-point loop: expand batch by repo overlap (capped to prevent runaway)
  let changed = true;
  let iterations = 0;
  const maxIterations = awaitingIssues.length + 1;
  while (changed && iterations++ < maxIterations) {
    changed = false;
    for (const issue of awaitingIssues) {
      if (batch.has(issue.issueId)) continue;
      const issueRepos = (issue.release || []).map(s => s.repo);
      if (issueRepos.some(r => repos.has(r))) {
        batch.set(issue.issueId, issue);
        for (const r of issueRepos) repos.add(r);
        changed = true;
      }
    }
  }

  return {
    issueIds: [...batch.keys()],
    issues: [...batch.values()],
  };
}

/**
 * Topological sort of a DAG. Returns null if cyclic.
 */
export function topoSort(dag) {
  const nodes = Object.keys(dag);
  const visited = new Set();
  const visiting = new Set();
  const order = [];

  function visit(node) {
    if (visited.has(node)) return true;
    if (visiting.has(node)) return false;
    visiting.add(node);
    for (const dep of (dag[node] || [])) {
      if (nodes.includes(dep) && !visit(dep)) return false;
    }
    visiting.delete(node);
    visited.add(node);
    order.push(node);
    return true;
  }

  for (const node of nodes) {
    if (!visit(node)) return null;
  }

  return order;
}
