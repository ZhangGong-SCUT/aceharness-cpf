import { formatDiagnosisInputPrompt } from '@/lib/workflow/diagnosis-input';
import { classifyPrReviewInput, formatPrReviewInputPrompt } from '@/lib/workflow/pr-review-input';

export function formatGlobalContextPrompt(globalContext: string | null | undefined): string {
  const pr = classifyPrReviewInput(globalContext);
  if (pr.mode === 'pr' || pr.mode === 'event') {
    return formatPrReviewInputPrompt(globalContext);
  }
  return formatDiagnosisInputPrompt(globalContext);
}
