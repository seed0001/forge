import { useEffect, useState } from 'react';
import { useForge } from '../state/store';
import type { ProviderSettings } from '../../electron/ipc-channels';
import { IconCheck, IconEye, IconEyeOff, IconGear, IconX } from './icons';

interface FieldDef {
  key: keyof ProviderSettings;
  label: string;
  placeholder: string;
  secret: boolean;
}

interface ProviderDef {
  id: string;
  name: string;
  blurb: string;
  linkLabel: string;
  linkHref: string;
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
];

const EMPTY: ProviderSettings = {
  OPENROUTER_API_KEY: '',
  SEARCH_API: '',
  TRANSCRIBE_API_KEY: '',
  TRANSCRIBE_BASE_URL: '',
  TRANSCRIBE_MODEL: '',
};

export function SettingsOverlay() {
  const open = useForge((s) => s.settingsOpen);
  const saved = useForge((s) => s.providerSettings);
  const saving = useForge((s) => s.settingsSaving);
  const closeSettings = useForge((s) => s.closeSettings);
  const saveSettings = useForge((s) => s.saveSettings);

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
                        .filter((f) => f.secret)
                        .every((f) => draft[f.key].trim())
                        ? 'var(--green)'
                        : 'var(--fg-3)',
                    }}
                  />
                  <span className="settings-section-name">{provider.name}</span>
                </div>
                <a className="settings-link" href={provider.linkHref} target="_blank" rel="noreferrer">
                  {provider.linkLabel}
                </a>
              </div>
              <div className="settings-section-blurb">{provider.blurb}</div>

              {provider.fields.map((field) => {
                const shown = revealed.has(field.key);
                return (
                  <label key={field.key} className="settings-field">
                    <span className="settings-field-label">{field.label}</span>
                    <div className="settings-input-wrap">
                      <input
                        className="settings-input mono"
                        type={field.secret && !shown ? 'password' : 'text'}
                        value={draft[field.key]}
                        placeholder={field.placeholder}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))}
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
