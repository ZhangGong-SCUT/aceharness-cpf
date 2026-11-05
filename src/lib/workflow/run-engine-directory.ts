import { isAbsolute, resolve } from 'path';

/**
 * 引擎实际 cwd。隔离目录已经记在 run 上时必须用它，
 * 不能再按配置里的 `_template` 解析，否则状态写的是 run 目录、模型仍在模板目录。
 */
export function resolveRunEngineDirectory(input: {
  isolatedDir?: string | null;
  projectRoot?: string | null;
  personalDir?: string | null;
  workspaceRoot: string;
}): string {
  const isolated = input.isolatedDir?.trim();
  if (isolated) return resolve(isolated);
  const base = input.personalDir?.trim() || input.workspaceRoot;
  const root = input.projectRoot?.trim();
  if (!root) return resolve(base);
  return isAbsolute(root) ? resolve(root) : resolve(base, root);
}
