import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export function ShieldMark({ className = 'h-9 w-9' }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 72 72" className={className} role="img" aria-label="T77 shield">
      <defs>
        <linearGradient
          id="t77-shield"
          x1="10"
          y1="4"
          x2="62"
          y2="68"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#ff4554" />
          <stop offset="1" stopColor="#9e0f1c" />
        </linearGradient>
      </defs>
      <path
        d="M36 4 62 14v20c0 15.6-10.2 27.8-26 34C20.2 61.8 10 49.6 10 34V14L36 4Z"
        fill="url(#t77-shield)"
      />
      <path
        d="M36 10 56 18v16c0 12.5-8 22.4-20 27.6C24 56.4 16 46.5 16 34V18l20-8Z"
        fill="#0b0c0f"
        opacity=".82"
      />
      <path d="M24 26h24v5H38v18h-6V31H24v-5Z" fill="#f4f5f7" />
      <path d="M45 38h5v11h-5z" fill="#e11d2e" />
    </svg>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 text-sm text-ash" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-edge-strong border-t-blood" />
      {label}
    </div>
  );
}

export function Card({
  children,
  className = '',
  title,
  description,
  actions,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  description?: string;
  actions?: ReactNode;
}): React.JSX.Element {
  return (
    <section
      className={`rounded-2xl border border-edge bg-panel/85 shadow-[0_1px_0_rgba(255,255,255,.03)_inset] ${className}`}
    >
      {(title !== undefined || actions !== undefined) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-edge px-5 py-4">
          <div>
            {title !== undefined && (
              <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
            )}
            {description !== undefined && (
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ash">{description}</p>
            )}
          </div>
          {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow !== undefined && (
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-blood-soft">
            {eyebrow}
          </p>
        )}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description !== undefined && (
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ash">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  children,
  variant = 'secondary',
  type = 'button',
  disabled,
  onClick,
  className = '',
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}): React.JSX.Element {
  const styles: Record<ButtonVariant, string> = {
    primary:
      'bg-blood text-white hover:bg-blood-soft border-blood/70 shadow-[0_8px_24px_-12px_rgba(225,29,46,.9)]',
    secondary: 'bg-panel-2 text-chalk border-edge-strong hover:border-ash/60 hover:bg-[#1b1e25]',
    ghost: 'bg-transparent text-ash border-transparent hover:text-chalk hover:bg-white/5',
    danger: 'bg-[#2a1013] text-blood-soft border-blood/40 hover:bg-[#3a1419]',
  };
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-semibold tracking-wide transition disabled:cursor-not-allowed disabled:opacity-45 ${styles[variant]} ${className}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info';
}): React.JSX.Element {
  const tones = {
    neutral: 'border-edge-strong bg-white/5 text-ash',
    good: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    bad: 'border-blood/40 bg-blood/10 text-blood-soft',
    info: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  description?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-5 py-3">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {description !== undefined && (
          <span className="mt-0.5 block text-xs leading-relaxed text-ash">{description}</span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition ${
          checked ? 'border-blood bg-blood/80' : 'border-edge-strong bg-[#1d2028]'
        } disabled:opacity-40`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-[22px]' : 'translate-x-1'
          }`}
        />
      </button>
    </label>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em] text-ash">
        {label}
      </span>
      {children}
      {hint !== undefined && <span className="mt-1.5 block text-xs text-ash/80">{hint}</span>}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-edge-strong bg-[#0c0e12] px-3 py-2 text-sm text-chalk placeholder:text-ash/50 focus:border-blood/70 focus:outline-none';

export function TextInput(props: {
  value: string;
  onChange(next: string): void;
  placeholder?: string;
  type?: 'text' | 'url' | 'password';
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <input
      className={inputClass}
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

export function NumberInput(props: {
  value: number;
  onChange(next: number): void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <input
      className={inputClass}
      type="number"
      value={Number.isFinite(props.value) ? props.value : ''}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      disabled={props.disabled}
      onChange={(event) => props.onChange(Number(event.target.value))}
    />
  );
}

export function TextArea(props: {
  value: string;
  onChange(next: string): void;
  rows?: number;
  placeholder?: string;
}): React.JSX.Element {
  return (
    <textarea
      className={inputClass}
      rows={props.rows ?? 4}
      value={props.value}
      placeholder={props.placeholder}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

export function Select<T extends string>(props: {
  value: T;
  onChange(next: T): void;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <select
      className={inputClass}
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value as T)}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}): React.JSX.Element {
  const color =
    tone === 'good'
      ? 'text-emerald-300'
      : tone === 'warn'
        ? 'text-amber-300'
        : tone === 'bad'
          ? 'text-blood-soft'
          : 'text-chalk';
  return (
    <div className="rounded-xl border border-edge bg-[#0d0f13] px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ash">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>{value}</p>
      {hint !== undefined && <p className="mt-0.5 text-xs text-ash">{hint}</p>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-edge-strong px-6 py-10 text-center">
      <p className="text-sm font-semibold">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ash">{description}</p>
      {action !== undefined && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-blood/40 bg-blood/10 px-4 py-3 text-sm text-blood-soft">
      {message}
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
  children?: ReactNode;
}): React.JSX.Element | null {
  const titleId = useId();
  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg rounded-2xl border border-edge-strong bg-panel p-6 shadow-2xl"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ash">{description}</p>
        {children !== undefined && <div className="mt-4">{children}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working...' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface Toast {
  id: number;
  message: string;
  tone: 'success' | 'error' | 'info';
}

const ToastContext = createContext<((message: string, tone?: Toast['tone']) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-3), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4_500);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[min(92vw,380px)] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-xl ${
              toast.tone === 'error'
                ? 'border-blood/50 bg-[#2a1013] text-blood-soft'
                : toast.tone === 'success'
                  ? 'border-emerald-500/40 bg-[#0d1f18] text-emerald-200'
                  : 'border-edge-strong bg-panel text-chalk'
            }`}
            role="status"
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (message: string, tone?: Toast['tone']) => void {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error('useToast must be used inside ToastProvider.');
  }
  return context;
}
