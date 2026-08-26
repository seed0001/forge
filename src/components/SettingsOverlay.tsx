import { useEffect, useState } from 'react';
import { useForge } from '../state/store';
import {
  DEFAULT_LLAMACPP_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
  MAX_TOOL_CALLS_DEFAULT,
  MAX_TOOL_CALLS_LIMIT,
  SECRET_SENTINEL,
  type ProviderSettings,
  type PermissionCategory,
  type PermissionLevel,
} from '../../electron/ipc-channels';
import { IconCheck, IconEye, IconEyeOff, IconGear, IconX } from './icons';
import { PortalControl } from './PortalControl';

const PERMISSION_CATEGORIES: { id: PermissionCategory; label: string; blurb: string }[] = [
  { id: 'bash', label: 'Shell commands', blurb: 'run_command — anything the agent executes in the terminal.' },
  { id: 'edit', label: 'File edits', blurb: 'propose_edit — anything the agent writes to a file.' },
  {
    id: 'webfetch',
    label: 'Network & media',
    blurb: 'web_search, generate_image, analyze_image, generate_music — anything that leaves the machine.',
  },
];

const PERMISSION_LEVEL_OPTIONS: { value: PermissionLevel | ''; label: string }[] = [
  { value: '', label: 'Inherit from autonomy level' },
  { value: 'allow', label: 'Always allow' },
  { value: 'ask', label: 'Always ask' },
  { value: 'deny', label: 'Always deny' },
];

interface FieldDef {
  key: keyof ProviderSettings;
  label: string;
  placeholder: string;
  secret: boolean;
  /** Must this be filled before the section counts as "configured" (its status dot)? Defaults to the field's `secret` value — set false for an optional credential, e.g. a local runtime's API key. */
  required?: boolean;
  numeric?: { min: number; max: number };
}

interface ProviderDef {
  id: string;
  name: string;
  blurb: string;
  linkLabel?: string;
  linkHref?: string;
  fields: FieldDef[];
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    blurb: 'Powers chat, image generation, vision, and music tools — one key covers all of them.',
    linkLabel: 'openrouter.ai/keys',
    linkHref: 'https://openrouter.ai/keys',
    fields: [{ key: 'OPENROUTER_API_KEY', label: 'API key', placeholder: 'sk-or-…', secret: true }],
  },
  {
    id: 'fairrouter',
    name: 'FairRouter',
    blurb:
      'An alternative chat model provider, selectable per-model from the model picker alongside OpenRouter. ' +
      'Image generation, vision, and music tools always go through OpenRouter regardless of which one is active.',
    linkLabel: 'fairrouter.ai',
    linkHref: 'https://fairrouter.ai',
    fields: [{ key: 'FAIRROUTER_API_KEY', label: 'API key', placeholder: 'Bearer token…', secret: true }],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    blurb: 'A local Ollama install — no API key needed. Requires an OpenAI-compatible endpoint (Ollama serves one at /v1 by default).',
    linkLabel: 'ollama.com',
    linkHref: 'https://ollama.com',
    fields: [
      { key: 'OLLAMA_BASE_URL', label: 'Base URL', placeholder: DEFAULT_OLLAMA_BASE_URL, secret: false },
      {
        key: 'OLLAMA_API_KEY',
        label: 'API key (optional)',
        placeholder: 'Only if the endpoint requires one',
        secret: true,
        required: false,
      },
    ],
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp',
    blurb: 'A local llama.cpp server (llama-server) — no API key needed. It exposes an OpenAI-compatible endpoint on its own port.',
    linkLabel: 'github.com/ggml-org/llama.cpp',
    linkHref: 'https://github.com/ggml-org/llama.cpp',
    fields: [
      { key: 'LLAMACPP_BASE_URL', label: 'Base URL', placeholder: DEFAULT_LLAMACPP_BASE_URL, secret: false },
      {
        key: 'LLAMACPP_API_KEY',
        label: 'API key (optional)',
        placeholder: 'Only if the endpoint requires one',
        secret: true,
        required: false,
      },
    ],
  },
  {
    id: 'search',
    name: 'Web search',
    blurb: 'A Tavily key, used by the web_search tool.',
    linkLabel: 'app.tavily.com',
    linkHref: 'https://app.tavily.com',
    fields: [{ key: 'SEARCH_API', label: 'API key', placeholder: 'tvly-…', secret: true }],
  },
  {
    id: 'transcribe',
    name: 'Voice input',
    blurb: 'Any OpenAI-compatible /audio/transcriptions endpoint — Groq (fast, free tier) by default.',
    linkLabel: 'console.groq.com/keys',
    linkHref: 'https://console.groq.com/keys',
    fields: [
      { key: 'TRANSCRIBE_API_KEY', label: 'API key', placeholder: 'gsk_…', secret: true },
      {
        key: 'TRANSCRIBE_BASE_URL',
        label: 'Base URL',
        placeholder: 'https://api.groq.com/openai/v1',
        secret: false,
      },
      { key: 'TRANSCRIBE_MODEL', label: 'Model', placeholder: 'whisper-large-v3', secret: false },
    ],
  },
  {
    id: 'agent',
    name: 'Agent behavior',
    blurb: `How many tool calls (file reads, edits, commands, searches...) the agent may make in a single task before it stops itself. Default is ${MAX_TOOL_CALLS_DEFAULT}, max ${MAX_TOOL_CALLS_LIMIT}.`,
    fields: [
      {
        key: 'MAX_TOOL_CALLS',
        label: 'Max tool calls per task',
        placeholder: `${MAX_TOOL_CALLS_DEFAULT} (default)`,
        secret: false,
        numeric: { min: 1, max: MAX_TOOL_CALLS_LIMIT },
      },
      {
        key: 'MAX_COST_PER_TASK_USD',
        label: 'Max spend per task ($)',
        placeholder: 'No limit',
        secret: false,
      },
    ],
  },
];

