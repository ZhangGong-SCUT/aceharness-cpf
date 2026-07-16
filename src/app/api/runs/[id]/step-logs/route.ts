import { NextRequest, NextResponse } from 'next/server';
import { readFile, readdir, stat } from 'fs/promises';
import { resolve } from 'path';
import { getWorkspaceRunsDir } from '@/lib/core/app-paths';

const RUNS_DIR = getWorkspaceRunsDir();

/**
 * GET /api/runs/{runId}/step-logs
 *
 * 读取 step-logs 目录中的完整步骤输出（含 UUID 文件名）。
 * 与 /outputs 接口的区别：outputs/ 根目录可能只有精简版摘要，
 * step-logs/ 保存的是 Agent 的完整输出。
 *
 * Query 参数（二选一）:
 *   - step: 步骤名（如 "报告沉淀-生成诊断报告"），自动匹配 step-logs/ 中以该名称开头的文件
 *   - file: 完整文件名（如 "报告沉淀-生成诊断报告-abc123.md"），精确匹配
 *
 * 无参数时：列出 step-logs/ 目录下所有文件
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const runId = (await params).id;
  const stepName = request.nextUrl.searchParams.get('step');
  const fileName = request.nextUrl.searchParams.get('file');

  try {
    const stepLogsDir = resolve(RUNS_DIR, runId, 'outputs', 'step-logs');

    // 无参数：列出所有文件
    if (!stepName && !fileName) {
      try {
        const files = await readdir(stepLogsDir);
        const result = [];
        for (const f of files) {
          if (!f.endsWith('.md') && !f.endsWith('.txt')) continue;
          const filePath = resolve(stepLogsDir, f);
          const fileStat = await stat(filePath);
          result.push({
            filename: f,
            size: fileStat.size,
            outputRef: `outputs/step-logs/${f}`,
          });
        }
        return NextResponse.json({ files: result });
      } catch {
        return NextResponse.json({ error: 'step-logs 目录不存在', files: [] }, { status: 404 });
      }
    }

    // 有参数：读取指定文件
    let targetFile: string | null = null;

    if (fileName) {
      // 精确匹配文件名
      const candidate = resolve(stepLogsDir, fileName);
      if (candidate.startsWith(stepLogsDir)) {
        try {
          await stat(candidate);
          targetFile = candidate;
        } catch { /* file not found */ }
      }
    }

    if (!targetFile && stepName) {
      // 按步骤名前缀匹配，取最大的文件（最完整的输出）
      const safeName = stepName.replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, '_');
      try {
        const files = await readdir(stepLogsDir);
        const matchFiles = files.filter(f => f.startsWith(safeName) && (f.endsWith('.md') || f.endsWith('.txt')));
        if (matchFiles.length > 0) {
          let bestFile = matchFiles[0];
          let bestSize = 0;
          for (const f of matchFiles) {
            const s = await stat(resolve(stepLogsDir, f));
            if (s.size > bestSize) {
              bestSize = s.size;
              bestFile = f;
            }
          }
          targetFile = resolve(stepLogsDir, bestFile);
        }
      } catch { /* dir not found */ }
    }

    if (!targetFile) {
      return NextResponse.json({ error: '未找到该步骤的 step-log' }, { status: 404 });
    }

    const content = await readFile(targetFile, 'utf-8');
    const filename = targetFile.split('/').pop() || '';

    return NextResponse.json({
      stepName: filename.replace(/\.(md|txt)$/, ''),
      filename,
      content,
      size: content.length,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: '获取 step-log 失败', message: error.message },
      { status: 500 }
    );
  }
}
