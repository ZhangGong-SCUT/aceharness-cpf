export type DiagnosisInputMode = 'issue' | 'freeform' | 'empty';

export type DiagnosisInput = {
  mode: DiagnosisInputMode;
  issueUrl: string | null;
  issueNumber: string | null;
};

const ISSUE_URL_RE = /https?:\/\/[^\s`'\"<>]+\/issues\/(\d+)/i;

export const DEFAULT_FLUTTER_OHOS_REPO = 'https://gitcode.com/CPF-Flutter/flutter_flutter.git';

export function classifyDiagnosisInput(globalContext: string | null | undefined): DiagnosisInput {
  const text = String(globalContext || '').trim();
  if (!text) {
    return { mode: 'empty', issueUrl: null, issueNumber: null };
  }
  const match = text.match(ISSUE_URL_RE);
  if (match) {
    return {
      mode: 'issue',
      issueUrl: match[0],
      issueNumber: match[1],
    };
  }
  return { mode: 'freeform', issueUrl: null, issueNumber: null };
}

export function formatDiagnosisInputPrompt(globalContext: string | null | undefined): string {
  const input = classifyDiagnosisInput(globalContext);
  if (input.mode === 'empty') {
    return [
      '# 诊断输入形态',
      'mode=empty',
      'globalContext 为空。不要编造 Issue 号，不要改去诊断工作副本里残留的旧 Issue。向人类确认输入后再继续。',
    ].join('\n');
  }
  if (input.mode === 'issue') {
    return [
      '# 诊断输入形态',
      'mode=issue',
      `issueUrl=${input.issueUrl}`,
      '按 Issue 链接采集正文和评论。不要改去诊断另一道 Issue。',
    ].join('\n');
  }
  return [
    '# 诊断输入形态',
    'mode=freeform',
    '没有 GitCode/GitHub Issue 链接。禁止 curl Issue/comments API，禁止编造 Issue 号，禁止改去诊断工作副本或模板里残留的旧 Issue（例如 #2490 截图/Demo）。',
    '把「全局上下文」全文当作本轮唯一问题：issue_title 取首行标题或第一句，issue_body_summary 概括该全文。',
    'issue_comments_count=0；issue_comments_summary=无评论（文本输入）；input_source=freeform_text。',
    'issue_created_at 未知：不要 git log --before 回退。checkout 推断分支后保持 HEAD，reset_status=skipped_no_issue_date，reset_target_merge_commit=null。',
    `repo_url：正文里若有 gitcode/github 仓地址就用；否则 ${DEFAULT_FLUTTER_OHOS_REPO}`,
    'branch：正文版本号按映射表；否则 default_branch。',
    '文本输入没有创建时间/评论不算缺正文；缺设备等信息仍写入 missing_evidence，issue_content_complete 可以是 false。',
  ].join('\n');
}
