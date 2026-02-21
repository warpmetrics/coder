// Linear issue tracker — stub.
// Implement when Linear integration is ready.

export function create(opts) {
  return {
    getIssueBody(issueId) {
      throw new Error('Linear issue provider not yet implemented');
    },

    getIssueComments(issueId) {
      throw new Error('Linear issue provider not yet implemented');
    },

    commentOnIssue(issueId, { body }) {
      throw new Error('Linear issue provider not yet implemented');
    },

    addLabels(issueId, labels) {
      throw new Error('Linear issue provider not yet implemented');
    },
  };
}
