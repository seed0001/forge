import type { CatalogModel, ChatProvider } from './ipc-channels';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const FAIRROUTER_MODELS_URL = 'https://fairrouter.ai/v1/models';

/** Both providers' own model listings are OpenAI-shaped (only the fields we use). */
interface RawModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  /** Which request params this model's endpoint(s) actually accept. */
  supported_parameters?: string[];
}

/**
 * The agent sends `tools`/`tool_choice` on every single completion — that's
 * how it reads files, runs commands, edits code. A model whose endpoint
 * doesn't list 'tools' support 404s ("no endpoints found that support tool
 * use") the moment it's actually used, even though it shows up fine in the
 * catalog — so it must never reach the selector in the first place. Only
 * excludes when the field is present and says no; a listing that omits the
 * field entirely is assumed compatible rather than guessed against.
 */
function supportsTools(raw: RawModel): boolean {
  return raw.supported_parameters === undefined || raw.supported_parameters.includes('tools');
}

/**
 * OpenRouter lists batch-only variants of ordinary models as a separate
 * catalog entry with a literal `:batch` suffix on the id (e.g.
 * `anthropic/claude-sonnet-5:batch`, alongside the normal
 * `anthropic/claude-sonnet-5`). They 404 on a regular chat completion
 * request ("This model is only available through the Batch API. Use the
 * /api/beta/batches endpoint instead.") since they only exist behind
 * OpenRouter's async /api/beta/batches endpoint, which this app never calls.
 */
function isBatchOnly(raw: RawModel): boolean {
  return raw.id.endsWith(':batch');
}

/** Refetching on every dropdown open would hit either provider far more than its list ever changes. */
const CACHE_MS = 5 * 60_000;
interface Cache {
  at: number;
  models: CatalogModel[];
}
const cache = new Map<ChatProvider, Cache>();
const inflight = new Map<ChatProvider, Promise<CatalogModel[]>>();

function toModel(raw: RawModel, provider: ChatProvider): CatalogModel {
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
    provider,
  };
}

async function fetchOpenRouterModels(): Promise<CatalogModel[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const res = await fetch(OPENROUTER_MODELS_URL, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) {
    throw new Error(`OpenRouter models request failed (${res.status})`);
  }
  const data = (await res.json()) as { data?: RawModel[] };
  return (data.data ?? [])
    .filter((m) => supportsTools(m) && !isBatchOnly(m))
    .map((m) => toModel(m, 'openrouter'));
}

/** Unlike OpenRouter's public catalog, FairRouter's /v1/models requires a key — skip the call rather than fail loudly if none is set yet. */
async function fetchFairRouterModels(): Promise<CatalogModel[]> {
  const apiKey = process.env.FAIRROUTER_API_KEY;
  if (!apiKey) return [];
  const res = await fetch(FAIRROUTER_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`FairRouter models request failed (${res.status})`);
  }
  const data = (await res.json()) as { data?: RawModel[] };
  return (data.data ?? [])
    .filter((m) => supportsTools(m) && !isBatchOnly(m))
    .map((m) => toModel(m, 'fairrouter'));
}

const FETCHERS: Record<ChatProvider, () => Promise<CatalogModel[]>> = {
  openrouter: fetchOpenRouterModels,
  fairrouter: fetchFairRouterModels,
};

async function listProviderModels(provider: ChatProvider, forceRefresh: boolean): Promise<CatalogModel[]> {
  const cached = cache.get(provider);
  if (!forceRefresh && cached && Date.now() - cached.at < CACHE_MS) return cached.models;
  // Two dropdown opens in quick succession share one in-flight request rather
  // than firing a second identical fetch.
  let pending = inflight.get(provider);
  if (!pending) {
    pending = FETCHERS[provider]()
      .then((models) => {
        cache.set(provider, { at: Date.now(), models });
        return models;
      })
      .finally(() => {
        inflight.delete(provider);
      });
    inflight.set(provider, pending);
  }
  return pending;
}

/**
 * Cached list of every model both configured providers currently serve,
 * merged into one catalog and sorted by name. A provider whose fetch fails
 * (e.g. FairRouter unreachable) does not block the other's models from
 * showing — its error is only surfaced if BOTH providers come back empty.
 * `forceRefresh` bypasses the cache — used by the selector's manual refresh.
 */
export async function listCatalogModels(forceRefresh = false): Promise<CatalogModel[]> {
  const results = await Promise.allSettled([
    listProviderModels('openrouter', forceRefresh),
    listProviderModels('fairrouter', forceRefresh),
  ]);

  const models = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (!models.length) {
    const firstError = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (firstError) throw firstError.reason;
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}
