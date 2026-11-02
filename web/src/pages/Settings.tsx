import { useCallback, useEffect, useState } from 'react';
import { api, type SettingsResponse, type SettingsSchemaEntry } from '../api';
import { Badge, Card, Empty, useToast } from '../ui';

type Draft = Record<string, string | boolean | string[]>;

function toDraft(settings: Record<string, unknown>): Draft {
  const draft: Draft = {};
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'boolean') draft[key] = value;
    else if (Array.isArray(value)) draft[key] = value.map(String);
    else draft[key] = String(value);
  }
  return draft;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

export function Settings() {
  const { push, report } = useToast();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.settings();
      setData(response);
      setDraft(toDraft(response.settings));
    } catch (caught) {
      report(caught, 'Could not load settings.');
    }
  }, [report]);

  useEffect(() => {
    void load();
  }, [load]);

  function coerce(entry: SettingsSchemaEntry, raw: string | boolean | string[]): unknown {
    if (entry.boolean) return typeof raw === 'boolean' ? raw : raw === 'true';
    if (entry.array) return Array.isArray(raw) ? raw : String(raw).split(',').map((value) => value.trim()).filter(Boolean);
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) throw new Error(`${entry.key} must be a number`);
    return Math.round(numeric);
  }

  async function save(key: string) {
    if (!data) return;
    const entry = data.schema.find((candidate) => candidate.key === key);
    if (!entry) return;
    setBusy(true);
    try {
      const value = coerce(entry, draft[key] ?? '');
      const response = await api.updateSettings({ [key]: value });
      setData({ ...data, settings: response.settings });
      setDraft(toDraft(response.settings));
      setEditing(null);
      push('ok', `${key} updated.`);
    } catch (caught) {
      report(caught, `Could not update ${key}.`);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="muted">Loading settings…</div>;
  if (data.schema.length === 0) return <Empty>No configurable settings were reported by the API.</Empty>;

  return (
    <div className="stack">
      <div className="banner banner-info">
        Settings are stored in D1 and cached per isolate for a few seconds. The KV bootstrap cache is cleared on every
        change, so clients pick up new limits on their next refresh. Enforcement always reads D1.
      </div>

      <Card title="Runtime settings">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Setting</th>
                <th>Value</th>
                <th>Default</th>
                <th>Allowed</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.schema.map((entry) => (
                <tr key={entry.key}>
                  <td>
                    <div className="mono">{entry.key}</div>
                    <div className="small muted" style={{ maxWidth: 380 }}>{entry.description}</div>
                  </td>
                  <td style={{ minWidth: 220 }}>
                    {editing?.key === entry.key ? (
                      entry.boolean ? (
                        <select
                          value={String(draft[entry.key] ?? false)}
                          onChange={(event) => setDraft({ ...draft, [entry.key]: event.target.value === 'true' })}
                        >
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : entry.array ? (
                        <input
                          value={Array.isArray(draft[entry.key]) ? (draft[entry.key] as string[]).join(', ') : String(draft[entry.key] ?? '')}
                          onChange={(event) => setDraft({ ...draft, [entry.key]: event.target.value })}
                        />
                      ) : (
                        <input
                          type="number"
                          value={String(draft[entry.key] ?? '')}
                          min={entry.bounds?.min}
                          max={entry.bounds?.max}
                          onChange={(event) => setDraft({ ...draft, [entry.key]: event.target.value })}
                        />
                      )
                    ) : (
                      <div>
                        {entry.boolean ? (
                          <Badge tone={draft[entry.key] === true ? 'ok' : 'muted'}>{String(draft[entry.key])}</Badge>
                        ) : entry.array ? (
                          <div className="pill-row">
                            {(Array.isArray(draft[entry.key]) ? (draft[entry.key] as string[]) : []).map((item) => (
                              <Badge key={item} tone="muted">{item}</Badge>
                            ))}
                          </div>
                        ) : (
                          <div>
                            <span className="mono">{String(draft[entry.key])}</span>
                            {entry.key.toLowerCase().includes('bytes') && Number(draft[entry.key]) > 0 ? (
                              <span className="small muted"> · {formatBytes(Number(draft[entry.key]))}</span>
                            ) : null}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="small muted mono">{String(entry.default)}</td>
                  <td className="small muted">
                    {entry.bounds ? `${entry.bounds.min} – ${entry.bounds.max}` : entry.boolean ? 'true/false' : entry.array ? 'list' : '—'}
                  </td>
                  <td>
                    {editing?.key === entry.key ? (
                      <div className="row">
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => void save(entry.key)} disabled={busy}>
                          {busy ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setEditing(null)} disabled={busy}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="btn btn-sm" onClick={() => setEditing({ key: entry.key, value: String(draft[entry.key]) })}>
                        Change
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Not configurable from this console">
        <dl className="kv">
          <dt>JWT secret</dt>
          <dd>Worker secret. Rotating it signs everybody out; set it with wrangler.</dd>
          <dt>Turnstile keys</dt>
          <dd>Worker secrets plus the public site key published through GET /api/config.</dd>
          <dt>Provider credentials</dt>
          <dd>Named Worker secrets (R2_&lt;REF&gt;_ACCESS_KEY_ID / _SECRET_ACCESS_KEY). Never stored in D1 or shown here.</dd>
          <dt>Bootstrap admin</dt>
          <dd>BOOTSTRAP_ADMIN_EMAIL creates the first administrator once, while no admin exists.</dd>
        </dl>
      </Card>
    </div>
  );
}
