import { track } from './analytics';
import {
  durationMs,
  playEventProps,
  type PlaySession,
} from './playSession';

const KEY = 'play-analytics-session';
let memorySession: PlaySession | null = null;

function writeSession(session: PlaySession): void {
  memorySession = session;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    /* ignore */
  }
}

function readSession(): PlaySession | null {
  if (memorySession) return memorySession;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PlaySession;
    if (!parsed || !parsed.id || !parsed.startedAt) return null;
    memorySession = parsed;
    return parsed;
  } catch {
    return null;
  }
}

function clearSession(): void {
  memorySession = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function trackPlayStart(input: Omit<PlaySession, 'startedAt'>): void {
  trackPlayEnd('replaced');
  const session: PlaySession = { ...input, startedAt: Date.now() };
  writeSession(session);
  track(session.carrier === 'plugin' ? 'plugin_start' : 'game_start', playEventProps(session));
}

export function trackPlayEnd(reason: string, now = Date.now()): void {
  const session = readSession();
  if (!session) return;
  clearSession();
  const event = session.carrier === 'plugin' ? 'plugin_stop' : 'game_stop';
  track(event, playEventProps(session, {
    duration_ms: durationMs(session.startedAt, now),
    end_reason: reason,
  }));
}
