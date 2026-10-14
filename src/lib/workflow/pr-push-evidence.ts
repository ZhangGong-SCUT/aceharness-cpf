/** A read timestamp is never the start of a write operation. */
export function evaluatePrPushEvidence(push: any, comment: any, gate: any, noLocalChanges = false) {
  const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v);
  const success = push?.push_status === 'success' && sha(push.commit_sha)
    && push.commit_sha === push.remote_head_sha;
  const noPush = push?.push_status === 'not_attempted' && noLocalChanges;
  const buildRequired = success || gate?.phase === 'need_start_build';
  // For a build without a push, the caller must record its immutable attempt time.
  const since = Date.parse(success ? push.pushed_at : push?.attempted_at);
  const posted = Date.parse(comment?.posted_at);
  const receipt = comment?.ok === true && comment.body?.trim() === 'start build'
    && comment.endpoint === 'pulls' && !!comment.comment_id && Number.isFinite(posted);
  const buildPosted = receipt && Number.isFinite(since) && posted >= since
    && (!comment.commit_sha || comment.commit_sha === push?.commit_sha);
  // The gate snapshot is captured before the fix commit is pushed, so its head differs
  // from the pushed commit by design. Only a snapshot checked after our own push can
  // prove the PR head moved away from the commit we pushed.
  const checkedAt = Date.parse(gate?.checked_at), pushedAt = Date.parse(push?.pushed_at);
  const gateAfterPush = Number.isFinite(checkedAt) && Number.isFinite(pushedAt) && checkedAt >= pushedAt;
  const headMatches = !success || !gate?.head_sha || !gateAfterPush || gate.head_sha === push.commit_sha;
  const verified = (success || noPush) && headMatches && (!buildRequired || buildPosted);
  const reason = !success && !noPush ? 'push_unverified' : !headMatches ? 'head_changed'
    : buildRequired && !buildPosted ? 'build_receipt_unverified' : null;
  return { success, verified, buildPosted, reason,
    // Preserve observed facts even if another part of the audit fails.
    buildCommentId: receipt ? String(comment.comment_id) : null };
}
