import type { EngineResultMetadata } from './engine-interface';

/** Message updates are cumulative; replace by ID, never add the same message twice. */
export function createOpenCodeUsageCollector(onUsage?: (usage: EngineResultMetadata) => void, excluded = new Set<string>()) {
  const messages = new Map<string, any>();
  return (info: any) => {
    if (info?.role !== 'assistant' || typeof info.id !== 'string' || excluded.has(info.id)) return;
    if (!info.tokens || !Number.isFinite(info.tokens.input) || !Number.isFinite(info.tokens.output)) return;
    messages.set(info.id, info);
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let cost = 0, costKnown = true;
    const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
    for (const message of messages.values()) {
      usage.input_tokens += n(message.tokens.input);
      usage.output_tokens += n(message.tokens.output);
      usage.cache_read_input_tokens += n(message.tokens.cache?.read);
      usage.cache_creation_input_tokens += n(message.tokens.cache?.write);
      if (typeof message.cost === 'number' && Number.isFinite(message.cost) && message.cost >= 0) cost += message.cost;
      else costKnown = false;
    }
    onUsage?.({ usage, usage_source: 'reported', ...(costKnown ? { cost_usd: cost } : {}),
      cost_source: costKnown ? 'reported' : 'unavailable', num_turns: messages.size });
  };
}
