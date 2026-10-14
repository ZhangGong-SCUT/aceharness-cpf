import { createHash } from 'node:crypto';
import { extractLooseStructuredResult, type LooseExtractionSource } from '@/lib/ai/result-channel';

/** Persisted once per step attempt, before display output is compacted. */
export interface StepResultRecord {
  version: 1;
  runId: string;
  attemptId: string;
  stepName: string;
  outputSha256: string;
  fields: Record<string, unknown>;
  sources: Record<string, LooseExtractionSource>;
  conflicts: string[];
  verdict: 'pass' | 'conditional_pass' | 'fail' | 'unknown';
}
export const outputDigest = (output: string) => createHash('sha256').update(output).digest('hex');
export function makeStepResultRecord(runId: string, attemptId: string, stepName: string, output: string): StepResultRecord {
  const result = extractLooseStructuredResult(output);
  const raw = result.fields.verdict;
  return { version: 1, runId, attemptId, stepName, outputSha256: outputDigest(output),
    fields: result.fields, sources: result.sources, conflicts: result.conflicts || [],
    verdict: result.conflicts?.length ? 'fail' : raw === 'pass' || raw === 'conditional_pass' || raw === 'fail' ? raw : 'unknown' };
}
export function validateStepResultRecord(value: any, runId: string, attemptId: string, output: string): value is StepResultRecord {
  if (value?.version !== 1 || value.runId !== runId || value.attemptId !== attemptId
    || value.outputSha256 !== outputDigest(output)) return false;
  const expected = makeStepResultRecord(runId, attemptId, value.stepName, output);
  return JSON.stringify(value.fields) === JSON.stringify(expected.fields)
    && JSON.stringify(value.conflicts) === JSON.stringify(expected.conflicts)
    && value.verdict === expected.verdict;
}
