/** A persisted approval is intentionally idle; no child PID is expected. */
export function isPersistedHumanWait(state: {
  currentState?: string | null; currentPhase?: string | null;
  pendingHumanQuestionId?: string | null;
  humanQuestions?: Array<{ id: string; status: string }>;
}): boolean {
  return (state.currentState || state.currentPhase) === '__human_approval__'
    && !!state.pendingHumanQuestionId
    && !!state.humanQuestions?.some(q => q.id === state.pendingHumanQuestionId && q.status === 'unanswered');
}

/** Replace the previous event snapshot. Keep user instructions in the base context. */
export function mergePrEventContext(current: string, incoming: string): string {
  const base = current.split(/\n+(?:--- webhook ---|<!-- pr-event:start -->)/)[0].trimEnd();
  return `${base}\n\n<!-- pr-event:start -->\n${incoming.slice(0, 16000)}\n<!-- pr-event:end -->`;
}
