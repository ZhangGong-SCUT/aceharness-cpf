import test from 'node:test';
import assert from 'node:assert/strict';
import { listGitcodeOrgPrs } from '../prReview/client.js';

function orgItem(number, extra = {}) {
  return {
    number,
    title: `PR ${number}`,
    state: 'open',
    base: { repo: { full_path: 'CPF-Flutter/flutter_flutter', path: 'flutter_flutter' } },
    ...extra,
  };
}

function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const { status = 200, body } = handler(String(url));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('按作者查询时，组织列表缺作者字段也保留本人 PR，不逐条读详情', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.includes('/org/CPF-Flutter/pull_requests')) return { body: [orgItem(2279), orgItem(2244)] };
    return { status: 429, body: { message: '429 The number of times the user invokes this API is too large' } };
  });
  try {
    const data = await listGitcodeOrgPrs({ state: 'open', author: 'Alice' });
    assert.deepEqual(data.prs.map((p) => [p.number, p.author]), [[2279, 'Alice'], [2244, 'Alice']]);
    assert.equal(fetchMock.calls.filter((url) => url.includes('/pulls/')).length, 0, '标题齐全时不再请求详情');
    assert.match(fetchMock.calls[0], /author=Alice/);
  } finally {
    fetchMock.restore();
  }
});

test('按作者查询时，列表给出的作者以列表为准', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.includes('/org/CPF-Flutter/pull_requests')) return { body: [orgItem(1, { user: { login: 'alice' } })] };
    return { status: 404, body: {} };
  });
  try {
    const data = await listGitcodeOrgPrs({ state: 'all', author: 'Alice' });
    assert.equal(data.prs[0].author, 'alice');
  } finally {
    fetchMock.restore();
  }
});

test('不按作者查询时，缺作者仍然读详情补齐，详情失败就留空', async () => {
  const fetchMock = mockFetch((url) => {
    if (url.includes('/org/CPF-Flutter/pull_requests')) return { body: [orgItem(7), orgItem(8)] };
    if (url.endsWith('/pulls/7')) return { body: { ...orgItem(7), user: { login: 'bob' } } };
    return { status: 404, body: {} };
  });
  try {
    const data = await listGitcodeOrgPrs({ state: 'all' });
    assert.deepEqual(data.prs.map((p) => [p.number, p.author]), [[7, 'bob'], [8, '']]);
    assert.equal(fetchMock.calls.filter((url) => url.includes('/pulls/')).length, 2);
  } finally {
    fetchMock.restore();
  }
});
