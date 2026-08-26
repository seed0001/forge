import { CHAT_PROVIDERS, DEFAULT_LLAMACPP_BASE_URL, DEFAULT_OLLAMA_BASE_URL, MODEL_ENV_KEY } from './ipc-channels';
import type { ChatProvider } from './ipc-channels';

/**
 * Shared provider-resolution logic — used by the main chat loop
 * (agent-service.ts) and by any other one-off completion (e.g. summarizing a
 * browsed page) that needs to talk to whichever provider/model is currently
 * configured, without duplicating this lookup.
 */

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const FAIRROUTER_URL = 'https://fairrouter.ai/v1/chat/completions';

/** Ollama and llama.cpp are local runtimes with no fixed host — their base URL is Operator-configurable (Settings), defaulting to the usual localhost port for each. */
const API_KEY_ENV_KEY: Record<ChatProvider, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  fairrouter: 'FAIRROUTER_API_KEY',
  ollama: 'OLLAMA_API_KEY',
  llamacpp: 'LLAMACPP_API_KEY',
};

/** Only these two need a real credential before they're usable — local runtimes don't. */
const PROVIDER_REQUIRES_KEY: Partial<Record<ChatProvider, true>> = {
  openrouter: true,
  fairrouter: true,
};

export interface ChatProviderConfig {
  provider: ChatProvider;
  url: string;
  apiKey: string;
  model: string;
}

export const PROVIDER_LABEL: Record<ChatProvider, string> = Object.fromEntries(
  CHAT_PROVIDERS.map((p) => [p.id, p.label])
) as Record<ChatProvider, string>;

/** The active provider id, falling back to openrouter if PROVIDER is unset or names a provider that no longer exists. */
export function activeProviderId(): ChatProvider {
  const raw = process.env.PROVIDER;
  return (CHAT_PROVIDERS.some((p) => p.id === raw) ? raw : 'openrouter') as ChatProvider;
}

/** Chat-completions URL for a provider — OpenRouter/FairRouter are fixed hosts; local runtimes read their base URL from Settings (or the default) and get /chat/completions appended. */
export function chatUrlFor(provider: ChatProvider): string {
  switch (provider) {
    case 'openrouter':
      return OPENROUTER_URL;
    case 'fairrouter':
      return FAIRROUTER_URL;
    case 'ollama':
      return (process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '') + '/chat/completions';
    case 'llamacpp':
      return (process.env.LLAMACPP_BASE_URL || DEFAULT_LLAMACPP_BASE_URL).replace(/\/+$/, '') + '/chat/completions';
  }
}

/** Extra attribution headers OpenRouter reads; meaningless (and skipped) elsewhere. Authorization is only sent when there's an actual key — a local runtime with none configured gets no header at all rather than a bare, meaningless "Bearer ". */
export function chatHeaders(provider: ChatProvider, apiKey: string): Record<string, string> {
  const base: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) base['Authorization'] = `Bearer ${apiKey}`;
  if (provider === 'openrouter') {
    base['HTTP-Referer'] = 'https://forge.local';
    base['X-Title'] = 'Forge';
  }
  return base;
}

/**
 * The main chat loop (send/generateTitle/summarizeForCompaction) can run on
 * any configured provider — media tools (image/vision/music) stay
 * OpenRouter-only. Which one is active is chosen via the provider selector,
 * which sets both PROVIDER and that provider's own *_MODEL var so each
 * provider remembers its own last-picked model.
 *
 * Null when the active provider needs an API key it doesn't have, or has no
 * model selected — local runtimes need only the model (an empty API key is
 * normal for a plain local install).
 */
export function resolveChatProvider(): ChatProviderConfig | null {
  const provider = activeProviderId();
  const model = process.env[MODEL_ENV_KEY[provider]] || '';
  if (!model) return null;
  const apiKey = process.env[API_KEY_ENV_KEY[provider]] || '';
  if (PROVIDER_REQUIRES_KEY[provider] && !apiKey) return null;
  return { provider, url: chatUrlFor(provider), apiKey, model };
}

/**
 * A single tool-free completion outside any conversation — same shape as
 * AgentSession's generateTitle()/summarizeForCompaction() in agent-service.ts,
 * factored out here for callers that aren't part of an agent's own turn (e.g.
 * summarizing a browsed page). Every failure mode collapses to `text: null`
 * so callers can degrade gracefully instead of throwing.
 */
export async function oneOffCompletion(
  prompt: string,
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<{ text: string | null; costUsd: number }> {
  const cfg = resolveChatProvider();
  if (!cfg) return { text: null, costUsd: 0 };
  try {
    const resp = await fetch(cfg.url, {
      method: 'POST',
      headers: chatHeaders(cfg.provider, cfg.apiKey),
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: opts.maxTokens ?? 600,
        temperature: opts.temperature ?? 0.3,
        usage: { include: true },
      }),
    });
    if (!resp.ok) return { text: null, costUsd: 0 };
    const data = await resp.json();
    const costUsd = typeof data.usage?.cost === 'number' ? data.usage.cost : 0;
    const text = data.choices?.[0]?.message?.content?.trim();
    return { text: text || null, costUsd };
  } catch {
    return { text: null, costUsd: 0 };
  }
}
