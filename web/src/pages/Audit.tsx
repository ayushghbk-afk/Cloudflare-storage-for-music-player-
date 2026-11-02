import { useCallback, useEffect, useState } from 'react';
import { api, formatDateTime, type AuditEntry } from '../api';
import { Badge, Card, Empty, Pager, useToast } from '../ui';

const PAGE_SIZE = 50;

const KNOWN_ACTIONS = [
  'track.approved',
  'track.rejected',
  'track.removed',
  'report.resolved',
  'storage.provider_created',
  'storage.provider_updated',
  'storage.provider_deleted',
  'storage.health_checked',
  'storage.object_verified',
  'storage.migration_completed',
  'settings.updated',
  'user.role_changed',
  'user.suspended',
  'upload.initiated',
  'upload.completed',
  'playlist.updated',
  'playlist.deleted',
];

export function Audit() {
  const { report } = useToast();
  const [action, setAction] = useState('');
  const [actorId, setActorId] = useState('');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.audit({
        ...(action ? { action } : {}),
        ...(actorId.trim() ? { actorId: actorId.trim() } : {}),
        limit: PAGE_SIZE,
        offset,
      });
      setEntries(response.entries);
      setTotal(response.pagination.total);
    } catch (caught) {
      report(caught, 'Could not load the audit log.');
    } finally {
      setLoading(false);
    }
  }, [action, actorId, offset, report]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="stack">
      <Card
        title="Audit log"
        actions={
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              setOffset(0);
              void load();
            }}
          >
            <select aria-label="Action filter" value={action} onChange={(event) => { setAction(event.target.value); setOffset(0); }} style={{ width: 230 }}>
              <option value="">all actions</option>
              {KNOWN_ACTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <input
              aria-label="Actor user id"
              placeholder="actor user id"
              value={actorId}
              onChange={(event) => setActorId(event.target.value)}
              style={{ width: 200 }}
            />
            <button type="submit" className="btn btn-sm">
              Filter
            </button>
          </form>
        }
      >
        {loading ? (
          <div className="muted">Loading…</div>
        ) : entries.length === 0 ? (
          <Empty>No audit entries matched.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Target</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(entry.createdAt)}</td>
                    <td><Badge tone="accent">{entry.action}</Badge></td>
                    <td className="small">
                      {entry.actor?.email ?? entry.actor?.id ?? 'system'}
                      {entry.ipHash ? <div className="small muted mono">ip {entry.ipHash.slice(0, 10)}…</div> : null}
                    </td>
                    <td className="small">
                      {entry.target ? (
                        <>
                          <div>{entry.target.type ?? '—'}</div>
                          <div className="mono muted">{entry.target.id}</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td style={{ maxWidth: 420 }}>
                      {entry.metadata ? (
                        <details>
                          <summary>view</summary>
                          <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>
                            {JSON.stringify(entry.metadata, null, 2)}
                          </pre>
                        </details>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager total={total} limit={PAGE_SIZE} offset={offset} onChange={setOffset} />
      </Card>
    </div>
  );
}
