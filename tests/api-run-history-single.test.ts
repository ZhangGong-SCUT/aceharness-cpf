import { beforeEach, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ summary: vi.fn(), history: vi.fn(), auth: vi.fn() }));
vi.mock('@/lib/auth/middleware', () => ({ requireAuth: mocks.auth }));
vi.mock('@/lib/run/summary-cache', () => ({ ensureRunSummaryCache: mocks.summary }));
vi.mock('@/lib/run/history', () => ({ readAllRunsSummary: mocks.history }));
vi.mock('@/lib/config/metadata', () => ({ getConfigMeta: vi.fn() }));
vi.mock('@/lib/core/user-store', () => ({ listUsers: vi.fn() }));
import { GET } from '@/app/api/run-history/route';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ id: 'me', role: 'user' });
  mocks.summary.mockResolvedValue({ runId: 'run-one', ownerId: 'me', configFile: 'gitcode-pr-review.yaml', tokenUsage: {} });
});
test('single run lookup never scans all runs', async () => {
  const response = await GET(new NextRequest('http://localhost/api/run-history?runId=run-one'));
  expect((await response.json()).runs[0].id).toBe('run-one');
  expect(mocks.history).not.toHaveBeenCalled();
});
test('does not expose another user run or allow traversal', async () => {
  mocks.auth.mockResolvedValue({ id: 'someone', role: 'user' });
  expect((await (await GET(new NextRequest('http://localhost/api/run-history?runId=run-one'))).json()).runs).toEqual([]);
  expect((await GET(new NextRequest('http://localhost/api/run-history?runId=../private'))).status).toBe(400);
});
