/** 识别步骤必须由引擎脚本执行。旧运行时配置没有 prScript 时，模型会去查 PATH 和白名单。 */
export function resolvePrScript(
  configFile: string | undefined,
  stateName: string,
  step: { prScript?: string },
): string | undefined {
  if (step.prScript) return step.prScript;
  if (configFile === 'gitcode-pr-review.yaml' && stateName === '识别') return 'identity';
  return undefined;
}

export function bundledPrWorkflowNeedsRefresh(content: string): boolean {
  return !content.includes('prScript: identity');
}
