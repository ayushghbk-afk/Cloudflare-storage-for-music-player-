import { useCallback, useEffect, useState } from 'react';
import { api, formatDateTime, type Report } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Dialog, Empty, Field, Pager, StatusBadge, useToast } from '../ui';

const PAGE_SIZE = 20;

export function Reports() {
  const { isAdmin } = useAuth();
  const { push, report } = useToast();

  const [status, setStatus] = useState<'open' | 'resolved' | 'dismissed'>('open');
  const [reports, setReports] = useState<Report[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  const [selected, setSelected] = useState<Report | null>(null);
  const [note, setNote] = useState('');
  const [action, setAction] = useState<'none' | 'unpublish' | 'remove'>('none');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.reports({ status, limit: PAGE_SIZE, offset });
      setReports(response.reports);
      setTotal(response.pagination.total);
    } catch (caught) {
      report(caught, 'Could not load reports.');
    } finally {
      setLoading(false);
    }
  }, [status, offset, report]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(kind: 'resolved' | 'dismissed') {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await api.resolveReport(selected.id, {
        status: kind,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(kind === 'resolved' ? { action } : {}),
      });
      push('ok', `Report ${kind}. Track action: ${result.trackAction}.`);
      setSelected(null);
      setNote('');
      setAction('none');
      await load();
    } catch (caught) {
      report(caught, 'Could not resolve the report.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <Card
        title="Listener reports"
        actions={
          <div className="row">
            <select aria-label="Filter" value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setOffset(0); }} style={{ width: 150 }}>
              <option value="open">open</option>
              <option value="resolved">resolved</option>
              <option value="dismissed">dismissed</option>
            </select>
            <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={loading}>
              Refresh
            </button>
          </div>
        }
      >
        {loading ? (
          <div className="muted">Loading…</div>
        ) : reports.length === 0 ? (
          <Empty>No {status} reports.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Track</th>
                  <th>Reason</th>
                  <th>Reported by</th>
                  <th>Track state</th>
                  <th>When</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{entry.trackTitle ?? entry.trackId}</div>
                      {entry.details ? <div className="small muted" style={{ maxWidth: 340 }}>{entry.details}</div> : null}
                    </td>
                    <td><Badge tone="warn">{entry.reason}</Badge></td>
                    <td className="small">{entry.reporter?.name ?? 'anonymous'}</td>
                    <td><StatusBadge status={entry.trackStatus ?? 'unknown'} /></td>
                    <td className="small muted">{formatDateTime(entry.createdAt)}</td>
                    <td>
                      {entry.status === 'open' ? (
                        <button type="button" className="btn btn-sm" onClick={() => setSelected(entry)}>
                          Resolve
                        </button>
                      ) : (
                        <span className="small muted">{entry.resolutionNote ?? '—'}</span>
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

      {selected ? (
        <Dialog
          title={`Resolve report against “${selected.trackTitle ?? selected.trackId}”`}
          onClose={() => setSelected(null)}
          busy={busy}
        >
          <p className="small muted">
            Unpublishing hides the track everywhere. Removing it is an administrator action and can also delete the stored files.
          </p>
          <Field label="Resolution note">
            <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="What did you verify?" />
          </Field>
          <Field label="Action on the track">
            <select value={action} onChange={(event) => setAction(event.target.value as typeof action)}>
              <option value="none">Leave the track as it is</option>
              <option value="unpublish">Unpublish (reject and make private)</option>
              {isAdmin ? <option value="remove">Remove from the library</option> : null}
            </select>
          </Field>
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setSelected(null)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={() => void resolve('dismissed')} disabled={busy}>
              Dismiss
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void resolve('resolved')} disabled={busy}>
              {busy ? 'Saving…' : 'Resolve'}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
