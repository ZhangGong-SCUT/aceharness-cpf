export type OfficialFixRedactResult = {
  text: string;
  redacted: boolean;
  kinds: string[];
};

const PLACEHOLDER = '[已屏蔽：官方修复线索]';

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'pr-url', re: /https?:\/\/[^\s`'\"<>]+\/(?:pulls?|merge_requests)\/\d+[^\s`'\"<>]*/gi },
  { kind: 'pr-ref', re: /\bPR\s*[#!]?\s*\d+\b/gi },
  { kind: 'pull-ref', re: /\bpull\/\d+\b/gi },
  { kind: 'merged', re: /(?:代码)?已合入[^.。\n]{0,120}/g },
  { kind: 'fixed-by-pr', re: /已(?:由|在|通过)\s*PR[^.。\n]{0,120}/g },
  { kind: 'compare-pr', re: /对照(?:该|此|官方)?\s*PR[^\n]{0,80}/gi },
  { kind: 'git-apply-pr', re: /(?:git\s+apply|cherry-pick)[^\n]{0,160}(?:PR|官方|[a-f0-9]{7,})[^\n]{0,80}/gi },
  { kind: 'official-commit', re: /(?:套|对照)?官方(?:修复)?(?:\s*(?:PR|commit|提交))[^\n]{0,80}/gi },
  { kind: 'fix-equals-pr', re: /修复\s*=\s*PR[^\n]{0,160}/g },
];

export function redactOfficialFixLeak(input: string): OfficialFixRedactResult {
  let text = String(input || '');
  const kinds = new Set<string>();
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    text = text.replace(re, PLACEHOLDER);
    kinds.add(kind);
  }
  return {
    text,
    redacted: kinds.size > 0,
    kinds: [...kinds],
  };
}

export function shouldRedactOfficialFixForStep(stateName?: string, stepName?: string): boolean {
  const haystack = `${stateName || ''} ${stepName || ''}`;
  return /信息采集|Issue信息采集/.test(haystack);
}
