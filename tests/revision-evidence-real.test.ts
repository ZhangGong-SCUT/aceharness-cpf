import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, test } from 'vitest';
import { executeDiagnosisScript } from '@/lib/workflow/diagnosis-script-step';
import { makeStepResultRecord } from '@/lib/workflow/step-result-record';
import { extractIssueRevisionExpectation } from '@/lib/workflow/revision-evidence';

const RUN = '/Users/flutter/.aceharness/runs/run-1794742003610-ia-5139fe36';
const WORK = '/Users/flutter/.aceharness/run-workspaces/run-1794742003610-ia-5139fe36';

describe('真实 #2590 只读归档演练', () => {
  test('理论复现可归档，但不能作为原始 Issue 修复效果已验证', async (ctx) => {
    ctx.skip(!existsSync(join(RUN, 'state.yaml')) || !existsSync(join(WORK, 'outputs')), '真实 #2590 工作区不可用');
    const archive = join(tmpdir(), 'run-1794742003610-ia-5139fe36');
    rmSync(archive, { recursive: true, force: true });
    mkdirSync(archive, { recursive: true });
    try {
      cpSync(join(RUN, 'state.yaml'), join(archive, 'state.yaml'));
      mkdirSync(join(archive, 'outputs'), { recursive: true });
      // 步骤结果是门禁输入；其余证据仍从真实工作区读取并复制到临时归档，原 run 不改写。
      const state = parse(readFileSync(join(RUN, 'state.yaml'), 'utf8'));
      const { stringify } = await import('yaml');
      const { writeFileSync } = await import('node:fs');
      for (const log of state.stepLogs || []) {
        for (const key of ['outputRef', 'resultRef', 'rawOutputRef']) {
          if (typeof log[key] !== 'string') continue;
          const path = relative(join(RUN, 'outputs'), join(RUN, log[key]));
          if (path.startsWith('..')) continue;
          const target = join(archive, 'outputs', path);
          mkdirSync(dirname(target), { recursive: true });
          cpSync(join(RUN, log[key]), target);
          if (key === 'outputRef') {
            log.resultRef = `${log[key]}.result.json`;
            log.rawOutputRef = `${log[key]}.raw`;
            writeFileSync(`${target}.result.json`, JSON.stringify(makeStepResultRecord(basename(archive), log.id, log.stepName, readFileSync(target, 'utf8'))));
            writeFileSync(`${target}.raw`, readFileSync(target, 'utf8'));
          }
        }
      }
      writeFileSync(join(archive, 'state.yaml'), stringify(state));
      const collect = state.stepLogs.find((log: any) => log.stepName === '信息采集-Issue信息采集');
      expect(extractIssueRevisionExpectation(readFileSync(join(RUN, collect.outputRef), 'utf8'))).toMatchObject({ framework: 'adaf911c' });
      const raw = await executeDiagnosisScript({ operation: 'finish', workingDirectory: WORK, runDirectory: archive, globalContext: '' });
      const result = JSON.parse(raw.match(/<step-conclusion>([\s\S]*?)<\/step-conclusion>/)![1]);
      const context = JSON.parse(readFileSync(join(archive, 'outputs/diagnosis-context.json'), 'utf8'));
      expect(context.reproduction_status).toBe('theoretical');
      expect(result.verification_status).toBe('needs_runtime_validation');
      expect(result.verification_status).toBe('needs_runtime_validation');
      expect(result.verdict).toBe('pass');
      expect(context.consistency_warnings.map((warning: any) => warning.code)).toContain('theoretical_reproduction_runtime_required');
      expect(context.revision_evidence.expected).toMatchObject({ framework: 'adaf911c', engine: '42d3d75a56efe1a2e9902f52dc8006099c45d937' });
      expect(context.revision_evidence.status).toBe('unknown');
      expect(context.revision_evidence.unknown).toEqual(['sdk_framework_revision', 'sdk_engine_revision']);
    } finally { rmSync(archive, { recursive: true, force: true }); }
  }, 60000);
});
