import { useCallback, useEffect, useState } from 'react';
import { api, formatBytes, formatDateTime, type StatsResponse } from '../api';
import { Badge, Card, Empty, HealthBadge, Stat, useToast } from '../ui';

export function Overview({ onNavigate }: { onNavigate: (route: string) => void }) {
  const { report } = useToast();
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.stats());
      setError(null);
    } catch (caught) {
      report(caught, 'Could not load the dashboard.');
      setError('The dashboard could not be loaded.');
    }
  }, [report]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (error) return <div className="banner">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;

  const { stats, storage, recentFailures } = data;

  return (
    <div className="stack">
      <div className="grid grid-stats">
        <Stat label="Public tracks" value={stats.publicTracks} hint={`${stats.totalTracks} tracks in total`} />
        <Stat
          label="Awaiting review"
          value={stats.pendingTracks}
          hint={
            stats.pendingTracks > 0 ? (
              <a href="#/review">Open the review queue →</a>
            ) : (
              'Nothing waiting'
            )
          }
        />
        <Stat label="Open reports" value={stats.openReports} hint={`${stats.rejectedTracks} rejected · ${stats.removedTracks} removed`} />
        <Stat label="Users" value={stats.totalUsers} hint={`${stats.newUsers7d} new in the last 7 days`} />
        <Stat label="Storage used" value={formatBytes(stats.storageUsedBytes)} hint={`${stats.storageObjectCount} stored objects`} />
        <Stat
          label="Failed uploads (7d)"
          value={stats.failedUploads7d}
          hint={stats.failedUploads7d > 0 ? <a href="#/uploads">Inspect failures →</a> : 'No failures this week'}
        />
      </div>

      <div className="grid grid-2">
        <Card
          title="Storage providers"
          actions={
            <button type="button" className="btn btn-sm" onClick={() => onNavigate('storage')}>
              Manage
            </button>
          }
        >
          {storage.providers.length === 0 ? (
            <Empty>
              No providers registered yet. Register one at{' '}
              <span className="mono">POST /api/admin/storage/providers</span> so uploads have somewhere to go.
            </Empty>
          ) : (
            <div className="stack">
              <div className="pill-row">
                <Badge tone="ok">{storage.healthy} healthy</Badge>
                {storage.degraded > 0 ? <Badge tone="warn">{storage.degraded} degraded</Badge> : null}
                {storage.errored > 0 ? <Badge tone="danger">{storage.errored} error</Badge> : null}
                {storage.unconfigured > 0 ? <Badge tone="warn">{storage.unconfigured} unconfigured</Badge> : null}
                {storage.unknown > 0 ? <Badge tone="muted">{storage.unknown} unknown</Badge> : null}
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Health</th>
                      <th>Used</th>
                      <th>Capacity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {storage.providers.map((provider) => (
                      <tr key={provider.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{provider.name}</div>
                          <div className="small muted mono">{provider.bucketName}</div>
                        </td>
                        <td>
                          <HealthBadge status={provider.healthStatus} />
                          {provider.healthMessage && provider.healthStatus !== 'healthy' ? (
                            <div className="small muted" style={{ maxWidth: 260 }}>{provider.healthMessage}</div>
                          ) : null}
                        </td>
                        <td>
                          <div>{formatBytes(provider.usedBytes)}</div>
                          <div className="small muted">{provider.objectCount} objects</div>
                        </td>
                        <td>{provider.capacityBytes === null ? <span className="muted">not recorded</span> : formatBytes(provider.capacityBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="small muted" style={{ margin: 0 }}>
                Capacity is only shown when an administrator records the real provider entitlement. AETHER never infers or pools free tiers.
              </p>
            </div>
          )}
        </Card>

        <Card title="Recent failures">
          {recentFailures.length === 0 ? (
            <Empty>No failed uploads recorded.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Code</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {recentFailures.map((failure) => (
                    <tr key={failure.id}>
                      <td className="mono">{failure.filename}</td>
                      <td>{failure.errorCode ? <Badge tone="danger">{failure.errorCode}</Badge> : '—'}</td>
                      <td className="small muted">{formatDateTime(failure.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-3">
        <Card title="Listening activity">
          <div className="kv">
            <dt>Plays (24h)</dt>
            <dd>{stats.plays24h}</dd>
            <dt>Playback errors (24h)</dt>
            <dd>{stats.playbackErrors24h}</dd>
            <dt>Active uploads</dt>
            <dd>{stats.activeUploads}</dd>
          </div>
        </Card>
        <Card title="Publishing policy">
          <p className="small muted" style={{ marginTop: 0 }}>
            Uploads are stored privately and only appear in the public library after a moderator approves them and the
            uploader has confirmed the rights to the audio.
          </p>
          <button type="button" className="btn btn-sm" onClick={() => onNavigate('review')}>
            Review uploads
          </button>
        </Card>
        <Card title="This console">
          <p className="small muted" style={{ marginTop: 0 }}>
            The console administers the AETHER library; playback stays in the existing AETHER web and Android players.
            Credential values are never sent to this page — only the names of missing secrets.
          </p>
        </Card>
      </div>
    </div>
  );
}
