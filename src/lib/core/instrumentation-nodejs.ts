/**
 * Node.js-only instrumentation implementations
 * This file is only imported when NEXT_RUNTIME === 'nodejs'
 */

export async function runNodejsInstrumentation() {
  const { existsSync, mkdirSync } = await import('fs');
  const { join } = await import('path');
  const { getEngineConfigDir } = await import('@/lib/engines/engine-config');
  const { getEngineConfigPath, getWorkspaceRoot } = await import('./app-paths');

  const workspaceRoot = getWorkspaceRoot();

  let engineConfigDir = '.agents';
  try {
    const engineJson = getEngineConfigPath();
    if (existsSync(engineJson)) {
      const { readFileSync } = await import('fs');
      const config = JSON.parse(readFileSync(engineJson, 'utf-8'));
      if (config.engine) engineConfigDir = getEngineConfigDir(config.engine);
    }
  } catch {
    // Use the default engine config directory.
  }

  const configDir = join(workspaceRoot, engineConfigDir);
  try {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
      console.log(`[ACEHarness] Created ${engineConfigDir}/`);
    }
  } catch (error) {
    console.error(`[ACEHarness] Failed to setup ${engineConfigDir}:`, error);
  }

  try {
    const { WorkflowManager } = await import('@/lib/workflow/manager');
    const recoverer = new WorkflowManager();
    await recoverer.recoverFromCrash();
  } catch (error) {
    console.error('[ACEHarness] Workflow recovery failed:', error);
  }

  if (process.env.ACE_KEEP_SDK_OVERLAY !== '1') {
    void (async () => {
      const { sweepEndedRunSdkOverlays } = await import('@/lib/workflow/sdk-overlay');
      const { loadRunState } = await import('@/lib/run/state-persistence');
      const { getWorkspaceRunsDir } = await import('./app-paths');
      const removed = await sweepEndedRunSdkOverlays(getWorkspaceRunsDir(),
        async (runId) => (await loadRunState(runId, { hydrateLargeOutputs: false }))?.status);
      if (removed.length) console.log(`[ACEHarness] Removed SDK overlays of ${removed.length} ended runs`);
    })().catch((error) => console.error('[ACEHarness] SDK overlay sweep failed:', error));
  }

  try {
    const { ensureChannelEventBridgeRegistered } = await import('@/lib/channel/delivery');
    ensureChannelEventBridgeRegistered();
  } catch (error) {
    console.error('[ACEHarness] Channel event bridge setup failed:', error);
  }

  try {
    const { scheduleWeChatOfficialBridgeRestore } = await import('@/lib/channel/wechat/official-service');
    scheduleWeChatOfficialBridgeRestore();
  } catch (error) {
    console.error('[ACEHarness] WeChat bridge restore setup failed:', error);
  }

  try {
    const { startPrMonitorWorker } = await import('@/lib/workflow/pr-monitor');
    startPrMonitorWorker();
  } catch (error) {
    console.error('[ACEHarness] PR monitor restore failed:', error);
  }

  try {
    const { scheduler } = await import('@/lib/core/scheduler');
    await scheduler.init();
  } catch (error) {
    console.error('[ACEHarness] Scheduler restore failed:', error);
  }
}
