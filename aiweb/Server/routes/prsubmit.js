/**
 * PR 提交草稿。命令只写草稿；这里负责展示、选仓库/分支，并在确认后创建 Issue 和 PR。
 */
import { Router } from 'express';
import { getGitcodeTokenValues, getUserByToken, listGitcodeOrgRepos } from '../prReview/client.js';
import {
  draftFileDiff, listBranches, portCheck, previewBase, searchIssues, submitDraft, verifyPort,
} from '../prSubmit/service.js';
import { generateDescriptions } from '../prSubmit/descriptions.js';
import { isDraftId, listDrafts, readDraft, writeDraft } from '../prSubmit/store.js';
import { forkRemote, isSafeRef, validateSubmitRequest } from '../../../scripts/pr-submit-plan.mjs';

const inflight = new Set();
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function tokenOf(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

async function requireUser(req, res) {
  const token = tokenOf(req);
  if (!token) {
    res.status(401).json({ success: false, message: '未登录' });
    return null;
  }
  const user = await getUserByToken(token);
  if (!user) {
    res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
    return null;
  }
  return { token, user };
}

export function createPrSubmitRouter() {
  const router = Router();

  router.get('/pr-submit/drafts', async (req, res) => {
    try {
      if (!await requireUser(req, res)) return;
      res.json({ success: true, drafts: await listDrafts(100) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  router.get('/pr-submit/drafts/:id/diff', async (req, res) => {
    try {
      if (!await requireUser(req, res)) return;
      if (!isDraftId(req.params.id)) return res.status(400).json({ success: false, message: '草稿编号无效' });
      const draft = await readDraft(req.params.id);
      if (!draft) return res.status(404).json({ success: false, message: '草稿不存在，请在仓库里重新运行 ace pr' });
      const path = String(req.query.path || '');
      if (!(draft.files || []).some((item) => item.path === path)) {
        return res.status(400).json({ success: false, message: '这个文件不在本次改动里' });
      }
      res.json({ success: true, ...await draftFileDiff(draft, path) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  router.post('/pr-submit/drafts/:id/preview', async (req, res) => {
    const id = req.params.id;
    const base = String(req.body?.base || '').trim();
    const key = `${id}:preview:${base}`;
    let locked = false;
    try {
      const auth = await requireUser(req, res);
      if (!auth) return;
      if (!isDraftId(id)) return res.status(400).json({ success: false, message: '草稿编号无效' });
      const repo = String(req.body?.repo || '').trim();
      if (!REPO_RE.test(repo)) return res.status(400).json({ success: false, message: '目标仓库格式应为 owner/repo' });
      if (!isSafeRef(base)) return res.status(400).json({ success: false, message: '目标分支不合法' });
      const draft = await readDraft(id);
      if (!draft) return res.status(404).json({ success: false, message: '草稿不存在，请在仓库里重新运行 ace pr' });
      if (base === draft.trackingBranch) return res.status(400).json({ success: false, message: '这是草稿自己的基准分支，不需要预演' });
      if (inflight.has(id) || inflight.has(key)) return res.status(409).json({ success: false, message: '正在处理，请稍候' });
      const credentials = await getGitcodeTokenValues(auth.token);
      const credential = credentials.find((item) => item.value);
      if (!credential) return res.status(400).json({ success: false, message: '请先在 PR 监控页绑定 GitCode 令牌' });
      inflight.add(key);
      locked = true;
      const preview = await previewBase(draft, credential.value, repo, base);
      const fresh = await readDraft(id);
      fresh.previews = { ...(fresh.previews || {}), [base]: preview };
      await writeDraft(fresh);
      res.json({ success: true, preview });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    } finally {
      if (locked) inflight.delete(key);
    }
  });

  router.get('/pr-submit/drafts/:id/port-check', async (req, res) => {
    try {
      if (!await requireUser(req, res)) return;
      if (!isDraftId(req.params.id)) return res.status(400).json({ success: false, message: '草稿编号无效' });
      const draft = await readDraft(req.params.id);
      if (!draft) return res.status(404).json({ success: false, message: '草稿不存在，请在仓库里重新运行 ace pr' });
      res.json({ success: true, check: await portCheck(draft, String(req.query.base || '')) });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  router.post('/pr-submit/drafts/:id/verify', async (req, res) => {
    try {
      const auth = await requireUser(req, res);
      if (!auth) return;
      if (!isDraftId(req.params.id)) return res.status(400).json({ success: false, message: '草稿编号无效' });
      const draft = await readDraft(req.params.id);
      if (!draft) return res.status(404).json({ success: false, message: '草稿不存在，请在仓库里重新运行 ace pr' });
      const { base = '', key = '', note = '' } = req.body || {};
      const by = auth.user.username || auth.user.name || '';
      res.json({ success: true, verification: await verifyPort(draft, String(base), String(key), note, by) });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  router.get('/pr-submit/drafts/:id/preflight', async (req, res) => {
    try {
      const auth = await requireUser(req, res);
      if (!auth) return;
      if (!isDraftId(req.params.id)) return res.status(400).json({ success: false, message: '草稿编号无效' });
      const draft = await readDraft(req.params.id);
      if (!draft) return res.status(404).json({ success: false, message: '草稿不存在，请在仓库里重新运行 ace pr' });
      const repo = String(req.query.repo || '').trim();
      if (!REPO_RE.test(repo)) return res.status(400).json({ success: false, message: '目标仓库格式应为 owner/repo' });
      const credentials = await getGitcodeTokenValues(auth.token);
      const credential = credentials.find((item) => item.value);
      const fork = credential ? forkRemote(draft.remotes, credential.login, repo) : null;
      res.json({
        success: true,
        tokenConfigured: Boolean(credential),
        login: credential?.login || '',
        fork: fork ? { name: fork.name, owner: fork.owner, repo: fork.repo } : null,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  router.post('/pr-submit/drafts/:id/descriptions', async (req, res) => {
    try {
      if (!await requireUser(req, res)) return;
      if (!isDraftId(req.params.id)) return res.status(400).json({ success: false, message: '草稿编号无效' });
      const draft = await readDraft(req.params.id);
      if (!draft) return res.status(404).json({ success: false, message: '草稿不存在，请在仓库里重新运行 ace pr' });
      if (!draft.commits?.length) return res.status(400).json({ success: false, message: '草稿没有 commit，无法生成描述' });
      res.json({ success: true, ...await generateDescriptions(draft) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  router.get('/pr-submit/drafts/:id', async (req, res) => {
    try {
      if (!await requireUser(req, res)) return;
      if (!isDraftId(req.params.id)) return res.status(400).json({ success: false, message: '草稿编号无效' });
      const draft = await readDraft(req.params.id);
      if (!draft) return res.status(404).json({ success: false, message: '草稿不存在，请在仓库里重新运行 ace pr' });
      res.json({ success: true, draft });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  router.get('/pr-submit/repos', async (req, res) => {
    try {
      if (!await requireUser(req, res)) return;
      const query = String(req.query.q || '').trim().toLowerCase();
      const repos = await listGitcodeOrgRepos('CPF-Flutter');
      const matched = query ? repos.filter((repo) => repo.toLowerCase().includes(query)) : repos;
      res.json({ success: true, total: repos.length, repos: matched });
    } catch (error) {
      res.status(502).json({ success: false, message: error.message });
    }
  });

  router.get('/pr-submit/branches', async (req, res) => {
    try {
      const auth = await requireUser(req, res);
      if (!auth) return;
      const repo = String(req.query.repo || '').trim();
      if (!REPO_RE.test(repo)) return res.status(400).json({ success: false, message: '目标仓库格式应为 owner/repo' });
      const credentials = await getGitcodeTokenValues(auth.token);
      const credential = credentials.find((item) => item.value);
      if (!credential) return res.status(400).json({ success: false, message: '请先在 PR 监控页绑定 GitCode 令牌' });
      const branches = await listBranches(credential.value, repo);
      res.json({ success: true, branches });
    } catch (error) {
      res.status(502).json({ success: false, message: error.message });
    }
  });

  router.get('/pr-submit/issues', async (req, res) => {
    try {
      const auth = await requireUser(req, res);
      if (!auth) return;
      const repo = String(req.query.repo || '').trim();
      if (!REPO_RE.test(repo)) return res.status(400).json({ success: false, message: '目标仓库格式应为 owner/repo' });
      const credentials = await getGitcodeTokenValues(auth.token);
      const credential = credentials.find((item) => item.value);
      if (!credential) return res.status(400).json({ success: false, message: '请先在 PR 监控页绑定 GitCode 令牌' });
      const result = await searchIssues(credential.value, repo, req.query.q || '');
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(502).json({ success: false, message: error.message });
    }
  });

  router.post('/pr-submit/drafts/:id/submit', async (req, res) => {
    const id = req.params.id;
    try {
      const auth = await requireUser(req, res);
      if (!auth) return;
      if (!isDraftId(id)) return res.status(400).json({ success: false, message: '草稿编号无效' });
      if (inflight.has(id)) return res.status(409).json({ success: false, message: '这份草稿正在提交' });
      const draft = await readDraft(id);
      const plan = validateSubmitRequest(draft, req.body || {});
      if (!plan.ok) return res.status(400).json({ success: false, message: plan.errors[0], errors: plan.errors });
      if (!plan.pending.length && (plan.issue.mode !== 'create' || draft.results?.issue)) {
        return res.status(400).json({ success: false, message: '选中的分支都已经创建过 PR' });
      }
      const credentials = await getGitcodeTokenValues(auth.token);
      const credential = credentials.find((item) => item.value);
      if (!credential) return res.status(400).json({ success: false, message: '请先在 PR 监控页绑定 GitCode 令牌' });
      inflight.add(id);
      const saved = await submitDraft(draft, plan, credential.value, credential.login);
      await writeDraft(saved);
      const failed = (saved.results?.pulls || []).filter((item) => item.error);
      res.status(failed.length ? 422 : 200).json({
        success: failed.length === 0,
        message: failed.length ? failed[0].error : 'PR 已创建',
        draft: saved,
      });
    } catch (error) {
      res.status(422).json({ success: false, message: error.message });
    } finally {
      inflight.delete(id);
    }
  });

  return router;
}
