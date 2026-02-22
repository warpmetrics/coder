// Release workflow — build deploy plans from config + optional LLM dependency inference.

/**
 * Extract a JSON array from text that may contain markdown fences or surrounding text.
 */
export function extractJsonArray(text) {
  if (!text) return null;

  // Try parsing as-is first (clean response).
  try { return JSON.parse(text); } catch {}

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }

  // Find the outermost [...] with bracket-depth tracking.
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') { depth--; if (depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }}
  }
  return null;
}

/**
 * Validate and normalize a parsed deploy plan array.
 */
export function validateDeployPlan(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  if (!steps.every(s => s.repo && s.command)) return null;
  return {
    release: steps.map(s => ({ repo: s.repo, command: s.command, dependsOn: s.dependsOn || [] })),
  };
}

/**
 * Build a deploy plan from PRs + config.
 * Commands come from config.deploy, repos come from PRs.
 * For single-repo deploys, no dependencies needed.
 * For multi-repo, dependsOn can be provided externally (e.g. from LLM).
 *
 * @param {Array<{repo: string}>} prs - PRs with repo names (e.g. from createdPRs)
 * @param {Object} deployConfig - config.deploy mapping: { "org/repo": { command: "..." } }
 * @param {Array<{repo: string, dependsOn: string[]}>} [dependencies] - optional dependency info
 * @returns {{ release: Array<{repo, command, dependsOn}> }} or null
 */
export function buildDeployPlan(prs, deployConfig, dependencies) {
  if (!prs?.length || !deployConfig) return null;

  const repos = [...new Set(prs.map(p => p.repo))];
  const depsMap = new Map();
  if (dependencies) {
    for (const d of dependencies) {
      if (d.repo && Array.isArray(d.dependsOn)) {
        depsMap.set(d.repo, d.dependsOn);
      }
    }
  }

  const steps = [];
  for (const repo of repos) {
    const cfg = deployConfig[repo];
    if (!cfg?.command) continue;
    steps.push({
      repo,
      command: cfg.command,
      dependsOn: depsMap.get(repo) || [],
    });
  }

  return steps.length > 0 ? { release: steps } : null;
}

/**
 * Infer dependency order between repos by resuming a Claude session.
 * Only called when multiple repos are involved.
 *
 * @param {string} sessionId - Claude session ID to resume
 * @param {string[]} repos - repo names that need deploying
 * @param {string} workdir - Working directory for the Claude process
 * @param {{ model?: string, log?: function }} opts
 * @returns {Array<{repo: string, dependsOn: string[]}>} or null
 */
export async function inferDependencies(claudeCode, sessionId, repos, workdir, { log } = {}) {
  if (!sessionId || repos.length < 2) return null;

  const repoList = repos.map(r => `"${r}"`).join(', ');
  const prompt = `The following repos need to be deployed: ${repoList}

Based on the changes you just made, determine the deployment order. For each repo, list which other repos in this set must deploy first (dependsOn).

Respond with ONLY the raw JSON array, no markdown fences, no explanation:
[{"repo":"org/name","dependsOn":[]}]`;

  log?.(`  dependency inference: resuming session ${sessionId} for ${repos.length} repos`);

  for (let attempt = 0; attempt < 3; attempt++) {
    let result;
    try {
      result = await claudeCode.run({
        prompt, workdir, resume: sessionId,
        maxTurns: 5, verbose: false,
      });
    } catch (err) {
      log?.(`  dependency inference attempt ${attempt + 1}: claude call failed: ${err.message}`);
      if (attempt < 2) continue;
      return null;
    }

    try {
      const resultText = result.result;
      log?.(`  dependency inference attempt ${attempt + 1}: result=${resultText?.slice(0, 200)}`);
      const parsed = extractJsonArray(resultText);
      if (parsed && Array.isArray(parsed) && parsed.every(d => d.repo)) {
        // Filter to only repos in our set
        const repoSet = new Set(repos);
        return parsed
          .filter(d => repoSet.has(d.repo))
          .map(d => ({
            repo: d.repo,
            dependsOn: (d.dependsOn || []).filter(dep => repoSet.has(dep)),
          }));
      }
      log?.(`  dependency inference attempt ${attempt + 1}: invalid response`);
    } catch (err) {
      log?.(`  dependency inference attempt ${attempt + 1}: parse error: ${err.message}`);
    }
  }

  return null;
}

/**
 * Build a deploy plan: commands from config, dependencies from LLM (if multi-repo).
 *
 * @param {string} sessionId - Claude session ID to resume
 * @param {Array<{repo: string}>} prs - PRs with repo names
 * @param {Object} deployConfig - config.deploy mapping
 * @param {string} workdir - Working directory
 * @param {{ model?: string, log?: function }} opts
 * @returns {{ release: Array<{repo, command, dependsOn}> }} or null
 */
export async function inferDeployPlan(claudeCode, sessionId, prs, deployConfig, workdir, { log } = {}) {
  if (!prs?.length) {
    log?.('  deploy plan: no PRs');
    return null;
  }
  if (!deployConfig) {
    log?.('  deploy plan: no deploy config');
    return null;
  }

  const repos = [...new Set(prs.map(p => p.repo))].filter(r => deployConfig[r]?.command);
  if (repos.length === 0) {
    log?.('  deploy plan: no repos with deploy commands configured');
    return null;
  }

  // Single repo — no dependencies needed.
  if (repos.length === 1) {
    log?.(`  deploy plan: single repo ${repos[0]}`);
    return buildDeployPlan(prs, deployConfig);
  }

  // Multi-repo — infer dependencies via LLM.
  let dependencies = null;
  try {
    dependencies = await inferDependencies(claudeCode, sessionId, repos, workdir, { log });
  } catch (err) {
    log?.(`  deploy plan: dependency inference failed: ${err.message}`);
  }

  const plan = buildDeployPlan(prs, deployConfig, dependencies);
  if (plan) log?.(`  deploy plan: ${plan.release.map(s => `${s.repo}${s.dependsOn.length ? ` (after ${s.dependsOn.join(', ')})` : ''}`).join(', ')}`);
  return plan;
}
