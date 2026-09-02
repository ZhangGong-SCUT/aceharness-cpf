export type DiscoveredModelRef = {
  modelId: string;
  name: string;
};

function normalizeModelToken(value: string): string {
  return value.trim().toLowerCase().replace(/[.\-_]/g, '-');
}

function stripModelParams(value: string): string {
  return value.replace(/\[[^\]]*\]/g, '').trim();
}

function modelIdTail(value: string): string {
  const stripped = stripModelParams(value);
  const slash = stripped.lastIndexOf('/');
  return slash >= 0 ? stripped.slice(slash + 1) : stripped;
}

function preferVolcanoGlm(candidates: DiscoveredModelRef[]): DiscoveredModelRef[] {
  const volcano = candidates.filter((item) => item.modelId.includes('火山AI网关/'));
  return volcano.length > 0 ? volcano : candidates;
}

function scoreParamMatch(requested: string, available: string): number {
  const requestedParams = requested.match(/\[([^\]]*)\]/)?.[1] || '';
  const availableParams = available.match(/\[([^\]]*)\]/)?.[1] || '';
  if (requestedParams && requestedParams === availableParams) return 1000;
  if (/reasoning=max|effort=max/.test(availableParams)) return 60;
  if (/reasoning=high|effort=high/.test(availableParams)) return 50;
  if (/reasoning=medium|effort=medium/.test(availableParams)) return 40;
  return 10;
}

function pickPreferredModel(requested: string, candidates: DiscoveredModelRef[]): string {
  const ranked = [...candidates].sort((a, b) => {
    const scoreDiff = scoreParamMatch(requested, b.modelId) - scoreParamMatch(requested, a.modelId);
    if (scoreDiff !== 0) return scoreDiff;
    return a.modelId.length - b.modelId.length;
  });
  return ranked[0]?.modelId || '';
}

export function resolveAvailableModelId(
  requestedModel: string | undefined,
  availableModels: DiscoveredModelRef[],
): string {
  const requested = String(requestedModel || '').trim();
  if (!requested || availableModels.length === 0) return '';
  const normalized = normalizeModelToken(requested);
  const requestedBase = normalizeModelToken(stripModelParams(requested));
  const requestedTail = normalizeModelToken(modelIdTail(requested));

  const exactById = availableModels.find((model) => model.modelId.trim() === requested);
  if (exactById) return exactById.modelId;

  const exactByName = availableModels.find((model) => model.name.trim() === requested);
  if (exactByName) return exactByName.modelId;

  const normalizedById = availableModels.find((model) => normalizeModelToken(model.modelId) === normalized);
  if (normalizedById) return normalizedById.modelId;

  const normalizedByName = availableModels.find((model) => normalizeModelToken(model.name) === normalized);
  if (normalizedByName) return normalizedByName.modelId;

  if (requested.includes('/')) {
    const fullBase = availableModels.filter((model) => (
      normalizeModelToken(stripModelParams(model.modelId)) === requestedBase
      || normalizeModelToken(stripModelParams(model.name)) === requestedBase
    ));
    if (fullBase.length > 0) return pickPreferredModel(requested, fullBase);

    const provider = requested.slice(0, requested.indexOf('/'));
    const providerNorm = normalizeModelToken(provider);
    const sameProvider = availableModels.filter((model) => {
      const id = stripModelParams(model.modelId);
      const slash = id.indexOf('/');
      if (slash < 0) return false;
      return normalizeModelToken(id.slice(0, slash)) === providerNorm
        && normalizeModelToken(modelIdTail(id)) === requestedTail;
    });
    return sameProvider.length > 0 ? pickPreferredModel(requested, sameProvider) : '';
  }

  const suffixMatch = availableModels
    .filter((model) => (model.modelId.split('/').pop() || '') === requested)
    .sort((a, b) => a.modelId.length - b.modelId.length)[0];
  if (suffixMatch) return suffixMatch.modelId;

  const normSuffix = availableModels.filter((model) => (
    normalizeModelToken(modelIdTail(model.modelId)) === requestedTail
    || normalizeModelToken(modelIdTail(model.name)) === requestedTail
  ));
  if (normSuffix.length > 0) {
    return pickPreferredModel(requested, preferVolcanoGlm(normSuffix));
  }

  const versioned = /\d/.test(requestedTail);
  const fuzzy = availableModels
    .filter((model) => {
      if (versioned) {
        const idTail = normalizeModelToken(modelIdTail(model.modelId));
        const nameTail = normalizeModelToken(modelIdTail(model.name));
        if (idTail !== requestedTail && nameTail !== requestedTail) return false;
      }
      return normalizeModelToken(model.name).includes(normalized)
        || normalizeModelToken(model.modelId).includes(normalized);
    })
    .sort((a, b) => a.modelId.length - b.modelId.length);
  return fuzzy[0]?.modelId || '';
}
