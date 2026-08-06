import { useState } from "react";
import { PROVIDER_KINDS, type ProviderKind, type ProviderSummary } from "@joystick/shared";
import { useProviders } from "./useQa.js";

/**
 * Add/edit/remove/test providers (B.2, B.4.1).
 *
 * Every add runs the connectivity check server-side before it's saved — this
 * form only has to show whatever `ok`/`detail` comes back, never decide for
 * itself whether a provider is reachable.
 */

export function ProviderSettings({ onClose }: { onClose: () => void }) {
  const { providers, addProvider, testProvider, deleteProvider } = useProviders();
  const [kind, setKind] = useState<ProviderKind>("ollama");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const configFor = (): unknown => {
    if (kind === "claude-cli") return {};
    if (kind === "ollama") return { baseUrl, model };
    return { baseUrl, apiKey, model };
  };

  const handleAdd = async () => {
    setSaving(true);
    setStatus(null);
    const result = await addProvider({ kind, label: label || kind, config: configFor() });
    setStatus(result);
    setSaving(false);
    if (result.ok) {
      setLabel("");
      setApiKey("");
    }
  };

  return (
    <div className="qa-settings">
      <div className="qa-settings-header">
        <span className="qa-settings-title">Providers</span>
        <button className="qa-settings-close" onClick={onClose}>
          close
        </button>
      </div>

      <ul className="qa-provider-list">
        {providers.map((p) => (
          <ProviderRow key={p.id} provider={p} onTest={testProvider} onDelete={deleteProvider} />
        ))}
        {providers.length === 0 && <li className="muted">No providers configured yet.</li>}
      </ul>

      <div className="qa-settings-form">
        <div className="qa-form-row">
          <select value={kind} onChange={(e) => setKind(e.target.value as ProviderKind)}>
            {PROVIDER_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>

        {kind !== "claude-cli" && (
          <div className="qa-form-row">
            <input placeholder="base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            <input placeholder="model" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
        )}
        {kind === "openai-compatible" && (
          <div className="qa-form-row">
            <input
              placeholder="API key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        )}

        <button onClick={handleAdd} disabled={saving}>
          {saving ? "checking…" : "add provider"}
        </button>

        {status && (
          <p className={status.ok ? "qa-status-ok" : "qa-status-fail"}>{status.detail}</p>
        )}
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  onTest,
  onDelete,
}: {
  provider: ProviderSummary;
  onTest: (id: string) => Promise<{ ok: boolean; detail: string }>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);

  return (
    <li className="qa-provider-row">
      <span className="qa-provider-kind">{provider.kind}</span>
      <span className="qa-provider-label">{provider.label}</span>
      <span className={provider.lastVerifiedOk ? "qa-status-ok" : "qa-status-fail"}>
        {provider.lastVerifiedAt
          ? provider.lastVerifiedOk
            ? "verified"
            : "verify failed"
          : "never verified"}
      </span>
      <button onClick={async () => setResult(await onTest(provider.id))}>test</button>
      <button onClick={() => onDelete(provider.id)}>remove</button>
      {result && <span className={result.ok ? "qa-status-ok" : "qa-status-fail"}>{result.detail}</span>}
    </li>
  );
}
