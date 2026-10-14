import { normalizeRoomCode, ROOM_CODE_PATTERN } from '../shared/types.js';

/** Returns a valid room code from untrusted input (query/body), or undefined. */
export function roomFromQuery(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // Tolerate gateways that append "?x=y" to a URL that already had a query string.
  const code = normalizeRoomCode(raw.split(/[?&#]/)[0]);
  return ROOM_CODE_PATTERN.test(code) ? code : undefined;
}

/** Adds ?room=CODE (or &room=CODE) to an absolute or path-relative URL. */
export function withRoomParam(url: string, roomCode: string | undefined): string {
  if (!roomCode) return url;
  const isAbsolute = /^https?:\/\//i.test(url);
  const parsed = new URL(url, 'http://placeholder.local');
  parsed.searchParams.set('room', roomCode);
  return isAbsolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
