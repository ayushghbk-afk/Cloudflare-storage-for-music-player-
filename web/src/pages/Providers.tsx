import { useCallback, useEffect, useState } from 'react';
import { api, formatBytes, formatDateTime, type StorageListResponse, type StorageProvider } from '../api';
import { Badge, Card, Dialog, Empty, Field, HealthBadge, Stat, useToast } from '../ui';

interface ProviderForm {
  name: string;
  kind: 'r2' | 's3';
  accountId: string;
  bucketName: string;
  endpoint: string;
  region: string;
  authMode: 'credentials' | 'binding';
  credentialRef: string;
  priority: string;
  capacityBytes: string;
  notes: string;
}

const EMPTY_FORM: ProviderForm = {
  name: '',
  kind: 'r2',
  accountId: '',
  bucketName: '',
  endpoint: '',
  region: 'auto',
  authMode: 'credentials',
  credentialRef: '',
  priority: '100',
  capacityBytes: '',
  notes: '',
};

export function Providers() {
  const { push, report } = useToast();
  const [data, setData] = useState<StorageListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [editing, setEditing] = useState<StorageProvider | null>(null);
  const [deleting, setDeleting] = useState<StorageProvider | null>(null);
  const [verifying, setVerifying] = useState<StorageProvider | null>(null);
  const [trackId, setTrackId] = useState('');
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [migrating, setMigrating] = useState<StorageProvider | null>(null);
  const [migrateTrackId, setMigrateTrackId] = useState('');
  const [deleteSource, setDeleteSource] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.storage());
    } catch (caught) {
      report(caught, 'Could not load storage providers.');
    } finally {
      setLoading(false);
    }
  }, [report]);

  useEffect(() => {
    void load();
  }, [load]);

  function update<K extends keyof ProviderForm>(key: K, value: ProviderForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submitCreate() {
    setBusy(true);
    try {
      const response = await api.createProvider({
        name: form.name.trim(),
        kind: form.kind,
        ...(form.accountId.trim() ? { accountId: form.accountId.trim() } : {}),
        bucketName: form.bucketName.trim(),
        endpoint: form.endpoint.trim(),
        region: form.region.trim() || undefined,
        authMode: form.authMode,
        ...(form.authMode === 'credentials' ? { credentialRef: form.credentialRef.trim() } : {}),
        priority: Number(form.priority) || 100,
        enabled: true,
        capacityBytes: form.capacityBytes.trim() ? Number(form.capacityBytes) : null,
        ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
      });
      push(
        response.health.status === 'healthy' ? 'ok' : 'info',
        `Provider “${response.provider.name}” registered — health: ${response.health.status}. ${response.health.message}`
      );
      setCreating(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (caught) {
      report(caught, 'Could not register the provider.');
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    try {
      await api.updateProvider(editing.id, {
        priority: Number(form.priority) || editing.priority,
        capacityBytes: form.capacityBytes.trim() ? Number(form.capacityBytes) : null,
        notes: form.notes.trim() ? form.notes.trim() : null,
        bucketName: form.bucketName.trim(),
      });
      push('ok', 'Provider updated.');
      setEditing(null);
      await load();
    } catch (caught) {
      report(caught, 'Could not update the provider.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(provider: StorageProvider) {
    setBusy(true);
    try {
      await api.updateProvider(provider.id, { enabled: !provider.enabled });
      push('ok', `Provider ${provider.enabled ? 'disabled' : 'enabled'}.`);
      await load();
    } catch (caught) {
      report(caught, 'Could not change the provider state.');
    } finally {
      setBusy(false);
    }
  }

  async function check(provider: StorageProvider) {
    setBusy(true);
    try {
      const response = await api.checkProvider(provider.id);
      push(response.health.status === 'healthy' ? 'ok' : 'error', `${provider.name}: ${response.health.status} — ${response.health.message}`);
      await load();
    } catch (caught) {
      report(caught, 'Health check failed.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteProvider(deleting.id);
      push('ok', 'Provider deleted.');
      setDeleting(null);
      await load();
    } catch (caught) {
      report(caught, 'Could not delete the provider.');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setVerifyResult(null);
    try {
      const response = await api.verifyTrack(trackId.trim());
      setVerifyResult(
        response.result.ok
          ? `Hash matches the recorded value (${response.result.actualSha256.slice(0, 16)}…).`
          : `Mismatch! Stored hash ${response.result.expectedSha256?.slice(0, 16) ?? 'unknown'}…, computed ${response.result.actualSha256.slice(0, 16)}…. The object was flagged corrupt.`
      );
    } catch (caught) {
      report(caught, 'Verification failed.');
    } finally {
      setBusy(false);
    }
  }

  async function migrate() {
    if (!migrating) return;
    setBusy(true);
    try {
      const response = await api.migrateTrack(migrateTrackId.trim(), migrating.id, deleteSource);
      push(
        'ok',
        `Moved ${formatBytes(response.result.bytes)} to ${migrating.name}${response.result.deletedSource ? ' and deleted the source copy' : ''}.`
      );
      setMigrating(null);
      setMigrateTrackId('');
      await load();
    } catch (caught) {
      report(caught, 'Migration failed.');
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <div className="muted">Loading storage…</div>;
  if (!data) return <div className="banner">Storage information could not be loaded.</div>;

  const { summary, providers } = data;

  return (
    <div className="stack">
      <div className="grid grid-stats">
        <Stat label="Providers" value={summary.providerCount} hint={`${summary.enabledCount} enabled`} />
        <Stat label="Objects" value={summary.objectCount} hint={formatBytes(summary.totalUsedBytes)} />
        <Stat
          label="Total capacity"
          value={summary.totalCapacityBytes === null ? 'not recorded' : formatBytes(summary.totalCapacityBytes)}
          hint={`${summary.providersWithRecordedCapacity}/${summary.providerCount} providers report capacity`}
        />
      </div>

      <div className="banner banner-info">{data.note}</div>

      <Card
        title="Providers"
        actions={
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={busy}>
              Refresh
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                setForm(EMPTY_FORM);
                setCreating(true);
              }}
            >
              Add provider
            </button>
          </div>
        }
      >
        {providers.length === 0 ? (
          <Empty>No providers yet. Uploads return 503 until at least one provider is enabled and healthy.</Empty>
        ) : (
          <div className="stack">
            {providers.map((provider) => {
              const utilisation = provider.usage.utilisation;
              return (
                <div key={provider.id} className="card" style={{ boxShadow: 'none', background: 'var(--bg-panel-2)' }}>
                  <div className="row-between" style={{ marginBottom: 10 }}>
                    <div>
                      <div className="row">
                        <strong>{provider.name}</strong>
                        <HealthBadge status={provider.health.status} />
                        {provider.enabled ? <Badge tone="accent">enabled</Badge> : <Badge tone="muted">disabled</Badge>}
                        <Badge tone="muted">{provider.authMode}</Badge>
                        <Badge tone="muted">priority {provider.priority}</Badge>
                      </div>
                      <div className="small muted mono">
                        {provider.kind.toUpperCase()} · {provider.bucketName} · {provider.endpoint}
                      </div>
                    </div>
                    <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <button type="button" className="btn btn-sm" onClick={() => void check(provider)} disabled={busy}>
                        Check health
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => void toggleEnabled(provider)} disabled={busy}>
                        {provider.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setEditing(provider);
                          setForm({
                            name: provider.name,
                            kind: provider.kind,
                            accountId: provider.accountId ?? '',
                            bucketName: provider.bucketName,
                            endpoint: provider.endpoint,
                            region: provider.region,
                            authMode: provider.authMode,
                            credentialRef: provider.credentialRef ?? '',
                            priority: String(provider.priority),
                            capacityBytes: provider.capacityBytes === null ? '' : String(provider.capacityBytes),
                            notes: provider.notes ?? '',
                          });
                        }}
                      >
                        Edit
                      </button>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeleting(provider)} disabled={busy}>
                        Delete
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-3">
                    <div>
                      <div className="stat-label">Used</div>
                      <div>{formatBytes(provider.usage.usedBytes)}</div>
                      <div className="small muted">{provider.usage.objectCount} objects</div>
                      {utilisation !== null ? (
                        <>
                          <div className="meter" style={{ marginTop: 8 }}>
                            <div className="meter-fill" style={{ width: `${Math.min(100, Math.max(2, utilisation * 100))}%` }} />
                          </div>
                          <div className="small muted">{(utilisation * 100).toFixed(2)}% of {formatBytes(provider.capacityBytes)}</div>
                        </>
                      ) : (
                        <div className="small muted" style={{ marginTop: 6 }}>
                          Capacity not recorded — figures are never inferred.
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="stat-label">Credentials</div>
                      {provider.credentials.available ? (
                        <Badge tone="ok">available</Badge>
                      ) : (
                        <Badge tone="warn">missing</Badge>
                      )}
                      {provider.credentials.missingSecrets.length > 0 ? (
                        <div className="small muted mono" style={{ marginTop: 4 }}>
                          {provider.credentials.missingSecrets.join(', ')}
                        </div>
                      ) : (
                        <div className="small muted">Secrets resolved from the Worker environment.</div>
                      )}
                    </div>
                    <div>
                      <div className="stat-label">Last health check</div>
                      <div className="small">{formatDateTime(provider.health.checkedAt)}</div>
                      <div className="small muted">
                        {provider.health.latencyMs !== null ? `${provider.health.latencyMs} ms · ` : ''}
                        {provider.health.message ?? 'Never checked'}
                      </div>
                    </div>
                  </div>

                  {provider.credentialRef ? (
                    <div className="small muted mono" style={{ marginTop: 8 }}>
                      credential ref: {provider.credentialRef} → R2_{provider.credentialRef.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_ACCESS_KEY_ID
                    </div>
                  ) : null}

                  <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setVerifying(provider);
                        setTrackId('');
                        setVerifyResult(null);
                      }}
                    >
                      Verify object integrity
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setMigrating(provider);
                        setMigrateTrackId('');
                        setDeleteSource(false);
                      }}
                    >
                      Migrate a track here
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {creating ? (
        <Dialog title="Register a storage provider" onClose={() => setCreating(false)} onConfirm={() => void submitCreate()} confirmLabel="Register & probe" busy={busy}>
          <ProviderFields form={form} update={update} includeName />
          <p className="small muted">
            Registration probes the bucket immediately. A provider whose secrets are missing is reported as
            <strong> unconfigured</strong>, never as healthy.
          </p>
        </Dialog>
      ) : null}

      {editing ? (
        <Dialog title={`Edit ${editing.name}`} onClose={() => setEditing(null)} onConfirm={() => void saveEdit()} confirmLabel="Save" busy={busy}>
          <Field label="Bucket name">
            <input value={form.bucketName} onChange={(event) => update('bucketName', event.target.value)} />
          </Field>
          <Field label="Priority (lower is tried first)">
            <input type="number" min={0} max={10000} value={form.priority} onChange={(event) => update('priority', event.target.value)} />
          </Field>
          <Field label="Capacity in bytes" hint="Leave empty unless you know the provider's real entitlement. AETHER never guesses.">
            <input type="number" min={0} value={form.capacityBytes} onChange={(event) => update('capacityBytes', event.target.value)} />
          </Field>
          <Field label="Notes">
            <textarea rows={2} value={form.notes} onChange={(event) => update('notes', event.target.value)} maxLength={1000} />
          </Field>
        </Dialog>
      ) : null}

      {deleting ? (
        <Dialog
          title={`Delete provider “${deleting.name}”?`}
          onClose={() => setDeleting(null)}
          onConfirm={() => void remove()}
          confirmLabel="Delete provider"
          confirmTone="danger"
          busy={busy}
        >
          <p className="small muted">
            Deletion is refused while objects still reference this provider. Migrate those tracks first, or disable the
            provider to stop new uploads without orphaning stored audio.
          </p>
        </Dialog>
      ) : null}

      {verifying ? (
        <Dialog title={`Verify integrity on ${verifying.name}`} onClose={() => setVerifying(null)} busy={busy}>
          <Field label="Track ID" hint="The Worker streams the object and recomputes its SHA-256.">
            <input value={trackId} onChange={(event) => setTrackId(event.target.value)} placeholder="trk_…" />
          </Field>
          {verifyResult ? <div className={`banner ${verifyResult.startsWith('Hash matches') ? 'banner-info' : ''}`}>{verifyResult}</div> : null}
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setVerifying(null)} disabled={busy}>
              Close
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void verify()} disabled={busy || trackId.trim().length < 3}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
          </div>
        </Dialog>
      ) : null}

      {migrating ? (
        <Dialog title={`Migrate a track to ${migrating.name}`} onClose={() => setMigrating(null)} busy={busy}>
          <Field label="Track ID">
            <input value={migrateTrackId} onChange={(event) => setMigrateTrackId(event.target.value)} placeholder="trk_…" />
          </Field>
          <label className="row" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13, marginBottom: 8 }}>
            <input type="checkbox" checked={deleteSource} onChange={(event) => setDeleteSource(event.target.checked)} style={{ width: 'auto' }} />
            Delete the source copy after the verified copy exists
          </label>
          <p className="small muted">
            The track ID never changes, so playlists, favourites, history and Android Media3 caches stay valid. Objects larger
            than the migration limit must be copied with <span className="mono">scripts/storage-copy.mjs</span>.
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setMigrating(null)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void migrate()} disabled={busy || migrateTrackId.trim().length < 3}>
              {busy ? 'Migrating…' : 'Migrate'}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function ProviderFields({
  form,
  update,
  includeName,
}: {
  form: ProviderForm;
  update: <K extends keyof ProviderForm>(key: K, value: ProviderForm[K]) => void;
  includeName?: boolean;
}) {
  return (
    <>
      {includeName ? (
        <Field label="Name" hint="3–40 lowercase letters, digits, - or _">
          <input value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="secondary-r2" />
        </Field>
      ) : null}
      <div className="row" style={{ gap: 12 }}>
        <div style={{ flex: 1 }}>
          <Field label="Kind">
            <select value={form.kind} onChange={(event) => update('kind', event.target.value as 'r2' | 's3')}>
              <option value="r2">Cloudflare R2</option>
              <option value="s3">S3-compatible</option>
            </select>
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Auth mode">
            <select value={form.authMode} onChange={(event) => update('authMode', event.target.value as 'credentials' | 'binding')}>
              <option value="credentials">credentials (S3 API)</option>
              <option value="binding">binding (MUSIC_BUCKET)</option>
            </select>
          </Field>
        </div>
      </div>
      <Field label="Bucket name">
        <input value={form.bucketName} onChange={(event) => update('bucketName', event.target.value)} placeholder="aether-music-secondary" />
      </Field>
      <Field label="Endpoint" hint="Account root without a bucket path, e.g. https://<account>.r2.cloudflarestorage.com">
        <input value={form.endpoint} onChange={(event) => update('endpoint', event.target.value)} placeholder="https://<account>.r2.cloudflarestorage.com" />
      </Field>
      <div className="row" style={{ gap: 12 }}>
        <div style={{ flex: 1 }}>
          <Field label="Account ID (optional)">
            <input value={form.accountId} onChange={(event) => update('accountId', event.target.value)} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Region">
            <input value={form.region} onChange={(event) => update('region', event.target.value)} placeholder="auto" />
          </Field>
        </div>
      </div>
      {form.authMode === 'credentials' ? (
        <Field label="Credential reference" hint="Names the Worker secrets R2_<REF>_ACCESS_KEY_ID and R2_<REF>_SECRET_ACCESS_KEY. Values never touch the database.">
          <input value={form.credentialRef} onChange={(event) => update('credentialRef', event.target.value)} placeholder="secondary" />
        </Field>
      ) : null}
      <div className="row" style={{ gap: 12 }}>
        <div style={{ flex: 1 }}>
          <Field label="Priority">
            <input type="number" min={0} max={10000} value={form.priority} onChange={(event) => update('priority', event.target.value)} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Capacity (bytes, optional)">
            <input type="number" min={0} value={form.capacityBytes} onChange={(event) => update('capacityBytes', event.target.value)} />
          </Field>
        </div>
      </div>
      <Field label="Notes (optional)">
        <textarea rows={2} value={form.notes} onChange={(event) => update('notes', event.target.value)} maxLength={1000} />
      </Field>
    </>
  );
}
