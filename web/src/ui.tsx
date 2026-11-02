import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from './api';

/* -------------------------------------------------------------------------- */
/* Toasts                                                                      */
/* -------------------------------------------------------------------------- */

type ToastKind = 'ok' | 'error' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  push: (kind: ToastKind, message: string) => void;
  report: (error: unknown, fallback?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let toastId = 0;

export function describeError(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof ApiError) {
    const suffix = error.requestId ? ` (request ${error.requestId.slice(0, 8)})` : '';
    return `${error.message}${suffix}`;
  }
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: ToastKind, message: string) => {
    toastId += 1;
    const id = toastId;
    setToasts((current) => [...current, { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, kind === 'error' ? 9000 : 4200);
  }, []);

  const report = useCallback(
    (error: unknown, fallback?: string) => {
      push('error', describeError(error, fallback));
    },
    [push]
  );

  const value = useMemo(() => ({ push, report }), [push, report]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind === 'error' ? 'toast-error' : toast.kind === 'ok' ? 'toast-ok' : ''}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

/* -------------------------------------------------------------------------- */
/* Layout primitives                                                           */
/* -------------------------------------------------------------------------- */

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          {title ? <h2 className="card-title">{title}</h2> : <span />}
          {actions ? <div className="row">{actions}</div> : null}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}

export type BadgeTone = 'ok' | 'warn' | 'danger' | 'muted' | 'accent';

export function Badge({ tone = 'muted', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const HEALTH_TONES: Record<string, BadgeTone> = {
  healthy: 'ok',
  degraded: 'warn',
  error: 'danger',
  unconfigured: 'warn',
  unknown: 'muted',
};

export function HealthBadge({ status }: { status: string }) {
  return <Badge tone={HEALTH_TONES[status] ?? 'muted'}>{status}</Badge>;
}

const STATUS_TONES: Record<string, BadgeTone> = {
  approved: 'ok',
  published: 'ok',
  pending: 'warn',
  awaiting_review: 'warn',
  initiated: 'muted',
  processing: 'muted',
  uploaded: 'muted',
  rejected: 'danger',
  failed: 'danger',
  removed: 'danger',
  duplicate: 'muted',
  expired: 'muted',
  cancelled: 'muted',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? 'muted'}>{status.replace(/_/g, ' ')}</Badge>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <div className="small muted" style={{ marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dialog                                                                      */
/* -------------------------------------------------------------------------- */

export function Dialog({
  title,
  children,
  onClose,
  onConfirm,
  confirmLabel = 'Confirm',
  confirmTone = 'primary',
  busy = false,
}: {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  onConfirm?: () => void;
  confirmLabel?: string;
  confirmTone?: 'primary' | 'danger';
  busy?: boolean;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>
        {children}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {onConfirm ? (
            <button type="button" className={`btn ${confirmTone === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
              {busy ? 'Working…' : confirmLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

export function Pager({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="row-between" style={{ marginTop: 12 }}>
      <span className="small muted">
        {from}–{to} of {total}
      </span>
      <div className="row">
        <button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          Previous
        </button>
        <button type="button" className="btn btn-sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
          Next
        </button>
      </div>
    </div>
  );
}
