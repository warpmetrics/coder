// Await deploy executor: waits for board item to be moved to Deploy column.

export const definition = {
  name: 'await_deploy',
  resultTypes: ['approved', 'waiting'],
  create() {
    return awaitDeploy;
  },
};

export async function awaitDeploy(run, ctx) {
  const { config, context: { actOpts, log } } = ctx;
  const deployColName = config.board?.columns?.deploy || 'Deploy';
  const currentCol = run.boardItem?.status || run.boardItem?._stateName;
  const fwd = { prs: actOpts?.prs, release: actOpts?.release };

  if (currentCol !== deployColName) {
    return { type: 'waiting', costUsd: null, trace: null, outcomeOpts: {}, nextActOpts: fwd };
  }

  log(`deploy approved (moved to ${deployColName})`);
  return { type: 'approved', costUsd: null, trace: null, outcomeOpts: {},
    nextActOpts: fwd };
}
