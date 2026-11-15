import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import { api, ApiError } from './api.js';

export interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload(): Promise<void>;
  setData(value: T | null): void;
}

export function useFetch<T>(path: string | null): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    if (path === null) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await api.get<T>(path);
      if (mounted.current) {
        setData(next);
        setError(null);
      }
    } catch (caught) {
      if (mounted.current) {
        setError(
          caught instanceof ApiError
            ? caught.message
            : caught instanceof Error
              ? caught.message
              : 'Request failed.',
        );
      }
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload, setData };
}

export function useGuildId(): string {
  return useParams().guildId ?? '';
}

/**
 * Subscribes to the guild SSE stream. The handler receives every named event;
 * reconnects are delegated to the browser and trigger a REST resync.
 */
export function useGuildEvents(
  guildId: string,
  onEvent: (type: string, payload: unknown) => void,
): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (guildId.length === 0) {
      return;
    }
    const source = new EventSource(`/api/guilds/${guildId}/events`, {
      withCredentials: true,
    });

    const types = [
      'ready',
      'resync',
      'config.updated',
      'module.degraded',
      'incident.opened',
      'incident.closed',
      'beast.activated',
      'beast.deactivated',
      'verification.challenge.issued',
      'backup.updated',
      'backup.restore.previewed',
      'backup.restore.completed',
      'backup.restore.failed',
      'dashboard.action.completed',
      'dashboard.action.failed',
    ];

    const listeners = types.map((type) => {
      const listener = (event: MessageEvent<string>): void => {
        let payload: unknown;
        try {
          payload = JSON.parse(event.data) as unknown;
        } catch {
          payload = event.data;
        }
        handlerRef.current(type, payload);
      };
      source.addEventListener(type, listener as EventListener);
      return { type, listener };
    });

    return () => {
      for (const { type, listener } of listeners) {
        source.removeEventListener(type, listener as EventListener);
      }
      source.close();
    };
  }, [guildId]);
}
