import type { OpenRouterModel } from './ipc-channels';

const MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** OpenRouter's own model listing shape (only the fields we use). */
interface RawModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

/** Refetching on every dropdown open would hit OpenRouter far more than the list ever changes. */
const CACHE_MS = 5 * 60_000;
let cache: { at: number; models: OpenRouterModel[] } | null = null;
let inflight: Promise<OpenRouterModel[]> | null = null;

function toModel(raw: RawModel): OpenRouterModel {
  const promptPrice = Number(raw.pricing?.prompt ?? 0) || 0;
  const completionPrice = Number(raw.pricing?.completion ?? 0) || 0;
  return {
    id: raw.id,
    name: raw.name || raw.id,
    description: raw.description,
    contextLength: raw.context_length ?? 0,
    promptPrice,
    completionPrice,
    isFree: promptPrice === 0 && completionPrice === 0,
  };
}

async function fetchModels(): Promise<OpenRouterModel[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const res = await fetch(MODELS_URL, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) {
    throw new Error(`OpenRouter models request failed (${res.status})`);
  }
  const data = (await res.json()) as { data?: RawModel[] };
  return (data.data ?? [])
    .map(toModel)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Cached list of every model OpenRouter currently serves, free and paid alike.
 * `forceRefresh` bypasses the cache — used by the selector's manual refresh.
 */
export async function listOpenRouterModels(forceRefresh = false): Promise<OpenRouterModel[]> {
  if (!forceRefresh && cache && Date.now() - cache.at < CACHE_MS) return cache.models;
  // Two dropdown opens in quick succession share one in-flight request rather
  // than firing a second identical fetch.
  if (!inflight) {
    inflight = fetchModels()
      .then((models) => {
        cache = { at: Date.now(), models };
        return models;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
