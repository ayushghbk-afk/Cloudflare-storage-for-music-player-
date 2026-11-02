import { useCallback, useEffect, useState } from 'react';
import { api, formatBytes, formatDateTime, type AdminTrack } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Dialog, Empty, Field, Pager, StatusBadge, useToast } from '../ui';

const STATUSES = ['pending', 'approved', 'rejected', 'removed'] as const;
const PAGE_SIZE = 20;

export function Moderation() {
  const { isAdmin } = useAuth();
  const { push, report } = useToast();

  const [status, setStatus] = useState<(typeof STATUSES)[number]>('pending');
  const [tracks, setTracks] = useState<AdminTrack[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [rejecting, setRejecting] = useState<AdminTrack | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [removing, setRemoving] = useState<AdminTrack | null>(null);
  const [removeReason, setRemoveReason] = useState('');
  const [removeFiles, setRemoveFiles] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.tracks({ status, limit: PAGE_SIZE, offset });
      setTracks(response.tracks);
      setTotal(response.pagination.total);
    } catch (caught) {
      report(caught, 'Could not load tracks.');
    } finally {
      setLoading(false);
    }
  }, [status, offset, report]);

  useEffect(() => {
    void load();
  }, [load]);

  async function approve(track: AdminTrack) {
    setBusyId(track.id);
    try {
      await api.approveTrack(track.id);
      push('ok', `“${track.title}” is now public.`);
      await load();
    } catch (caught) {
      report(caught, 'Approval failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function submitReject() {
    if (!rejecting) return;
    setBusyId(rejecting.id);
    try {
      await api.rejectTrack(rejecting.id, rejectReason.trim());
      push('ok', `“${rejecting.title}” was rejected.`);
      setRejecting(null);
      setRejectReason('');
      await load();
    } catch (caught) {
      report(caught, 'Rejection failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function submitRemove() {
    if (!removing) return;
    setBusyId(removing.id);
    try {
      const result = await api.removeTrack(removing.id, removeReason.trim(), removeFiles);
      if (result.deletionFailures.length > 0) {
        push('info', `Track removed, but ${result.deletionFailures.length} stored file(s) could not be deleted.`);
      } else {
        push('ok', removeFiles ? 'Track removed and files deleted.' : 'Track removed. Stored files were kept.');
      }
      setRemoving(null);
      setRemoveReason('');
      setRemoveFiles(false);
      await load();
    } catch (caught) {
      report(caught, 'Removal failed.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="stack">
      <Card
        title="Catalogue review"
        actions={
          <div className="row">
            <select
              aria-label="Filter by status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as (typeof STATUSES)[number]);
                setOffset(0);
              }}
              style={{ width: 160 }}
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={loading}>
              Refresh
            </button>
          </div>
        }
      >
        {loading ? (
          <div className="muted">Loading…</div>
        ) : tracks.length === 0 ? (
          <Empty>{status === 'pending' ? 'The review queue is empty.' : `No ${status} tracks.`}</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Track</th>
                  <th>Uploader</th>
                  <th>Format</th>
                  <th>Status</th>
                  <th>Rights</th>
                  <th>Submitted</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((track) => (
                  <tr key={track.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{track.title}</div>
                      <div className="small muted">
                        {track.artist?.name ?? 'Unknown artist'}
                        {track.album ? ` · ${track.album.title}` : ''}
                      </div>
                      {/* Native preview so staff can audition before publishing. */}
                      <audio className="audio-preview" controls preload="none" src={track.streamUrl}>
                        <track kind="captions" />
                      </audio>
                    </td>
                    <td className="small">{track.uploader?.name ?? track.uploader?.id ?? '—'}</td>
                    <td>
                      <div className="mono">{track.format.toUpperCase()}</div>
                      <div className="small muted">
                        {formatBytes(track.sizeBytes)}
                        {track.durationMs ? ` · ${Math.round(track.durationMs / 1000)}s` : ''}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={track.status} />
                      {track.rejectionReason ? <div className="small muted" style={{ maxWidth: 200 }}>{track.rejectionReason}</div> : null}
                    </td>
                    <td>{track.rightsConfirmed ? <Badge tone="ok">confirmed</Badge> : <Badge tone="warn">missing</Badge>}</td>
                    <td className="small muted">{formatDateTime(track.createdAt)}</td>
                    <td>
                      <div className="row" style={{ flexWrap: 'wrap' }}>
                        {track.status !== 'approved' ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-ok"
                            disabled={busyId === track.id || track.rightsConfirmed === false}
                            title={track.rightsConfirmed ? 'Publish to the public library' : 'The uploader has not confirmed rights'}
                            onClick={() => void approve(track)}
                          >
                            Approve
                          </button>
                        ) : null}
                        {track.status === 'pending' ? (
                          <button type="button" className="btn btn-sm btn-danger" disabled={busyId === track.id} onClick={() => setRejecting(track)}>
                            Reject
                          </button>
                        ) : null}
                        {isAdmin ? (
                          <button type="button" className="btn btn-sm" disabled={busyId === track.id} onClick={() => setRemoving(track)}>
                            Remove
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager total={total} limit={PAGE_SIZE} offset={offset} onChange={setOffset} />
      </Card>

      {rejecting ? (
        <Dialog
          title={`Reject “${rejecting.title}”?`}
          onClose={() => setRejecting(null)}
          onConfirm={() => void submitReject()}
          confirmLabel="Reject upload"
          confirmTone="danger"
          busy={busyId === rejecting.id}
        >
          <p className="small muted">The uploader sees this reason. The file stays private and is never served publicly.</p>
          <Field label="Reason (required)">
            <textarea rows={3} value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} maxLength={500} />
          </Field>
        </Dialog>
      ) : null}

      {removing ? (
        <Dialog
          title={`Remove “${removing.title}”?`}
          onClose={() => setRemoving(null)}
          onConfirm={() => void submitRemove()}
          confirmLabel={removeFiles ? 'Remove and delete files' : 'Remove from library'}
          confirmTone="danger"
          busy={busyId === removing.id}
        >
          <p className="small muted">
            The track becomes unreachable and is soft-deleted so the audit trail survives. Reference takedown notices in the reason.
          </p>
          <Field label="Reason (required)">
            <textarea rows={3} value={removeReason} onChange={(event) => setRemoveReason(event.target.value)} maxLength={500} />
          </Field>
          <label className="row" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13 }}>
            <input type="checkbox" checked={removeFiles} onChange={(event) => setRemoveFiles(event.target.checked)} style={{ width: 'auto' }} />
            Also delete the stored audio and artwork from storage
          </label>
        </Dialog>
      ) : null}
    </div>
  );
}
