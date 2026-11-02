import { useCallback, useEffect, useState } from 'react';
import { api, formatDateTime, type AdminUser, type Role } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Dialog, Empty, Field, Pager, useToast } from '../ui';

const PAGE_SIZE = 25;

export function Users() {
  const { user } = useAuth();
  const { push, report } = useToast();

  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [nextRole, setNextRole] = useState<Role>('user');
  const [quotaGb, setQuotaGb] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.users({ ...(query.trim() ? { q: query.trim() } : {}), ...(role ? { role } : {}), limit: PAGE_SIZE, offset });
      setUsers(response.users);
      setTotal(response.pagination.total);
    } catch (caught) {
      report(caught, 'Could not load users.');
    } finally {
      setLoading(false);
    }
  }, [query, role, offset, report]);

  useEffect(() => {
    void load();
  }, [load]);

  async function applyRole() {
    if (!editing) return;
    setBusy(true);
    try {
      await api.updateUser(editing.id, {
        role: nextRole,
        ...(quotaGb.trim() ? { uploadQuotaBytes: Math.round(Number(quotaGb) * 1024 * 1024 * 1024) } : {}),
      });
      push('ok', `${editing.email} is now ${nextRole}.`);
      setEditing(null);
      await load();
    } catch (caught) {
      report(caught, 'Could not update the user.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleSuspend(target: AdminUser) {
    const suspend = target.status === 'active';
    if (suspend && !window.confirm(`Suspend ${target.email}? Their sessions are revoked immediately.`)) return;
    try {
      await api.updateUser(target.id, { status: suspend ? 'suspended' : 'active' });
      push('ok', `${target.email} ${suspend ? 'suspended' : 'reactivated'}.`);
      await load();
    } catch (caught) {
      report(caught, 'Could not change the account status.');
    }
  }

  return (
    <div className="stack">
      <Card
        title="Accounts"
        actions={
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              setOffset(0);
              void load();
            }}
          >
            <input
              aria-label="Search users"
              placeholder="Search email or name"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              style={{ width: 220 }}
            />
            <select aria-label="Role filter" value={role} onChange={(event) => { setRole(event.target.value); setOffset(0); }} style={{ width: 140 }}>
              <option value="">all roles</option>
              <option value="user">user</option>
              <option value="moderator">moderator</option>
              <option value="admin">admin</option>
            </select>
            <button type="submit" className="btn btn-sm">
              Search
            </button>
          </form>
        }
      >
        {loading ? (
          <div className="muted">Loading…</div>
        ) : users.length === 0 ? (
          <Empty>No users matched.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Tracks</th>
                  <th>Quota</th>
                  <th>Last login</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div>{entry.email}</div>
                      <div className="small muted">{entry.displayName}</div>
                    </td>
                    <td>
                      <Badge tone={entry.role === 'admin' ? 'accent' : entry.role === 'moderator' ? 'ok' : 'muted'}>{entry.role}</Badge>
                    </td>
                    <td>
                      <Badge tone={entry.status === 'active' ? 'ok' : 'danger'}>{entry.status}</Badge>
                    </td>
                    <td>{entry.trackCount}</td>
                    <td className="small">
                      {entry.uploadQuotaBytes === null ? 'default' : `${(entry.uploadQuotaBytes / 1024 / 1024 / 1024).toFixed(2)} GiB`}
                    </td>
                    <td className="small muted">{formatDateTime(entry.lastLoginAt)}</td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            setEditing(entry);
                            setNextRole(entry.role);
                            setQuotaGb(entry.uploadQuotaBytes === null ? '' : (entry.uploadQuotaBytes / 1024 / 1024 / 1024).toFixed(2));
                          }}
                          disabled={entry.id === user?.id}
                          title={entry.id === user?.id ? 'You cannot change your own role here' : undefined}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={`btn btn-sm ${entry.status === 'active' ? 'btn-danger' : 'btn-ok'}`}
                          disabled={entry.id === user?.id}
                          onClick={() => void toggleSuspend(entry)}
                        >
                          {entry.status === 'active' ? 'Suspend' : 'Reactivate'}
                        </button>
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

      {editing ? (
        <Dialog title={`Edit ${editing.email}`} onClose={() => setEditing(null)} onConfirm={() => void applyRole()} confirmLabel="Save" busy={busy}>
          <Field label="Role">
            <select value={nextRole} onChange={(event) => setNextRole(event.target.value as Role)}>
              <option value="user">user</option>
              <option value="moderator">moderator</option>
              <option value="admin">admin</option>
            </select>
          </Field>
          <Field label="Upload quota (GiB)" hint="Leave empty to use the global default. 0 blocks uploads entirely.">
            <input type="number" min={0} step="0.5" value={quotaGb} onChange={(event) => setQuotaGb(event.target.value)} />
          </Field>
          <p className="small muted">Promoting an account grants access to the review queue immediately: roles are re-read from D1 on every request.</p>
        </Dialog>
      ) : null}
    </div>
  );
}
