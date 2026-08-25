import { CHAT_PROVIDERS } from './ipc-channels';
import type { ChatProvider } from './ipc-channels';

/**
 * Shared provider-resolution logic — used by the main chat loop
 * (agent-service.ts) and by any other one-off completion (e.g. summarizing a
 * browsed page) that needs to talk to whichever provider/model is currently
 * configured, without duplicating this lookup.
 */

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const FAIRROUTER_URL = 'https://fairrouter.ai/v1/chat/completions';

export interface ChatProviderConfig {
  provider: ChatProvider;
  url: string;
  apiKey: string;
  model: string;
}

export const PROVIDER_LABEL: Record<ChatProvider, string> = Object.fromEntries(
  CHAT_PROVIDERS.map((p) => [p.id, p.label])
) as Record<ChatProvider, string>;

/** Extra attribution headers OpenRouter reads; meaningless (and skipped) elsewhere. */
export function chatHeaders(provider: ChatProvider): Record<string, string> {
  const base: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider === 'openrouter') {
    base['HTTP-Referer'] = 'https://forge.local';
    base['X-Title'] = 'Forge';
  }
  return base;
}

/**
 * The main chat loop (send/generateTitle/summarizeForCompaction) can run on
 * either provider — media tools (image/vision/music) stay OpenRouter-only.
 * Which one is active is chosen via the model selector, which sets both
 * PROVIDER and that provider's own *_MODEL var so each provider remembers
 * its own last-picked model.
 *
 * Null when the active provider is missing its API key or has no model selected.
 */
export function resolveChatProvider(): ChatProviderConfig | null {
  const provider: ChatProvider = process.env.PROVIDER === 'fairrouter' ? 'fairrouter' : 'openrouter';
  const apiKey = provider === 'fairrouter' ? process.env.FAIRROUTER_API_KEY : process.env.OPENROUTER_API_KEY;
  const model = provider === 'fairrouter' ? process.env.FAIRROUTER_MODEL : process.env.OPENROUTER_MODEL;
  if (!apiKey || !model) return null;
  return { provider, url: provider === 'fairrouter' ? FAIRROUTER_URL : OPENROUTER_URL, apiKey, model };
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
      headers: { Authorization: `Bearer ${cfg.apiKey}`, ...chatHeaders(cfg.provider) },
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