const EMPTY: ProviderSettings = {
  OPENROUTER_API_KEY: '',
  FAIRROUTER_API_KEY: '',
  OLLAMA_BASE_URL: '',
  OLLAMA_API_KEY: '',
  LLAMACPP_BASE_URL: '',
  LLAMACPP_API_KEY: '',
  SEARCH_API: '',
  TRANSCRIBE_API_KEY: '',
  TRANSCRIBE_BASE_URL: '',
  TRANSCRIBE_MODEL: '',
  MAX_TOOL_CALLS: '',
  MAX_COST_PER_TASK_USD: '',
};

export function SettingsOverlay() {
  const open = useForge((s) => s.settingsOpen);
  const saved = useForge((s) => s.providerSettings);
  const saving = useForge((s) => s.settingsSaving);
  const closeSettings = useForge((s) => s.closeSettings);
  const saveSettings = useForge((s) => s.saveSettings);

  const permOverrides = useForge((s) => s.permOverrides);
  const bashAllowlist = useForge((s) => s.bashAllowlist);
  const setPermOverride = useForge((s) => s.setPermOverride);
  const addAllowlistPattern = useForge((s) => s.addAllowlistPattern);
  const removeAllowlistPattern = useForge((s) => s.removeAllowlistPattern);
  const [allowlistDraft, setAllowlistDraft] = useState('');

  const [draft, setDraft] = useState<ProviderSettings>(EMPTY);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (saved) setDraft(saved);
  }, [saved]);

  if (!open) return null;

  const dirty = saved !== null && (Object.keys(draft) as (keyof ProviderSettings)[]).some((k) => draft[k] !== saved[k]);

  function toggleReveal(key: string) {
    setRevealed((r) => {
      const next = new Set(r);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSave() {
    if (!saved) return;
    const changed: Partial<ProviderSettings> = {};
    for (const k of Object.keys(draft) as (keyof ProviderSettings)[]) {
      if (draft[k] !== saved[k]) changed[k] = draft[k];
    }
    const ok = await saveSettings(changed);
    if (ok) {
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    }
  }

  function handleClose() {
    if (saved) setDraft(saved);
    closeSettings();
  }

  return (
    <div className="overlay">
      <div className="rev-head">
        <IconGear className="icon" />
        <div className="col">
          <div className="rev-title">Settings</div>
          <div className="rev-sub">API keys for every provider Forge talks to, stored in forge/.env</div>
        </div>
        <div className="spacer" />
        <button className="iconbtn" onClick={handleClose} title="Close">
          <IconX className="icon-sm" />
        </button>
      </div>

      <div className="settings-body">
        {!saved ? (
          <div className="modelmenu-note">Loading…</div>
        ) : (
          PROVIDERS.map((provider) => (
            <div key={provider.id} className="settings-section">
              <div className="settings-section-head">
                <div className="row" style={{ gap: 'var(--s2)' }}>
                  <span
                    className="settings-dot"
                    style={{
                      background: provider.fields
                        .filter((f) => f.required ?? f.secret)
                        .every((f) => draft[f.key].trim())
                        ? 'var(--green)'
                        : 'var(--fg-3)',
                    }}
                  />
                  <span className="settings-section-name">{provider.name}</span>
                </div>
                {provider.linkHref && (
                  <a className="settings-link" href={provider.linkHref} target="_blank" rel="noreferrer">
                    {provider.linkLabel}
                  </a>
                )}
              </div>
              <div className="settings-section-blurb">{provider.blurb}</div>

              {provider.fields.map((field) => {
                const shown = revealed.has(field.key);
                // A secret field that still holds the sentinel means the Operator hasn't
                // touched it this session — its real value never left the main process.
                // Show it as empty-with-hint rather than the literal sentinel characters,
                // which would otherwise look like a real (masked) value was just revealed.
                const isSentinel = field.secret && draft[field.key] === SECRET_SENTINEL;
                return (
                  <label key={field.key} className="settings-field">
                    <span className="settings-field-label">{field.label}</span>
                    <div className="settings-input-wrap">
                      <input
                        className="settings-input mono"
                        type={field.numeric ? 'number' : field.secret && !shown ? 'password' : 'text'}
                        min={field.numeric?.min}
                        max={field.numeric?.max}
                        step={field.numeric ? 1 : undefined}
                        value={isSentinel ? '' : draft[field.key]}
                        placeholder={isSentinel ? 'configured — retype to change' : field.placeholder}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) => {
                          let value = e.target.value;
                          if (field.numeric && value) {
                            const n = Math.round(Number(value));
                            if (Number.isFinite(n)) {
                              value = String(Math.min(Math.max(n, field.numeric.min), field.numeric.max));
                            }
                          }
                          setDraft((d) => ({ ...d, [field.key]: value }));
                        }}
                      />
                      {field.secret && (
                        <button
                          type="button"
                          className="settings-eye"
                          onClick={() => toggleReveal(field.key)}
                          title={shown ? 'Hide' : 'Show'}
                          tabIndex={-1}
                        >
                          {shown ? <IconEyeOff className="icon-xs" /> : <IconEye className="icon-xs" />}
                        </button>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          ))
        )}

        {permOverrides && (
          <div className="settings-section">
            <div className="settings-section-head">
              <div className="row" style={{ gap: 'var(--s2)' }}>
                <span className="settings-dot" style={{ background: 'var(--fg-3)' }} />
                <span className="settings-section-name">Permissions</span>
              </div>
            </div>
            <div className="settings-section-blurb">
              Overrides the autonomy slider for one category at a time. Left on "Inherit," a category follows
              whatever Manual/Balanced/Auto already does.
            </div>

            {PERMISSION_CATEGORIES.map((cat) => (
              <label key={cat.id} className="settings-field">
                <span className="settings-field-label">{cat.label}</span>
                <div className="settings-input-wrap">
                  <select
                    className="settings-input"
                    value={permOverrides[cat.id] ?? ''}
                    onChange={(e) => setPermOverride(cat.id, (e.target.value || null) as PermissionLevel | null)}
                  >
                    {PERMISSION_LEVEL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="settings-field-hint">{cat.blurb}</span>
              </label>
            ))}

            <label className="settings-field">
              <span className="settings-field-label">Bash allowlist</span>
              <div className="settings-input-wrap">
                <input
                  className="settings-input mono"
                  type="text"
                  placeholder='e.g. "git status*" — end with * for a prefix match'
                  value={allowlistDraft}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setAllowlistDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && allowlistDraft.trim()) {
                      e.preventDefault();
                      void addAllowlistPattern(allowlistDraft);
                      setAllowlistDraft('');
                    }
                  }}
                />
              </div>
              <span className="settings-field-hint">
                When "Shell commands" is set to Always ask (or inherits Manual), a command matching one of these
                patterns — and containing no chaining characters like ; &amp;&amp; | or $() — runs without prompting.
              </span>
            </label>
            {bashAllowlist.length > 0 && (
              <div className="row" style={{ gap: 'var(--s1)', flexWrap: 'wrap', marginTop: 'var(--s1)' }}>
                {bashAllowlist.map((pattern) => (
                  <span key={pattern} className="allowlist-pattern mono">
                    {pattern}
                    <button type="button" onClick={() => removeAllowlistPattern(pattern)} title="Remove">
                      <IconX className="icon-xs" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <PortalControl />
      </div>

      <div className="rev-foot">
        {justSaved && (
          <div className="row" style={{ gap: 'var(--s1)', color: 'var(--green)', fontSize: 'var(--t-sm)' }}>
            <IconCheck className="icon-xs" />
            Saved — takes effect on the next request, no restart needed
          </div>
        )}
        <div className="spacer" />
        <button className="btn btn-outline" onClick={handleClose}>
          Close
        </button>
        <button className="btn btn-primary" onClick={handleSave} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
