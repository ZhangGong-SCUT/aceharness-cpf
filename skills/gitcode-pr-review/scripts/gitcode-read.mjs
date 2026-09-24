/** Bounded, read-only GitCode requests. Never include credentials or response bodies in errors. */
export async function gitcodeRead(path, token, { optional = false } = {}) {
  const root = process.env.GITCODE_API_ROOT || 'https://gitcode.com/api/v5';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${root}${path}`, {
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(12000),
      });
      if (optional && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`GitCode HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      const transient = !error.status || error.status === 429 || error.status >= 500;
      if (attempt === 0 && transient) {
        await new Promise(resolve => setTimeout(resolve, 300));
        continue;
      }
      const safe = new Error(error.status ? `GitCode HTTP ${error.status}` : 'GitCode 读取失败或超时');
      safe.status = error.status;
      throw safe;
    }
  }
}

export async function gitcodeReadPages(path, token, options = {}) {
  const items = [];
  // Never silently classify a partial history as complete. 5,000 comments is a
  // defensive bound, not a truncation policy; a full last page is an error.
  for (let page = 1; page <= 50; page++) {
    const batch = await gitcodeRead(`${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=100`, token, options);
    if (batch === null && options.optional) return items;
    if (!Array.isArray(batch)) throw new Error('GitCode 评论分页格式无效');
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error('GitCode 评论超过分页上限，不能用不完整数据判断门禁');
}
