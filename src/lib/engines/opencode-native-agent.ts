import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { getWorkspaceRoot } from '@/lib/core/app-paths';
import { resolveOpenCodeGlobalConfigDirectories } from './opencode-command-files';
import type { OpenCodeHttpClient } from './opencode-http-adapter';

export type OpenCodeNativeAgentDefinition = {
  description?: string;
  mode?: 'subagent' | 'primary' | 'all';
  hidden?: boolean;
  prompt: string;
  model?: string;
};

function yamlScalar(value: string): string {
  const text = String(value || '').replace(/\r?\n/g, ' ').trim();
  if (!text) return '""';
  if (/[:#{}[\],&*?|!<>=%@`'"\\]/.test(text) || /^\s|\s$/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

export function sanitizeOpenCodeAgentName(agent: string): string {
  const name = String(agent || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return name || 'build';
}

export function buildOpenCodeAgentMarkdown(definition: OpenCodeNativeAgentDefinition): string {
  const lines = [
    '---',
    `description: ${yamlScalar(definition.description || 'ACEHarness agent')}`,
    `mode: ${definition.mode || 'primary'}`,
    `hidden: ${definition.hidden === true ? 'true' : 'false'}`,
  ];
  if (definition.model) {
    lines.push(`model: ${yamlScalar(definition.model)}`);
  }
  lines.push('---', '', String(definition.prompt || '').trim(), '');
  return lines.join('\n');
}

export function resolveOpenCodeNativeAgentWriteDirs(options: {
  userId?: string;
  workingDirectory?: string;
} = {}): string[] {
  const dirs = [
    path.join(getWorkspaceRoot(), '.opencode', 'agent'),
  ];
  if (!process.env.ACE_HOME?.trim()) {
    const globalRoot = resolveOpenCodeGlobalConfigDirectories({
      workingDirectory: options.workingDirectory,
      userId: options.userId,
    })[0];
    if (globalRoot) dirs.push(path.join(globalRoot, 'agent'));
  }
  return [...new Set(dirs.map((item) => path.resolve(item)))];
}

async function writeOpenCodeAgentFiles(agentName: string, markdown: string, writeDirs: string[]): Promise<void> {
  await Promise.all(writeDirs.map(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${agentName}.md`), markdown, 'utf8');
  }));
}

export const VISION_INSPECTOR_AGENT_NAME = 'vision-inspector';
export const DEFAULT_VISION_INSPECTOR_MODEL = '火山AI网关/qwen3.7-plus';
export const VISION_INSPECTOR_PROMPT = [
  '你是诊断流水线里的看图眼睛。父 agent（GLM-5.2）看不见像素，只会读你的文字。',
  '必须真正查看父 agent 给出的本地图片路径，只根据图里看见的内容回答。',
  '回答要具体：控件、文字、颜色、对齐、下划线位置/长短、是否错位。看不清就说看不清。用中文。',
  '不要根据文件名或 Issue 正文臆造视觉现象。',
].join('');

export function buildVisionInspectorDefinition(model = DEFAULT_VISION_INSPECTOR_MODEL): OpenCodeNativeAgentDefinition {
  return {
    description: 'Look at a local screenshot and answer a specific visual question for a text-only parent agent.',
    mode: 'subagent',
    hidden: false,
    prompt: VISION_INSPECTOR_PROMPT,
    model: String(model || '').trim() || DEFAULT_VISION_INSPECTOR_MODEL,
  };
}

export async function registerOpenCodeVisionInspector(options: {
  client: OpenCodeHttpClient;
  model?: string;
  workingDirectory?: string;
  userId?: string;
  writeDirs?: string[];
}): Promise<string> {
  const definition = buildVisionInspectorDefinition(options.model);
  const markdown = buildOpenCodeAgentMarkdown(definition);
  const writeDirs = options.writeDirs || resolveOpenCodeNativeAgentWriteDirs({
    userId: options.userId,
    workingDirectory: options.workingDirectory,
  });
  await writeOpenCodeAgentFiles(VISION_INSPECTOR_AGENT_NAME, markdown, writeDirs);

  const query = options.workingDirectory ? { directory: options.workingDirectory } : undefined;
  const client = options.client as OpenCodeHttpClient & {
    config?: {
      get?: (input?: { query?: { directory?: string } }) => Promise<{ data?: { agent?: Record<string, OpenCodeNativeAgentDefinition> }; error?: unknown }>;
      update?: (input: { body?: { agent?: Record<string, OpenCodeNativeAgentDefinition> }; query?: { directory?: string } }) => Promise<{ error?: unknown }>;
    };
  };
  try {
    const current = await client.config?.get?.({ query });
    const existingAgents = current?.data?.agent && typeof current.data.agent === 'object'
      ? current.data.agent
      : {};
    await client.config?.update?.({
      query,
      body: {
        agent: {
          ...existingAgents,
          [VISION_INSPECTOR_AGENT_NAME]: definition,
        },
      },
    });
  } catch {
    // File-based registration still lets the next OpenCode instance pick up the agent.
  }

  return VISION_INSPECTOR_AGENT_NAME;
}

export async function registerOpenCodeNativeAgent(options: {
  client: OpenCodeHttpClient;
  agent: string;
  systemPrompt: string;
  model?: string;
  workingDirectory?: string;
  userId?: string;
  writeDirs?: string[];
}): Promise<string> {
  const agentName = sanitizeOpenCodeAgentName(options.agent);
  const definition: OpenCodeNativeAgentDefinition = {
    description: `ACEHarness agent ${agentName}`,
    mode: 'primary',
    hidden: false,
    prompt: String(options.systemPrompt || '').trim(),
    model: String(options.model || '').trim() || undefined,
  };
  const markdown = buildOpenCodeAgentMarkdown(definition);
  const writeDirs = options.writeDirs || resolveOpenCodeNativeAgentWriteDirs({
    userId: options.userId,
    workingDirectory: options.workingDirectory,
  });
  await writeOpenCodeAgentFiles(agentName, markdown, writeDirs);

  const query = options.workingDirectory ? { directory: options.workingDirectory } : undefined;
  const client = options.client as OpenCodeHttpClient & {
    config?: {
      get?: (input?: { query?: { directory?: string } }) => Promise<{ data?: { agent?: Record<string, OpenCodeNativeAgentDefinition> }; error?: unknown }>;
      update?: (input: { body?: { agent?: Record<string, OpenCodeNativeAgentDefinition> }; query?: { directory?: string } }) => Promise<{ error?: unknown }>;
    };
  };
  try {
    const current = await client.config?.get?.({ query });
    const existingAgents = current?.data?.agent && typeof current.data.agent === 'object'
      ? current.data.agent
      : {};
    await client.config?.update?.({
      query,
      body: {
        agent: {
          ...existingAgents,
          [agentName]: definition,
        },
      },
    });
  } catch {
    // File-based registration still lets the next OpenCode instance pick up the agent.
  }

  return agentName;
}
