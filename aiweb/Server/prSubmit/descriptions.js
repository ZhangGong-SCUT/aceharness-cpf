/**
 * 按 ohos-flutter-submit-code 的 Issue/PR 模板生成草稿。
 * 只使用草稿对应的 commit 和 diff；模型不可用时保留诚实的待补充项，不虚构复现或验证结果。
 */
import { loadModelEndpoint } from '../prReview/siblingSync.js';

export const DESCRIPTION_LIMITS = Object.freeze({ title: 200, issueBody: 20000, prBody: 20000 });

export function commitType(draft) {
  const subjects = [draft?.title, ...(draft?.commits || []).map(commit => commit?.subject)].filter(Boolean);
  const types = subjects.map(subject => String(subject).match(/^([a-z]+)(?:\([^)]+\))?:/i)?.[1].toLowerCase()).filter(Boolean);
  return types.length && types.every(type => type === types[0]) ? types[0] : 'other';
}

function issueSections(type) {
  if (type === 'fix') return ['复现步骤 (Steps to Reproduce)', '期望结果 (Expected Results)', '实际结果 (Actual Results)', '日志 (Logs)', '环境信息 (Environment)'];
  if (type === 'feat') return ['使用场景 (Use Case)', '提案 (Proposal)', '实现方案 (Implementation)', '环境信息 (Environment)'];
  if (type === 'perf') return ['复现步骤 (Steps to Reproduce)', '性能数据 (Performance Data)', '目标平台 (Target Platforms)', '环境信息 (Environment)'];
  if (type === 'docs') return ['文档链接 (Document Link)', '你要解决什么问题？(What Problem Does This Solve?)', '变更内容 (Changelog)', '环境信息 (Environment)'];
  if (type === 'chore') return ['你需要什么帮助 (What Do You Need)', '描述 (Description)', '环境信息 (Environment)'];
  return ['问题概述 (Problem Overview)', '变更内容 (Changelog)', '环境信息 (Environment)'];
}

function text(value, limit) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, limit);
}

import { draftDescriptionDiff } from './service.js';

/** 单草稿只生成一次，重复打开和并发点击共享同一份结果。 */
const inflight = new Map();

export async function generateDescriptions(draft, { request = requestDescriptions } = {}) {
  if (inflight.has(draft.id)) return inflight.get(draft.id);
  const task = (async () => {
    const { diff, truncated } = await draftDescriptionDiff(draft);
    try {
      const generated = await request({ draft, diff });
      return { ...generated, truncated };
    } catch (error) {
      return { ...fallbackDescriptions(draft), warning: `${error.message || 'AI 生成失败'}；已按规范生成基础草稿，请补充问题现象和实际验证结果。`, truncated };
    }
  })();
  inflight.set(draft.id, task);
  try { return await task; } finally { inflight.delete(draft.id); }
}

/** 模型失败时使用没有事实性断言的模板；标题仍沿用真实 commit。 */
export function fallbackDescriptions(draft) {
  const type = commitType(draft);
  const title = text(draft?.title || draft?.commits?.at(-1)?.subject, DESCRIPTION_LIMITS.title);
  const target = draft?.suggestedTarget || 'N/A';
  const branch = draft?.trackingBranch || draft?.headBranch || 'N/A';
  const files = (draft?.files || []).slice(0, 30).map(file => `- \`${file.path}\`（+${file.added || 0} / -${file.removed || 0}）`).join('\n') || '- N/A';
  const issue = [
    ...issueSections(type).flatMap(section => [`## ${section}`, '', section === '环境信息 (Environment)'
      ? `- Repo: ${target}\n- Branch: ${branch}\n- Framework: N/A`
      : section === '日志 (Logs)' ? '未提供。'
        : section.includes('复现步骤') ? '尚未从代码变更中确认具体复现路径。'
          : section.includes('期望结果') ? '修复后相关行为符合预期。'
            : section.includes('实际结果') ? '具体异常现象尚未提供。'
              : '请结合下方代码变更补充说明。', '']),
    '## 本次代码变更', '', files,
  ].join('\n');
  const pr = [
    '## Why are these changes being made?', '',
    `Apply the changes described by commit: ${title || 'N/A'}.`, '',
    '## Changelog', '', files, '',
    '## Test Plan', '',
    'Review the changed files and run the relevant tests before submitting.', '',
    '### Test Run Result Summary', '',
    'No test execution was recorded when this description was generated. Please run the relevant tests and update this section with the actual results.', '',
    '## Checklist',
    '- [ ] No illegal compatibility changes are involved; if any are, they have passed the corresponding review.',
    '- [ ] No performance issues are present or have been tested and there is no performance degradation.',
    '- [ ] Compliant with the corresponding coding standards.',
    '- [ ] No document updates are required, or the documents have been updated.',
    '- [ ] In terms of testability requirements, necessary self-test cases have been added.',
    '- [ ] No illegal file introductions exist, including images and code, etc.',
    '- [x] The branches that need to be merged have been confirmed.',
    `  - [x] ${branch}`,
  ].join('\n');
  return {
    title,
    issue: { title, body: issue },
    pr: { title, body: pr },
    source: 'template', warning: 'AI 内容生成暂不可用，已按规范生成基础草稿；请补充问题现象和实际验证结果。',
  };
}

