import { basename, relative, resolve, sep } from 'path';

/**
 * 共享模板的 outputs/ 是某次 run 写进去的产物。
 * 下一次监控把整个模板拷走时，不能把上一份 PR 的检视意见、补丁和门禁结果一起带走。
 */
export function shouldCopyWorkflowTemplateEntry(srcRoot: string, srcPath: string): boolean {
  const rel = relative(resolve(srcRoot), resolve(srcPath)).split(sep).join('/');
  if (!rel || rel.startsWith('..') || rel === '') return false;
  return rel !== 'outputs' && !rel.startsWith('outputs/');
}

/** 工作流配置里的 projectRoot `_template`，解析后目录名就是这个。 */
export function isSharedWorkflowTemplate(dir: string): boolean {
  const target = String(dir || '').trim();
  if (!target) return false;
  return basename(resolve(target)) === '_template';
}
