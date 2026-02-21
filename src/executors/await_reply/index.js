// Await reply executor: waits for user to reply to a clarification question.

export const definition = {
  name: 'await_reply',
  resultTypes: ['replied', 'waiting'],
  create() {
    return awaitReply;
  },
};

export async function awaitReply(run, ctx) {
  const { clients: { issues }, config, context: { actOpts, log } } = ctx;
  const primaryRepo = config.repoNames[0];
  let comments;
  try { comments = issues.getIssueComments(run.issueId, { repo: primaryRepo }); } catch { return { type: 'waiting', costUsd: null, trace: null, outcomeOpts: {}, nextActOpts: { sessionId: actOpts?.sessionId } }; }

  const lastQuestionIdx = comments.findLastIndex(c => c.body?.includes('<!-- warp-coder:question'));
  if (lastQuestionIdx === -1 || lastQuestionIdx === comments.length - 1) {
    return { type: 'waiting', costUsd: null, trace: null, outcomeOpts: {}, nextActOpts: { sessionId: actOpts?.sessionId } };
  }

  log(`user replied to clarification question`);
  return { type: 'replied', costUsd: null, trace: null, outcomeOpts: {}, nextActOpts: { sessionId: actOpts?.sessionId } };
}