function parseGenerated(raw) {
  const value = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('生成结果不是有效的 JSON');
  const result = JSON.parse(value.slice(start, end + 1));
  for (const key of ['issue', 'pr']) {
    if (!result[key] || !text(result[key].title, 1) || !text(result[key].body, 1)) throw new Error(`生成结果缺少 ${key} 标题或正文`);
  }
  return {
    title: text(result.pr.title, DESCRIPTION_LIMITS.title),
    issue: { title: text(result.issue.title, DESCRIPTION_LIMITS.title), body: text(result.issue.body, DESCRIPTION_LIMITS.issueBody) },
    pr: { title: text(result.pr.title, DESCRIPTION_LIMITS.title), body: text(result.pr.body, DESCRIPTION_LIMITS.prBody) },
    source: 'ai', warning: '',
  };
}

export function descriptionRules(draft) {
  const type = commitType(draft);
  const branch = draft?.trackingBranch || draft?.headBranch || 'N/A';
  const target = draft?.suggestedTarget || 'N/A';
  return `根据真实 commit 和 diff 生成 Issue 与 PR 草稿。仅输出 JSON：{"issue":{"title":"...","body":"..."},"pr":{"title":"...","body":"..."}}。两个标题都沿用草稿的 commit 标题（含 type 前缀）。Issue 正文用中文，PR 正文用英文。禁止把代码行为说成已复现的问题，禁止编造日志、Demo、环境版本、复现步骤或测试通过；没有这些信息时明确写尚未提供或尚未执行。不要写 Signed-off-by，不要引用 #数字。
Issue 类型为 ${type}，严格按以下章节顺序，环境为 Repo: ${target}、Branch: ${branch}、Framework: N/A：${issueSections(type).map(name => `## ${name}`).join('；')}。没有真实 Demo 时不要生成复现 Demo 或示例代码；没有日志时省略日志章节。
PR 必须依次包含：## Why are these changes being made?、## Changelog、## Test Plan、### Test Run Result Summary、## Checklist。Test Plan 给出建议执行的验证步骤；Test Run Result Summary 明确写 No test execution was recorded when this description was generated，不能声称测试已通过。Checklist 原样保留以下七项（除目标分支外不得把待确认项勾选为已完成）：\n- [ ] No illegal compatibility changes are involved; if any are, they have passed the corresponding review.\n- [ ] No performance issues are present or have been tested and there is no performance degradation.\n- [ ] Compliant with the corresponding coding standards.\n- [ ] No document updates are required, or the documents have been updated.\n- [ ] In terms of testability requirements, necessary self-test cases have been added.\n- [ ] No illegal file introductions exist, including images and code, etc.\n- [x] The branches that need to be merged have been confirmed.\n  - [x] ${branch}\n不要虚构提交规范之外的事实。`;
}

export async function requestDescriptions({ draft, diff, endpoint = loadModelEndpoint(), fetchImpl = fetch } = {}) {
  if (!endpoint?.baseURL || !endpoint?.apiKey || !endpoint?.model) throw new Error('未配置可用的 AI 模型');
  const response = await fetchImpl(`${endpoint.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${endpoint.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: endpoint.model, temperature: 0,
      messages: [
        { role: 'system', content: descriptionRules(draft) },
        { role: 'user', content: `草稿标题：${draft.title || ''}\n目标仓库：${draft.suggestedTarget || 'N/A'}\n目标分支：${draft.trackingBranch || 'N/A'}\ncommit 与提交说明：\n${String(draft.body || '').slice(0, 12000)}\n文件列表：\n${(draft.files || []).map(file => `${file.path} +${file.added || 0} -${file.removed || 0}`).join('\n')}\n真实 unified diff：\n${String(diff || '').slice(0, 100000)}` },
      ],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(String(payload?.error?.message || payload?.message || `AI 服务返回 HTTP ${response.status}`).slice(0, 200));
  return parseGenerated(payload?.choices?.[0]?.message?.content || '');
}
