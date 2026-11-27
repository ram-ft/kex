import crypto from 'node:crypto';
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';

export const RESERVED_USERNAMES = new Set([
  'api',
  'app',
  'assets',
  'auth',
  'dashboard',
  'explore',
  'favicon.ico',
  'health',
  'index.html',
  'login',
  'login.html',
  'logout',
  'media',
  'new',
  'profile',
  'public',
  'reset',
  'robots.txt',
  'settings',
  'signup',
  'src',
  'static',
  'u',
  'user',
  'users',
]);

export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
export const REPO_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidUsername(username: string): boolean {
  const lower = username.toLowerCase();
  if (!USERNAME_RE.test(lower)) return false;
  if (lower.includes('--')) return false;
  if (RESERVED_USERNAMES.has(lower)) return false;
  return true;
}

export function isValidRepoName(name: string): boolean {
  if (!REPO_NAME_RE.test(name)) return false;
  if (name === '.' || name === '..' || name.includes('..')) return false;
  return true;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, hex] = parts;
  if (!salt || !hex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function setSessionCookie(res: Response, token: string, maxAgeSeconds: number): void {
  const cookie = [
    `kex_session=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Partitioned',
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
}

export function clearSessionCookie(res: Response): void {
  const cookie = [
    'kex_session=',
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Partitioned',
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
}

export function verifyCsrfIfCookieAuth(req: Request): boolean {
  const hasBearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ');
  if (hasBearer) return true;
  if (req.headers['x-requested-with'] === 'XMLHttpRequest') return true;
  const origin = req.headers.origin;
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  if (origin && host) {
    try {
      const originUrl = new URL(origin);
      return originUrl.host === host;
    } catch {
      return false;
    }
  }
  return !origin;
}

/**
 * Normalize and validate a repository relative path.
 * Rejects traversal (`..`), absolute paths, backslashes-only escapes, null bytes, and invalid segments.
 */
export function normalizeRelativePath(rawPath: string): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof rawPath !== 'string') {
    return { ok: false, error: 'Path must be a string.' };
  }
  if (rawPath.includes('\0')) {
    return { ok: false, error: 'Path contains null bytes.' };
  }
  const replaced = rawPath.replace(/\\/g, '/').trim();
  if (!replaced) {
    return { ok: false, error: 'Path cannot be empty.' };
  }
  if (replaced.startsWith('/') || /^[a-zA-Z]:/.test(replaced)) {
    return { ok: false, error: `Absolute paths are not allowed: ${rawPath}` };
  }
  if (replaced.length > 512) {
    return { ok: false, error: `Path exceeds 512 characters: ${rawPath}` };
  }
  const segments = replaced.split('/');
  const cleanSegments: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      return { ok: false, error: `Invalid or traversal path segment in: ${rawPath}` };
    }
    if (seg.length > 255) {
      return { ok: false, error: `Path segment too long in: ${rawPath}` };
    }
    if (/[\x00-\x1f\x7f]/.test(seg)) {
      return { ok: false, error: `Control characters not allowed in: ${rawPath}` };
    }
    cleanSegments.push(seg);
  }
  return { ok: true, path: cleanSegments.join('/') };
}

/**
 * Normalize an optional directory path query parameter ('' for root).
 */
export function normalizeDirQuery(rawDir: string | undefined): { ok: true; dir: string } | { ok: false; error: string } {
  if (!rawDir || rawDir.trim() === '' || rawDir.trim() === '/') {
    return { ok: true, dir: '' };
  }
  const trimmed = rawDir.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return { ok: true, dir: '' };
  const norm = normalizeRelativePath(trimmed);
  if (!norm.ok) return norm;
  return { ok: true, dir: norm.path };
}

/**
 * Ensure a storage path remains strictly inside baseDir.
 */
export function resolveContainedPath(baseDir: string, relativeStorageKey: string): string {
  const absBase = path.resolve(baseDir);
  const absTarget = path.resolve(absBase, relativeStorageKey);
  if (absTarget !== absBase && !absTarget.startsWith(absBase + path.sep)) {
    throw new Error('Path escapes storage directory.');
  }
  return absTarget;
}

export function validateExternalUrl(rawUrl: string, allowMailto = true): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { ok: false, error: 'URL cannot be empty.' };
  if (trimmed.length > 500) return { ok: false, error: 'URL is too long.' };

  let candidate = trimmed;
  if (allowMailto && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    candidate = `mailto:${trimmed}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: 'Invalid URL format. Use https://, http://, or mailto:.' };
  }

  const allowed = allowMailto ? ['https:', 'http:', 'mailto:'] : ['https:', 'http:'];
  if (!allowed.includes(parsed.protocol)) {
    return { ok: false, error: `Disallowed URL scheme: ${parsed.protocol}` };
  }
  return { ok: true, url: parsed.toString() };
}

export function detectImageMimeFromBytes(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF
  if (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif';
  }
  // WebP
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export function createRateLimiter(windowMs: number, maxRequests: number) {
  const hits = new Map<string, number[]>();
  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const key = `${req.ip || 'unknown'}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((ts) => now - ts < windowMs);
    if (recent.length >= maxRequests) {
      res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) {
      for (const [k, times] of hits.entries()) {
        if (times.every((t) => now - t >= windowMs)) hits.delete(k);
      }
    }
    next();
  };
}
