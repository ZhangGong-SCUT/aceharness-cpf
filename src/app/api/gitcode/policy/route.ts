import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { loadPrReviewPolicies, resolvePrReviewPolicy } from '@/lib/workflow/pr-review-policy';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const owner = String(request.nextUrl.searchParams.get('owner') || '').trim();
  const repo = String(request.nextUrl.searchParams.get('repo') || '').trim();
  const branch = String(request.nextUrl.searchParams.get('branch') || '').trim();
  const { config, version } = loadPrReviewPolicies();
  if (!owner || !repo) {
    return NextResponse.json({ version, defaults: config.defaults || {}, repos: config.repos || [] });
  }
  const resolved = resolvePrReviewPolicy(config, { owner, repo, branch });
  return NextResponse.json({ owner, repo, branch, version: resolved.version, policy: resolved.policy, scope: resolved.scope });
}
