import { useCallback, useEffect, useState } from 'react';
import { api, formatBytes, formatDateTime, type PlaybackError, type UploadRow } from '../api';
import { Badge, Card, Empty, Pager, StatusBadge, useToast } from '../ui';

const UPLOAD_STATUSES = ['failed', 'awaiting_review', 'initiated', 'processing', 'duplicate', 'rejected', 'published', 'expired'] as const;
const PAGE_SIZE = 25;

export function Uploads() {
  const { report } = useToast();
  const [status, setStatus] = useState<(typeof UPLOAD_STATUSES)[number]>('failed');
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  const [playbackErrors, setPlaybackErrors] = useState<PlaybackError[]>([]);

  const loadUploads = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.uploads({ status, limit: PAGE_SIZE, offset });
      setUploads(response.uploads);
      setTotal(response.pagination.total);
    } catch (caught) {
      report(caught, 'Could not load uploads.');
    } finally {
      setLoading(false);
    }
  }, [status, offset, report]);

  const loadPlaybackErrors = useCallback(async () => {
    try {
      const response = await api.playbackErrors({ limit: 25, offset: 0 });
      setPlaybackErrors(response.errors);
    } catch (caught) {
      report(caught, 'Could not load playback errors.');
    }
  }, [report]);

  useEffect(() => {
    void loadUploads();
  }, [loadUploads]);

  useEffect(() => {
    void loadPlaybackErrors();
  }, [loadPlaybackErrors]);

  return (
    <div className="stack">
      <Card
        title="Upload jobs"
        actions={
          <div className="row">
            <select
              aria-label="Upload status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as (typeof UPLOAD_STATUSES)[number]);
                setOffset(0);
              }}
              style={{ width: 180 }}
            >
              {UPLOAD_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-sm" onClick={() => void loadUploads()} disabled={loading}>
              Refresh
            </button>
          </div>
        }
      >
        {loading ? (
          <div className="muted">Loading…</div>
        ) : uploads.length === 0 ? (
          <Empty>No {status.replace(/_/g, ' ')} uploads.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Uploader</th>
                  <th>Status</th>
                  <th>Size</th>
                  <th>Error</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {uploads.map((upload) => (
                  <tr key={upload.id}>
                    <td>
                      <div className="mono">{upload.filename}</div>
                      <div className="small muted mono">{upload.id}</div>
                    </td>
                    <td className="small">
                      {upload.uploader?.email ?? '—'}
                      {upload.uploader?.name ? <div className="small muted">{upload.uploader.name}</div> : null}
                    </td>
                    <td>
                      <StatusBadge status={upload.status} />
                      {upload.trackId ? <div className="small muted mono">{upload.trackId}</div> : null}
                    </td>
                    <td className="small">
                      {formatBytes(upload.uploadedSizeBytes ?? upload.declaredSizeBytes)}
                      {upload.uploadedSizeBytes !== null && upload.uploadedSizeBytes !== upload.declaredSizeBytes ? (
                        <div className="small muted">declared {formatBytes(upload.declaredSizeBytes)}</div>
                      ) : null}
                    </td>
                    <td>
                      {upload.errorCode ? (
                        <>
                          <Badge tone="danger">{upload.errorCode}</Badge>
                          {upload.errorMessage ? <div className="small muted" style={{ maxWidth: 300 }}>{upload.errorMessage}</div> : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="small muted">{formatDateTime(upload.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager total={total} limit={PAGE_SIZE} offset={offset} onChange={setOffset} />
      </Card>

      <Card
        title="Playback errors reported by players"
        actions={
          <button type="button" className="btn btn-sm" onClick={() => void loadPlaybackErrors()}>
            Refresh
          </button>
        }
      >
        {playbackErrors.length === 0 ? (
          <Empty>No playback errors reported.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Track</th>
                  <th>Code</th>
                  <th>Platform</th>
                  <th>Message</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {playbackErrors.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div>{entry.trackTitle ?? entry.trackId ?? 'unknown'}</div>
                      {entry.trackId ? <div className="small muted mono">{entry.trackId}</div> : null}
                    </td>
                    <td>{entry.code ? <Badge tone="warn">{entry.code}</Badge> : '—'}</td>
                    <td className="small">{entry.platform ?? '—'}</td>
                    <td className="small muted" style={{ maxWidth: 380 }}>{entry.message ?? '—'}</td>
                    <td className="small muted">{formatDateTime(entry.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
