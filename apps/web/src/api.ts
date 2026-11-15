export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details: unknown;

  public constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function apiBase(): string {
  const configured = (import.meta.env as Record<string, string | undefined>).VITE_API_URL;
  return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : '/api';
}

function csrfToken(): string | null {
  const match = /(?:^|;\s*)t77_csrf=([^;]+)/u.exec(document.cookie);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (method !== 'GET' && method !== 'HEAD') {
    const token = csrfToken();
    if (token !== null) {
      headers['x-csrf-token'] = token;
    }
  }

  const response = await fetch(`${apiBase()}${path}`, {
    method,
    credentials: 'include',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  const payload: unknown =
    text.length === 0
      ? null
      : (() => {
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return null;
          }
        })();

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'T77_ERROR',
      error?.message ?? `Request failed with status ${response.status}.`,
      error?.details,
    );
  }

  return payload as T;
}

export const api = {
  get<T>(path: string): Promise<T> {
    return request<T>('GET', path);
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('POST', path, body ?? {});
  },
  patch<T>(path: string, body: unknown): Promise<T> {
    return request<T>('PATCH', path, body);
  },
  delete<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('DELETE', path, body ?? {});
  },
};

export interface SessionUser {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
}

export interface SessionGuild {
  id: string;
  name: string;
  iconUrl: string | null;
  owner: boolean;
  botPresent: boolean;
}

export interface SessionResponse {
  user: SessionUser;
  csrfToken: string | null;
  expiresAt: string;
  guilds: SessionGuild[];
}

export function formatDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) {
    return '-';
  }
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) {
    return '-';
  }
  const date = typeof value === 'string' ? new Date(value) : value;
  const delta = date.getTime() - Date.now();
  const abs = Math.abs(delta);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
    ['second', 1_000],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (abs >= size || unit === 'second') {
      return formatter.format(Math.round(delta / size), unit);
    }
  }
  return '-';
}
