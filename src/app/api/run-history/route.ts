import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import {
  applyConfigNamesToRuns,
  buildTokenRankingsForRuns,
  attachRunHistoryTree,
  type HistoryView,
  paginateRuns,
  readAccessibleConfigNameMap,
  readAllRunsSummary,
  sortRuns,
  sortTokenRankings,
  type RunSortKey,
  type SortDirection,
  type TokenRankingDimension,
  type TokenRankingSortKey,
} from '@/lib/run/history';
import { ensureRunSummaryCache } from '@/lib/run/summary-cache';
import { getConfigMeta } from '@/lib/config/metadata';
import { listUsers } from '@/lib/core/user-store';

export const dynamic = 'force-dynamic';

function readPositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readView(value: string | null): HistoryView {
  return value === 'token-ranking' ? 'token-ranking' : 'runs';
}

function readRunSortKey(value: string | null): RunSortKey {
  if (value === 'name' || value === 'totalTokens' || value === 'cost') return value;
  return 'startTime';
}

function readTokenRankingSortKey(value: string | null): TokenRankingSortKey {
  if (value === 'name' || value === 'runs' || value === 'cost') return value;
  return 'totalTokens';
}

function readSortDirection(value: string | null): SortDirection {
  return value === 'asc' ? 'asc' : 'desc';
}

function readTokenRankingDimension(value: string | null): TokenRankingDimension {
  return value === 'user' ? 'user' : 'workflow';
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const page = readPositiveInt(searchParams.get('page'), 1);
    const pageSize = Math.min(readPositiveInt(searchParams.get('pageSize'), 20), 100);
    const view = readView(searchParams.get('view'));
    const sortDirection = readSortDirection(searchParams.get('sortDirection'));
    const ownerId = searchParams.get('ownerId')?.trim() || '';
    const requestedRunId = searchParams.get('runId')?.trim() || '';
    const keyword = searchParams.get('keyword')?.trim().toLowerCase() || '';
    const dimension = readTokenRankingDimension(searchParams.get('dimension'));

    // A card's ownership check must not enumerate every run, config and user.
    if (requestedRunId && view === 'runs') {
      if (!/^run-[A-Za-z0-9-]+$/.test(requestedRunId)) return NextResponse.json({ error: '无效 runId' }, { status: 400 });
      const summary = await ensureRunSummaryCache(requestedRunId);
      const meta = summary && !summary.ownerId ? await getConfigMeta(summary.configFile) : null;
      const summaryOwner = summary?.ownerId || meta?.createdBy;
      const accessible = summary && (auth.role === 'admin' || summaryOwner === auth.id);
      const matches = accessible && (!keyword || `${summary.configName} ${summary.configFile}`.toLowerCase().includes(keyword))
        && (auth.role !== 'admin' || !ownerId || ownerId === 'all' || summaryOwner === ownerId);
      const runs = matches && page === 1 ? [{ ...summary, id: summary.runId, ownerId: summaryOwner, ...summary.tokenUsage }] : [];
      return NextResponse.json({ view, runs, pagination: { total: matches ? 1 : 0, totalPages: 1, page, pageSize }, filters: { runId: requestedRunId } });
    }

    const [configNameMap, runsResult, users] = await Promise.all([
      readAccessibleConfigNameMap(auth.id, auth.role),
      readAllRunsSummary(),
      auth.role === 'admin' ? listUsers() : Promise.resolve([]),
    ]);

    let runs = applyConfigNamesToRuns(runsResult.runs, configNameMap, auth.role);
    if (auth.role !== 'admin') {
      runs = runs.filter((run) => !run.ownerId || run.ownerId === auth.id);
    }

    if (auth.role === 'admin' && ownerId && ownerId !== 'all') {
      runs = runs.filter((run) => run.ownerId === ownerId);
    }

    if (requestedRunId) {
      runs = runs.filter((run) => run.id === requestedRunId);
    }

    if (keyword) {
      runs = runs.filter((run) => {
        const name = `${run.configName} ${run.configFile}`.toLowerCase();
        return name.includes(keyword);
      });
    }

    if (view === 'token-ranking') {
      const sortKey = readTokenRankingSortKey(searchParams.get('sortKey'));
      const rankings = buildTokenRankingsForRuns(runs);
      const selectedRankings = dimension === 'user'
        ? rankings.tokenRankingByUser
        : rankings.tokenRankingByWorkflow;
      const paged = paginateRuns(sortTokenRankings(selectedRankings, sortKey, sortDirection), page, pageSize);

      return NextResponse.json({
        view,
        rankings: paged.items,
        pagination: {
          total: paged.total,
          totalPages: paged.totalPages,
          page: paged.page,
          pageSize: paged.pageSize,
        },
        filters: {
          view,
          dimension,
          sortKey,
          sortDirection,
          ownerId: auth.role === 'admin' ? ownerId || 'all' : 'all',
          runId: requestedRunId || '',
          keyword,
        },
        userOptions: auth.role === 'admin'
          ? users.map((user) => ({ id: user.id, username: user.username }))
          : [],
        isAdmin: auth.role === 'admin',
      });
    }

    const sortKey = readRunSortKey(searchParams.get('sortKey'));
    const tree = searchParams.get('tree') === '1';
    runs = sortRuns(runs, sortKey, sortDirection);
    const responseRuns = tree ? attachRunHistoryTree(runs) : runs;
    const paged = paginateRuns(responseRuns, page, pageSize);

    return NextResponse.json({
      view,
      runs: paged.items,
      tree,
      pagination: {
        total: paged.total,
        totalPages: paged.totalPages,
        page: paged.page,
        pageSize: paged.pageSize,
      },
      filters: {
        view,
        dimension,
        sortKey,
        sortDirection,
        ownerId: auth.role === 'admin' ? ownerId || 'all' : 'all',
        runId: requestedRunId || '',
        keyword,
      },
      userOptions: auth.role === 'admin'
        ? users.map((user) => ({ id: user.id, username: user.username }))
        : [],
      isAdmin: auth.role === 'admin',
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: '运行记录加载失败', message: error?.message || 'unknown error' },
      { status: 500 }
    );
  }
}
