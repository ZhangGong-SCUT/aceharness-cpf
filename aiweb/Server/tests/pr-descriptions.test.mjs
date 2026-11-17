import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitType, descriptionRules, fallbackDescriptions, requestDescriptions,
} from '../prSubmit/descriptions.js';

const draft = {
  id: 'prd-test',
  title: 'fix(ohos): preserve the first orientation',
  body: 'fix(ohos): preserve the first orientation\n\nSigned-off-by: tester <test@example.com>',
  suggestedTarget: 'CPF-Flutter/flutter_engine',
  trackingBranch: 'oh-3.41.9-dev',
  files: [{ path: 'shell/platform/ohos/flutter_view.cpp', added: 12, removed: 2 }],
};

test('按 commit type 选择中文 Issue 模板，并保留规范要求的 PR 章节', () => {
  assert.equal(commitType(draft), 'fix');
  assert.equal(commitType({ title: '修复键盘', commits: [{ subject: '修复键盘' }] }), 'other', '没有 type 前缀时使用通用模板，不猜成 bug');
  assert.match(descriptionRules(draft), /复现步骤 \(Steps to Reproduce\)/);
  assert.match(descriptionRules(draft), /禁止编造日志/);
  assert.match(descriptionRules({ ...draft, title: 'feat: add API' }), /使用场景 \(Use Case\)/);
  const fallback = fallbackDescriptions(draft);
  assert.equal(fallback.source, 'template');
  assert.match(fallback.issue.body, /## 环境信息 \(Environment\)/);
  assert.match(fallback.pr.body, /## Why are these changes being made\?/);
  assert.match(fallback.pr.body, /No test execution was recorded/);
  assert.doesNotMatch(fallback.pr.body, /Signed-off-by/);
  assert.match(fallback.pr.body, /- \[ \] Compliant with the corresponding coding standards/);
});

test('真实 diff 进入模型请求，解析标题与正文并限制长度', async () => {
  const generated = {
    issue: { title: draft.title, body: '## 复现步骤 (Steps to Reproduce)\n\n尚未提供。' },
    pr: { title: draft.title, body: '## Changelog\n\nPreserve the first orientation.' },
  };
  let request;
  const result = await requestDescriptions({
    draft, diff: 'diff --git a/a.cpp b/a.cpp\n-old\n+new',
    endpoint: { baseURL: 'http://model.test/v1', apiKey: 'test-key', model: 'test-model' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(generated)}\n\`\`\`` } }] }) };
    },
  });
  assert.equal(request.url, 'http://model.test/v1/chat/completions');
  assert.equal(JSON.parse(request.options.body).model, 'test-model');
  assert.match(JSON.parse(request.options.body).messages[1].content, /\+new/);
  assert.match(JSON.parse(request.options.body).messages[0].content, /No test execution was recorded/);
  assert.equal(result.source, 'ai');
  assert.equal(result.issue.title, draft.title);
  assert.equal(result.pr.body, generated.pr.body);
});

test('完整生成的 PR 模板直接保留，仅追加目标分支关联的 Issue 编号', async () => {
  const { generatedPrBody } = await import('../../../scripts/pr-submit-plan.mjs');
  const body = '## Why are these changes being made?\n\nFix orientation.\n\n### Test Run Result Summary\n\nNo test execution was recorded.';
  assert.equal(generatedPrBody(body, '123'), `${body}\n\n#123`);
  assert.equal(generatedPrBody(body, ''), body);
  assert.equal(generatedPrBody('普通提交说明', '123'), '');
});

test('模型异常输出和缺少配置都不会产生虚构描述', async () => {
  await assert.rejects(() => requestDescriptions({ draft, diff: '', endpoint: null }), /未配置可用的 AI 模型/);
  await assert.rejects(() => requestDescriptions({
    draft, diff: '', endpoint: { baseURL: 'http://model.test', apiKey: 'key', model: 'model' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) }),
  }), /不是有效的 JSON/);
});
