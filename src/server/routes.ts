import crypto from 'node:crypto';
import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import type { KexDb } from './db.ts';
import { LocalObjectStorage } from './storage.ts';
import { renderSafeMarkdown } from './markdown.ts';
import {
  EMAIL_RE,
  clearSessionCookie,
  createRateLimiter,
  detectImageMimeFromBytes,
  generateToken,
  hashPassword,
  hashToken,
  isValidRepoName,
  isValidUsername,
  normalizeDirQuery,
  normalizeRelativePath,
  parseCookies,
  setSessionCookie,
  validateExternalUrl,
  verifyCsrfIfCookieAuth,
  verifyPassword,
} from './security.ts';

export interface AuthUser {
  id: string;
  username: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser | null;
      sessionToken?: string | null;
    }
  }
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const MAX_UPLOAD_FILES = 250;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_BATCH_BYTES = 50 * 1024 * 1024; // 50 MB per request
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per profile image
const MAX_TEXT_VIEW_BYTES = 1024 * 1024; // 1 MB text viewer cap

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.tgz', '.7z', '.rar', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.pyc', '.class',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi',
  '.db', '.sqlite', '.sqlite3', '.pack',
]);

const TEXT_MIME_MAP: Record<string, string> = {
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.scss': 'text/css',
  '.svelte': 'text/plain',
  '.vue': 'text/plain',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.sh': 'text/x-shellscript',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.toml': 'text/toml',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.env': 'text/plain',
  '.sql': 'text/sql',
  '.csv': 'text/csv',
};

function guessContentType(filePath: string, provided?: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_MIME_MAP[ext]) return TEXT_MIME_MAP[ext];
  if (provided && typeof provided === 'string' && provided.length < 120) return provided;
  return 'application/octet-stream';
}

function isBinaryBuffer(filePath: string, buf: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTS.has(ext)) return true;
  const checkLen = Math.min(buf.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function sanitizeDownloadFilename(name: string): string {
  const base = path.basename(name).replace(/["\\\r\n\0]/g, '_');
  return base || 'file';
}

function buildHeatmapDays(db: KexDb, userId: string): Array<{ date: string; count: number; level: number }> {
  const totalDays = 26 * 7; // 182 days
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const startDate = new Date(today.getTime() - (totalDays - 1) * 86400000);
  const startIso = startDate.toISOString().slice(0, 10);

  const rows = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS cnt
       FROM activity_events
       WHERE user_id = ? AND substr(created_at, 1, 10) >= ?
       GROUP BY substr(created_at, 1, 10)`
    )
    .all(userId, startIso) as Array<{ day: string; cnt: number }>;

  const countMap = new Map<string, number>();
  for (const r of rows) countMap.set(r.day, Number(r.cnt));

  const out: Array<{ date: string; count: number; level: number }> = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startDate.getTime() + i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    const count = countMap.get(iso) || 0;
    let level = 0;
    if (count >= 10) level = 4;
    else if (count >= 5) level = 3;
    else if (count >= 2) level = 2;
    else if (count >= 1) level = 1;
    out.push({ date: iso, count, level });
  }
  return out;
}

export function createApiRouter(db: KexDb, storage: LocalObjectStorage) {
  const router = express.Router();

  const authRateLimit = createRateLimiter(60_000, 25);
  const writeRateLimit = createRateLimiter(60_000, 60);
  const uploadRateLimit = createRateLimiter(60_000, 20);

  const uploadRepoFiles = multer({
    storage: multer.memoryStorage(),
    limits: {
      files: MAX_UPLOAD_FILES,
      fileSize: MAX_FILE_BYTES,
    },
  });

  const uploadProfileImg = multer({
    storage: multer.memoryStorage(),
    limits: {
      files: 1,
      fileSize: MAX_IMAGE_BYTES,
    },
  });

  // Attach authenticated user if present
  router.use((req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    let token: string | null = null;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies.kex_session) token = cookies.kex_session;
    }

    req.user = null;
    req.sessionToken = null;
    if (token) {
      const tokenHash = hashToken(token);
      const nowIso = new Date().toISOString();
      const row = db
        .prepare(
          `SELECT u.id, u.username, u.email
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ?`
        )
        .get(tokenHash, nowIso) as AuthUser | undefined;
      if (row) {
        req.user = row;
        req.sessionToken = token;
      }
    }
    next();
  });

  // CSRF / Origin protection for cookie-authenticated mutations
  router.use((req: Request, res: Response, next: NextFunction) => {
    const method = req.method.toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      if (!verifyCsrfIfCookieAuth(req)) {
        res.status(403).json({ error: 'Cross-origin request blocked.' });
        return;
      }
    }
    next();
  });

  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    next();
  }

  function createSessionForUser(res: Response, userId: string): string {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
    db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(crypto.randomUUID(), userId, tokenHash, expiresAt, now.toISOString());
    setSessionCookie(res, token, SESSION_TTL_SECONDS);
    return token;
  }

  function recordActivity(userId: string, eventType: string, targetName: string): void {
    db.prepare(
      `INSERT INTO activity_events (id, user_id, event_type, target_name, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(crypto.randomUUID(), userId, eventType, targetName, new Date().toISOString());
  }

  // ---- Health & Stats ----
  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/stats', (_req, res) => {
    const pubRepos = (db.prepare(`SELECT COUNT(*) AS c FROM repositories WHERE visibility = 'public'`).get() as { c: number }).c;
    const pubFiles = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM repository_files rf
           JOIN repositories r ON r.id = rf.repository_id
           WHERE r.visibility = 'public'`
        )
        .get() as { c: number }
    ).c;
    const devs = (db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c;
    const readmes = (
      db.prepare(`SELECT COUNT(*) AS c FROM profile_readmes WHERE trim(markdown_content) != ''`).get() as { c: number }
    ).c;
    res.json({
      publicRepositories: Number(pubRepos),
      publicFiles: Number(pubFiles),
      developers: Number(devs),
      profileReadmes: Number(readmes),
    });
  });

  // ---- Auth ----
  router.post('/auth/signup', authRateLimit, (req, res) => {
    const usernameRaw = String(req.body?.username || '').trim().toLowerCase();
    const emailRaw = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const displayNameRaw = String(req.body?.displayName || '').trim();

    if (!isValidUsername(usernameRaw)) {
      res.status(400).json({ error: 'Username must be 3–32 lowercase letters, numbers, or single hyphens.' });
      return;
    }
    if (!EMAIL_RE.test(emailRaw) || emailRaw.length > 254) {
      res.status(400).json({ error: 'Enter a valid email address.' });
      return;
    }
    if (password.length < 8 || password.length > 128) {
      res.status(400).json({ error: 'Password must be between 8 and 128 characters.' });
      return;
    }

    const existing = db
      .prepare(`SELECT id, username, email FROM users WHERE username = ? OR email = ?`)
      .get(usernameRaw, emailRaw) as { id: string; username: string; email: string } | undefined;

    if (existing) {
      if (existing.username.toLowerCase() === usernameRaw) {
        res.status(409).json({ error: 'That username is already taken.' });
      } else {
        res.status(409).json({ error: 'An account with that email already exists.' });
      }
      return;
    }

    const userId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const pwHash = hashPassword(password);
    const displayName = (displayNameRaw || usernameRaw).slice(0, 80);

    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO users (id, username, email, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(userId, usernameRaw, emailRaw, pwHash, nowIso);

      db.prepare(
        `INSERT INTO profiles (user_id, display_name, bio, updated_at)
         VALUES (?, ?, '', ?)`
      ).run(userId, displayName, nowIso);

      db.prepare(
        `INSERT INTO profile_readmes (user_id, markdown_content, updated_at)
         VALUES (?, '', ?)`
      ).run(userId, nowIso);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    recordActivity(userId, 'account_created', usernameRaw);
    const token = createSessionForUser(res, userId);

    res.status(201).json({
      user: { id: userId, username: usernameRaw, email: emailRaw, displayName },
      token,
    });
  });

  router.post('/auth/login', authRateLimit, (req, res) => {
    const identifier = String(req.body?.identifier || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!identifier || !password) {
      res.status(400).json({ error: 'Enter your username/email and password.' });
      return;
    }

    const user = db
      .prepare(
        `SELECT u.id, u.username, u.email, u.password_hash, p.display_name
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE u.username = ? OR u.email = ?`
      )
      .get(identifier, identifier) as
      | { id: string; username: string; email: string; password_hash: string; display_name: string | null }
      | undefined;

    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }

    const token = createSessionForUser(res, user.id);
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name || user.username,
      },
      token,
    });
  });

  router.post('/auth/logout', (req, res) => {
    if (req.sessionToken) {
      db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(req.sessionToken));
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.post('/auth/reset-request', authRateLimit, (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: 'Enter a valid email address.' });
      return;
    }
    const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as { id: string } | undefined;
    if (user) {
      const token = generateToken();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      db.prepare(
        `INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(crypto.randomUUID(), user.id, hashToken(token), expiresAt, new Date().toISOString());
    }
    res.json({
      ok: true,
      message: 'If an account matches that email, a password reset instruction has been recorded.',
    });
  });

  // ---- Current User & Profile Management ----
  router.get('/me', requireAuth, (req, res) => {
    const profile = db
      .prepare(`SELECT * FROM profiles WHERE user_id = ?`)
      .get(req.user!.id) as Record<string, unknown> | undefined;
    res.json({
      user: req.user,
      profile: profile || {
        user_id: req.user!.id,
        display_name: req.user!.username,
        bio: '',
        location: '',
        location_public: 0,
        website: '',
        website_public: 0,
        public_contact: '',
        public_contact_public: 0,
      },
    });
  });

  router.patch('/me/profile', requireAuth, writeRateLimit, (req, res) => {
    const userId = req.user!.id;
    const body = req.body || {};

    const currentProfile = db.prepare(`SELECT * FROM profiles WHERE user_id = ?`).get(userId) as Record<string, unknown>;
    let nextUsername = req.user!.username;

    if (body.username !== undefined) {
      const candidate = String(body.username).trim().toLowerCase();
      if (candidate !== req.user!.username) {
        if (!isValidUsername(candidate)) {
          res.status(400).json({ error: 'Username must be 3–32 lowercase letters, numbers, or single hyphens.' });
          return;
        }
        const conflict = db
          .prepare(`SELECT id FROM users WHERE username = ? AND id != ?`)
          .get(candidate, userId) as { id: string } | undefined;
        if (conflict) {
          res.status(409).json({ error: 'That username is already taken.' });
          return;
        }
        nextUsername = candidate;
      }
    }

    const displayName = body.display_name !== undefined
      ? String(body.display_name).trim().slice(0, 80)
      : String(currentProfile?.display_name || req.user!.username);
    if (!displayName) {
      res.status(400).json({ error: 'Display name cannot be empty.' });
      return;
    }

    const bio = body.bio !== undefined ? String(body.bio).trim().slice(0, 600) : String(currentProfile?.bio || '');
    const location = body.location !== undefined ? String(body.location).trim().slice(0, 120) : String(currentProfile?.location || '');
    const locationPublic = body.location_public !== undefined ? (body.location_public ? 1 : 0) : Number(currentProfile?.location_public || 0);

    let website = body.website !== undefined ? String(body.website).trim().slice(0, 300) : String(currentProfile?.website || '');
    if (website) {
      const check = validateExternalUrl(website, false);
      if (!check.ok) {
        res.status(400).json({ error: `Website: ${check.error}` });
        return;
      }
      website = check.url;
    }
    const websitePublic = body.website_public !== undefined ? (body.website_public ? 1 : 0) : Number(currentProfile?.website_public || 0);

    const publicContact = body.public_contact !== undefined
      ? String(body.public_contact).trim().slice(0, 180)
      : String(currentProfile?.public_contact || '');
    const publicContactPublic = body.public_contact_public !== undefined
      ? (body.public_contact_public ? 1 : 0)
      : Number(currentProfile?.public_contact_public || 0);

    const nowIso = new Date().toISOString();

    db.exec('BEGIN');
    try {
      if (nextUsername !== req.user!.username) {
        db.prepare(`UPDATE users SET username = ? WHERE id = ?`).run(nextUsername, userId);
      }
      db.prepare(
        `UPDATE profiles
         SET display_name = ?, bio = ?, location = ?, location_public = ?,
             website = ?, website_public = ?, public_contact = ?, public_contact_public = ?, updated_at = ?
         WHERE user_id = ?`
      ).run(
        displayName,
        bio,
        location,
        locationPublic,
        website,
        websitePublic,
        publicContact,
        publicContactPublic,
        nowIso,
        userId
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    recordActivity(userId, 'profile_updated', nextUsername);

    res.json({
      username: nextUsername,
      display_name: displayName,
      bio,
      location,
      location_public: Boolean(locationPublic),
      website,
      website_public: Boolean(websitePublic),
      public_contact: publicContact,
      public_contact_public: Boolean(publicContactPublic),
      updated_at: nowIso,
    });
  });

  // ---- Profile README.md (separate from Repository README) ----
  router.put('/me/profile/readme', requireAuth, writeRateLimit, (req, res) => {
    const userId = req.user!.id;
    const markdown = String(req.body?.markdown_content ?? '');
    if (markdown.length > 50_000) {
      res.status(400).json({ error: 'Profile README exceeds 50,000 characters.' });
      return;
    }
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO profile_readmes (user_id, markdown_content, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET markdown_content = excluded.markdown_content, updated_at = excluded.updated_at`
    ).run(userId, markdown, nowIso);

    recordActivity(userId, 'profile_readme_updated', req.user!.username);
    res.json({
      markdown_content: markdown,
      rendered_html: renderSafeMarkdown(markdown),
      updated_at: nowIso,
    });
  });

  router.post('/markdown/preview', requireAuth, (req, res) => {
    const markdown = String(req.body?.markdown_content ?? '').slice(0, 50_000);
    res.json({ rendered_html: renderSafeMarkdown(markdown) });
  });

  // ---- Selected Profile Images (NO avatars) ----
  router.post('/me/profile/images', requireAuth, uploadRateLimit, (req, res) => {
    uploadProfileImg.single('image')(req, res, (err) => {
      if (err) {
        res.status(400).json({ error: err.message || 'Image upload failed.' });
        return;
      }
      const userId = req.user!.id;
      const imageType = String(req.body?.image_type || '').trim();
      const caption = String(req.body?.caption || '').trim().slice(0, 140);

      if (!['banner', 'featured', 'gallery'].includes(imageType)) {
        res.status(400).json({ error: 'image_type must be banner, featured, or gallery.' });
        return;
      }
      if (!req.file || !req.file.buffer) {
        res.status(400).json({ error: 'Please select an image file.' });
        return;
      }

      const detectedMime = detectImageMimeFromBytes(req.file.buffer);
      if (!detectedMime) {
        res.status(400).json({ error: 'Unsupported image format. Upload PNG, JPEG, WebP, or GIF.' });
        return;
      }

      const ext = detectedMime.split('/')[1] === 'jpeg' ? 'jpg' : detectedMime.split('/')[1];

      if (imageType === 'gallery') {
        const count = (
          db
            .prepare(`SELECT COUNT(*) AS c FROM profile_images WHERE user_id = ? AND image_type = 'gallery'`)
            .get(userId) as { c: number }
        ).c;
        if (Number(count) >= 6) {
          res.status(400).json({ error: 'Gallery supports up to 6 images. Remove one before adding another.' });
          return;
        }
      }

      const storageKey = storage.createProfileImageStorageKey(userId, ext);
      storage.writeObject(storageKey, req.file.buffer);

      const newId = crypto.randomUUID();
      const nowIso = new Date().toISOString();

      let oldKeysToDelete: string[] = [];
      db.exec('BEGIN');
      try {
        if (imageType === 'banner' || imageType === 'featured') {
          const olds = db
            .prepare(`SELECT id, storage_key FROM profile_images WHERE user_id = ? AND image_type = ?`)
            .all(userId, imageType) as Array<{ id: string; storage_key: string }>;
          oldKeysToDelete = olds.map((o) => o.storage_key);
          db.prepare(`DELETE FROM profile_images WHERE user_id = ? AND image_type = ?`).run(userId, imageType);
        }

        const nextOrder =
          imageType === 'gallery'
            ? Number(
                (
                  db
                    .prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM profile_images WHERE user_id = ? AND image_type = 'gallery'`)
                    .get(userId) as { n: number }
                ).n
              )
            : 0;

        db.prepare(
          `INSERT INTO profile_images (id, user_id, image_type, storage_key, mime_type, size_bytes, caption, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(newId, userId, imageType, storageKey, detectedMime, req.file.buffer.length, caption, nextOrder, nowIso);
        db.exec('COMMIT');
      } catch (dbErr) {
        db.exec('ROLLBACK');
        storage.deleteObject(storageKey);
        throw dbErr;
      }

      for (const oldKey of oldKeysToDelete) {
        storage.deleteObject(oldKey);
      }

      res.status(201).json({
        id: newId,
        image_type: imageType,
        url: `/api/profile-images/${newId}`,
        mime_type: detectedMime,
        size_bytes: req.file.buffer.length,
        caption,
        created_at: nowIso,
      });
    });
  });

  router.delete('/me/profile/images/:id', requireAuth, writeRateLimit, (req, res) => {
    const imgId = String(req.params.id || '');
    const row = db
      .prepare(`SELECT id, user_id, storage_key FROM profile_images WHERE id = ?`)
      .get(imgId) as { id: string; user_id: string; storage_key: string } | undefined;

    if (!row || row.user_id !== req.user!.id) {
      res.status(404).json({ error: 'Image not found.' });
      return;
    }

    db.prepare(`DELETE FROM profile_images WHERE id = ? AND user_id = ?`).run(imgId, req.user!.id);
    storage.deleteObject(row.storage_key);
    res.json({ ok: true });
  });

  router.get('/profile-images/:id', (req, res) => {
    const imgId = String(req.params.id || '');
    const row = db
      .prepare(`SELECT storage_key, mime_type FROM profile_images WHERE id = ?`)
      .get(imgId) as { storage_key: string; mime_type: string } | undefined;

    if (!row || !storage.exists(row.storage_key)) {
      res.status(404).json({ error: 'Image not found.' });
      return;
    }

    const buf = storage.readObject(row.storage_key);
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  });

  // ---- Social Links ----
  router.put('/me/profile/social-links', requireAuth, writeRateLimit, (req, res) => {
    const links = Array.isArray(req.body?.links) ? req.body.links : null;
    if (!links) {
      res.status(400).json({ error: 'links array is required.' });
      return;
    }
    if (links.length > 12) {
      res.status(400).json({ error: 'Maximum of 12 social links allowed.' });
      return;
    }

    const ALLOWED_PLATFORMS = new Set([
      'github', 'linkedin', 'x', 'youtube', 'website', 'portfolio', 'email', 'custom',
    ]);

    const normalized: Array<{ id: string; platform: string; label: string; url: string; sort_order: number }> = [];
    for (let i = 0; i < links.length; i++) {
      const item = links[i] || {};
      const platform = String(item.platform || 'custom').trim().toLowerCase();
      if (!ALLOWED_PLATFORMS.has(platform)) {
        res.status(400).json({ error: `Invalid platform: ${platform}` });
        return;
      }
      const label = String(item.label || platform).trim().slice(0, 60);
      const urlCheck = validateExternalUrl(String(item.url || ''), true);
      if (!urlCheck.ok) {
        res.status(400).json({ error: `Link ${i + 1}: ${urlCheck.error}` });
        return;
      }
      normalized.push({
        id: crypto.randomUUID(),
        platform,
        label: label || platform,
        url: urlCheck.url,
        sort_order: i,
      });
    }

    const userId = req.user!.id;
    db.exec('BEGIN');
    try {
      db.prepare(`DELETE FROM social_links WHERE user_id = ?`).run(userId);
      const stmt = db.prepare(
        `INSERT INTO social_links (id, user_id, platform, label, url, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const l of normalized) {
        stmt.run(l.id, userId, l.platform, l.label, l.url, l.sort_order);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    res.json({ links: normalized });
  });

  // ---- Public Developer Profile ----
  router.get('/users/:username', (req, res) => {
    const username = String(req.params.username || '').trim().toLowerCase();
    const userRow = db
      .prepare(
        `SELECT u.id, u.username, u.created_at,
                p.display_name, p.bio, p.location, p.location_public,
                p.website, p.website_public, p.public_contact, p.public_contact_public, p.updated_at
         FROM users u
         JOIN profiles p ON p.user_id = u.id
         WHERE u.username = ?`
      )
      .get(username) as Record<string, unknown> | undefined;

    if (!userRow) {
      res.status(404).json({ error: 'Developer profile not found.' });
      return;
    }

    const userId = String(userRow.id);
    const isOwner = Boolean(req.user && req.user.id === userId);

    const images = (
      db
        .prepare(
          `SELECT id, image_type, mime_type, size_bytes, caption, sort_order, created_at
           FROM profile_images WHERE user_id = ? ORDER BY image_type, sort_order ASC`
        )
        .all(userId) as Array<Record<string, unknown>>
    ).map((img) => ({
      ...img,
      url: `/api/profile-images/${img.id}`,
    }));

    const socialLinks = db
      .prepare(
        `SELECT id, platform, label, url, sort_order
         FROM social_links WHERE user_id = ? ORDER BY sort_order ASC`
      )
      .all(userId);

    const readmeRow = db
      .prepare(`SELECT markdown_content, updated_at FROM profile_readmes WHERE user_id = ?`)
      .get(userId) as { markdown_content: string; updated_at: string } | undefined;

    const markdownContent = readmeRow?.markdown_content || '';

    const repos = db
      .prepare(
        `SELECT r.id, r.name, r.description, r.visibility, r.readme_enabled, r.created_at, r.updated_at,
                (SELECT COUNT(*) FROM repository_files rf WHERE rf.repository_id = r.id) AS file_count,
                (SELECT COALESCE(SUM(size_bytes), 0) FROM repository_files rf WHERE rf.repository_id = r.id) AS total_bytes
         FROM repositories r
         WHERE r.owner_id = ? ${isOwner ? '' : "AND r.visibility = 'public'"}
         ORDER BY r.updated_at DESC`
      )
      .all(userId);

    const heatmap = buildHeatmapDays(db, userId);

    res.json({
      isOwner,
      user: {
        id: userId,
        username: userRow.username,
        created_at: userRow.created_at,
      },
      profile: {
        display_name: userRow.display_name,
        bio: userRow.bio,
        location: isOwner || userRow.location_public ? userRow.location : '',
        location_public: Boolean(userRow.location_public),
        website: isOwner || userRow.website_public ? userRow.website : '',
        website_public: Boolean(userRow.website_public),
        public_contact: isOwner || userRow.public_contact_public ? userRow.public_contact : '',
        public_contact_public: Boolean(userRow.public_contact_public),
        updated_at: userRow.updated_at,
      },
      images,
      socialLinks,
      readme: {
        markdown_content: isOwner ? markdownContent : undefined,
        rendered_html: renderSafeMarkdown(markdownContent),
        has_content: markdownContent.trim().length > 0,
        updated_at: readmeRow?.updated_at || null,
      },
      repositories: repos,
      heatmap,
    });
  });

  router.get('/users/:username/readme', (req, res) => {
    const username = String(req.params.username || '').trim().toLowerCase();
    const userRow = db
      .prepare(`SELECT id FROM users WHERE username = ?`)
      .get(username) as { id: string } | undefined;
    if (!userRow) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    const isOwner = Boolean(req.user && req.user.id === userRow.id);
    const readme = db
      .prepare(`SELECT markdown_content, updated_at FROM profile_readmes WHERE user_id = ?`)
      .get(userRow.id) as { markdown_content: string; updated_at: string } | undefined;

    const md = readme?.markdown_content || '';
    res.json({
      rendered_html: renderSafeMarkdown(md),
      ...(isOwner ? { markdown_content: md } : {}),
      updated_at: readme?.updated_at || null,
    });
  });

  // ---- Explore & Repositories ----
  router.get('/explore', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const sort = String(req.query.sort || 'recent');

    let orderClause = 'r.updated_at DESC';
    if (sort === 'name') orderClause = 'r.name ASC';
    else if (sort === 'files') orderClause = 'file_count DESC, r.updated_at DESC';

    const rows = db
      .prepare(
        `SELECT r.id, r.name, r.description, r.visibility, r.readme_enabled, r.created_at, r.updated_at,
                u.username AS owner_username, p.display_name AS owner_display_name,
                (SELECT COUNT(*) FROM repository_files rf WHERE rf.repository_id = r.id) AS file_count,
                (SELECT COALESCE(SUM(size_bytes), 0) FROM repository_files rf WHERE rf.repository_id = r.id) AS total_bytes
         FROM repositories r
         JOIN users u ON u.id = r.owner_id
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE r.visibility = 'public'
           ${q ? 'AND (lower(r.name) LIKE ? OR lower(r.description) LIKE ? OR lower(u.username) LIKE ?)' : ''}
         ORDER BY ${orderClause}
         LIMIT 100`
      )
      .all(...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []));

    res.json({ repositories: rows });
  });

  router.get('/me/repositories', requireAuth, (req, res) => {
    const rows = db
      .prepare(
        `SELECT r.id, r.name, r.description, r.visibility, r.readme_enabled, r.created_at, r.updated_at,
                u.username AS owner_username,
                (SELECT COUNT(*) FROM repository_files rf WHERE rf.repository_id = r.id) AS file_count,
                (SELECT COALESCE(SUM(size_bytes), 0) FROM repository_files rf WHERE rf.repository_id = r.id) AS total_bytes
         FROM repositories r
         JOIN users u ON u.id = r.owner_id
         WHERE r.owner_id = ?
         ORDER BY r.updated_at DESC`
      )
      .all(req.user!.id);

    res.json({ repositories: rows });
  });

  router.post('/repositories', requireAuth, writeRateLimit, (req, res) => {
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim().slice(0, 500);
    const visibility = String(req.body?.visibility || 'public').trim().toLowerCase();
    const readmeEnabled = req.body?.readme_enabled === undefined ? true : Boolean(req.body.readme_enabled);

    if (!isValidRepoName(name)) {
      res.status(400).json({
        error: 'Repository name must start with a letter or number and contain only letters, numbers, ".", "_", or "-" (max 64 chars).',
      });
      return;
    }
    if (visibility !== 'public' && visibility !== 'private') {
      res.status(400).json({ error: 'Visibility must be public or private.' });
      return;
    }

    const duplicate = db
      .prepare(`SELECT id FROM repositories WHERE owner_id = ? AND name = ?`)
      .get(req.user!.id, name) as { id: string } | undefined;
    if (duplicate) {
      res.status(409).json({ error: `You already have a repository named "${name}".` });
      return;
    }

    const repoId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    db.prepare(
      `INSERT INTO repositories (id, owner_id, name, description, visibility, readme_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(repoId, req.user!.id, name, description, visibility, readmeEnabled ? 1 : 0, nowIso, nowIso);

    recordActivity(req.user!.id, 'repo_created', name);

    res.status(201).json({
      repository: {
        id: repoId,
        owner_id: req.user!.id,
        owner_username: req.user!.username,
        name,
        description,
        visibility,
        readme_enabled: readmeEnabled,
        created_at: nowIso,
        updated_at: nowIso,
        file_count: 0,
        total_bytes: 0,
      },
    });
  });

  function loadAuthorizedRepo(req: Request, res: Response, repoId: string) {
    const repo = db
      .prepare(
        `SELECT r.*, u.username AS owner_username, p.display_name AS owner_display_name,
                (SELECT COUNT(*) FROM repository_files rf WHERE rf.repository_id = r.id) AS file_count,
                (SELECT COALESCE(SUM(size_bytes), 0) FROM repository_files rf WHERE rf.repository_id = r.id) AS total_bytes
         FROM repositories r
         JOIN users u ON u.id = r.owner_id
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE r.id = ?`
      )
      .get(repoId) as
      | {
          id: string;
          owner_id: string;
          owner_username: string;
          owner_display_name: string | null;
          name: string;
          description: string;
          visibility: 'public' | 'private';
          readme_enabled: number;
          created_at: string;
          updated_at: string;
          file_count: number;
          total_bytes: number;
        }
      | undefined;

    if (!repo) {
      res.status(404).json({ error: 'Repository not found.' });
      return null;
    }
    const isOwner = Boolean(req.user && req.user.id === repo.owner_id);
    if (repo.visibility === 'private' && !isOwner) {
      res.status(404).json({ error: 'Repository not found.' });
      return null;
    }
    return { repo, isOwner };
  }

  router.get('/repositories/by-slug/:owner/:repo', (req, res) => {
    const ownerUsername = String(req.params.owner || '').trim().toLowerCase();
    const repoName = String(req.params.repo || '').trim();

    const row = db
      .prepare(
        `SELECT r.id
         FROM repositories r
         JOIN users u ON u.id = r.owner_id
         WHERE u.username = ? AND r.name = ?`
      )
      .get(ownerUsername, repoName) as { id: string } | undefined;

    if (!row) {
      res.status(404).json({ error: 'Repository not found.' });
      return;
    }

    const loaded = loadAuthorizedRepo(req, res, row.id);
    if (!loaded) return;

    res.json({
      isOwner: loaded.isOwner,
      repository: {
        ...loaded.repo,
        readme_enabled: Boolean(loaded.repo.readme_enabled),
      },
    });
  });

  router.get('/repositories/:id', (req, res) => {
    const loaded = loadAuthorizedRepo(req, res, String(req.params.id || ''));
    if (!loaded) return;
    res.json({
      isOwner: loaded.isOwner,
      repository: {
        ...loaded.repo,
        readme_enabled: Boolean(loaded.repo.readme_enabled),
      },
    });
  });

  router.patch('/repositories/:id', requireAuth, writeRateLimit, (req, res) => {
    const repoId = String(req.params.id || '');
    const loaded = loadAuthorizedRepo(req, res, repoId);
    if (!loaded) return;
    if (!loaded.isOwner) {
      res.status(403).json({ error: 'Only the repository owner can update settings.' });
      return;
    }

    const body = req.body || {};
    let nextName = loaded.repo.name;
    if (body.name !== undefined) {
      const candidate = String(body.name).trim();
      if (!isValidRepoName(candidate)) {
        res.status(400).json({ error: 'Invalid repository name.' });
        return;
      }
      if (candidate.toLowerCase() !== loaded.repo.name.toLowerCase()) {
        const conflict = db
          .prepare(`SELECT id FROM repositories WHERE owner_id = ? AND name = ? AND id != ?`)
          .get(req.user!.id, candidate, repoId) as { id: string } | undefined;
        if (conflict) {
          res.status(409).json({ error: `You already have a repository named "${candidate}".` });
          return;
        }
      }
      nextName = candidate;
    }

    const description = body.description !== undefined
      ? String(body.description).trim().slice(0, 500)
      : loaded.repo.description;

    let visibility = loaded.repo.visibility;
    if (body.visibility !== undefined) {
      const v = String(body.visibility).trim().toLowerCase();
      if (v !== 'public' && v !== 'private') {
        res.status(400).json({ error: 'Visibility must be public or private.' });
        return;
      }
      visibility = v;
    }

    const readmeEnabled = body.readme_enabled !== undefined
      ? (body.readme_enabled ? 1 : 0)
      : loaded.repo.readme_enabled;

    const nowIso = new Date().toISOString();
    db.prepare(
      `UPDATE repositories
       SET name = ?, description = ?, visibility = ?, readme_enabled = ?, updated_at = ?
       WHERE id = ? AND owner_id = ?`
    ).run(nextName, description, visibility, readmeEnabled, nowIso, repoId, req.user!.id);

    res.json({
      repository: {
        ...loaded.repo,
        name: nextName,
        description,
        visibility,
        readme_enabled: Boolean(readmeEnabled),
        updated_at: nowIso,
      },
    });
  });

  router.delete('/repositories/:id', requireAuth, writeRateLimit, (req, res) => {
    const repoId = String(req.params.id || '');
    const loaded = loadAuthorizedRepo(req, res, repoId);
    if (!loaded) return;
    if (!loaded.isOwner) {
      res.status(403).json({ error: 'Only the repository owner can delete this repository.' });
      return;
    }

    db.prepare(`DELETE FROM repositories WHERE id = ? AND owner_id = ?`).run(repoId, req.user!.id);
    storage.deleteRepoFolder(repoId);
    res.json({ ok: true });
  });

  // ---- Folder Upload (preserving relative paths) ----
  router.post('/repositories/:id/upload', requireAuth, uploadRateLimit, (req, res) => {
    const repoId = String(req.params.id || '');
    const loaded = loadAuthorizedRepo(req, res, repoId);
    if (!loaded) return;
    if (!loaded.isOwner) {
      res.status(403).json({ error: 'Only the repository owner can upload files.' });
      return;
    }

    uploadRepoFiles.array('files', MAX_UPLOAD_FILES)(req, res, (err) => {
      if (err) {
        res.status(400).json({ error: err.message || 'Upload failed or exceeded limits (max 250 files, 10MB each).' });
        return;
      }

      const files = (req.files as Express.Multer.File[] | undefined) || [];
      if (files.length === 0) {
        res.status(400).json({ error: 'No files were selected for upload.' });
        return;
      }

      const totalBatchBytes = files.reduce((sum, f) => sum + f.size, 0);
      if (totalBatchBytes > MAX_BATCH_BYTES) {
        res.status(400).json({ error: 'Upload batch exceeds 50 MB limit. Upload in smaller folder batches.' });
        return;
      }

      let rawPaths: string[] = [];
      if (req.body?.paths) {
        try {
          const parsed = typeof req.body.paths === 'string' ? JSON.parse(req.body.paths) : req.body.paths;
          if (Array.isArray(parsed)) rawPaths = parsed.map(String);
        } catch {
          res.status(400).json({ error: 'Invalid paths metadata.' });
          return;
        }
      }

      const overwrite = String(req.body?.overwrite || 'false') === 'true';

      const normalizedItems: Array<{
        file: Express.Multer.File;
        relativePath: string;
        contentType: string;
      }> = [];
      const seenPaths = new Set<string>();

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const rawPath = rawPaths[i] !== undefined ? rawPaths[i] : f.originalname;
        const norm = normalizeRelativePath(rawPath);
        if (!norm.ok) {
          res.status(400).json({ error: norm.error });
          return;
        }
        if (seenPaths.has(norm.path)) {
          res.status(400).json({ error: `Duplicate path in upload batch: ${norm.path}` });
          return;
        }
        seenPaths.add(norm.path);
        normalizedItems.push({
          file: f,
          relativePath: norm.path,
          contentType: guessContentType(norm.path, f.mimetype),
        });
      }

      const existingRows = db
        .prepare(`SELECT id, relative_path, storage_key FROM repository_files WHERE repository_id = ?`)
        .all(repoId) as Array<{ id: string; relative_path: string; storage_key: string }>;
      const existingMap = new Map(existingRows.map((r) => [r.relative_path, r]));

      if (!overwrite) {
        const conflicts = normalizedItems
          .filter((it) => existingMap.has(it.relativePath))
          .map((it) => it.relativePath);
        if (conflicts.length > 0) {
          res.status(409).json({
            error: `Conflicting duplicate path(s): ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? ` (+${conflicts.length - 5} more)` : ''}. Enable overwrite to replace existing files.`,
            conflicts,
          });
          return;
        }
      }

      const writtenKeys: string[] = [];
      const oldKeysToDelete: string[] = [];
      const nowIso = new Date().toISOString();

      try {
        for (const item of normalizedItems) {
          const storageKey = storage.createRepoStorageKey(repoId);
          storage.writeObject(storageKey, item.file.buffer);
          writtenKeys.push(storageKey);

          const existing = existingMap.get(item.relativePath);
          if (existing) oldKeysToDelete.push(existing.storage_key);
        }

        db.exec('BEGIN');
        try {
          const insertStmt = db.prepare(
            `INSERT INTO repository_files (id, repository_id, relative_path, storage_key, content_type, size_bytes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(repository_id, relative_path) DO UPDATE SET
               storage_key = excluded.storage_key,
               content_type = excluded.content_type,
               size_bytes = excluded.size_bytes,
               created_at = excluded.created_at`
          );

          for (let i = 0; i < normalizedItems.length; i++) {
            const item = normalizedItems[i];
            const storageKey = writtenKeys[i];
            insertStmt.run(
              crypto.randomUUID(),
              repoId,
              item.relativePath,
              storageKey,
              item.contentType,
              item.file.size,
              nowIso
            );
          }

          db.prepare(`UPDATE repositories SET updated_at = ? WHERE id = ?`).run(nowIso, repoId);
          db.exec('COMMIT');
        } catch (dbErr) {
          db.exec('ROLLBACK');
          throw dbErr;
        }
      } catch (writeErr) {
        for (const key of writtenKeys) {
          storage.deleteObject(key);
        }
        res.status(500).json({ error: 'Upload failed safely; no partial files were committed.' });
        return;
      }

      for (const oldKey of oldKeysToDelete) {
        storage.deleteObject(oldKey);
      }

      recordActivity(req.user!.id, 'files_uploaded', `${loaded.repo.name} (${normalizedItems.length})`);

      res.status(201).json({
        uploadedCount: normalizedItems.length,
        totalBytes: totalBatchBytes,
        paths: normalizedItems.map((it) => it.relativePath),
      });
    });
  });

  // ---- Repository Tree Browser (immediate children only, folders before files) ----
  router.get('/repositories/:id/tree', (req, res) => {
    const repoId = String(req.params.id || '');
    const loaded = loadAuthorizedRepo(req, res, repoId);
    if (!loaded) return;

    const rawDir = typeof req.query.path === 'string' ? req.query.path : '';
    const normDir = normalizeDirQuery(rawDir);
    if (!normDir.ok) {
      res.status(400).json({ error: normDir.error });
      return;
    }
    const dir = normDir.dir;

    const allFiles = db
      .prepare(`SELECT relative_path, storage_key, content_type, size_bytes, created_at FROM repository_files WHERE repository_id = ?`)
      .all(repoId) as Array<{
        relative_path: string;
        storage_key: string;
        content_type: string;
        size_bytes: number;
        created_at: string;
      }>;

    const foldersMap = new Map<string, { name: string; path: string; type: 'folder'; item_count: number }>();
    const childFiles: Array<{
      name: string;
      path: string;
      type: 'file';
      size_bytes: number;
      content_type: string;
      created_at: string;
    }> = [];

    const prefix = dir ? `${dir}/` : '';

    for (const f of allFiles) {
      if (dir && !f.relative_path.startsWith(prefix)) continue;
      const rest = dir ? f.relative_path.slice(prefix.length) : f.relative_path;
      if (!rest) continue;

      const slashIdx = rest.indexOf('/');
      if (slashIdx !== -1) {
        const folderName = rest.slice(0, slashIdx);
        const folderPath = dir ? `${dir}/${folderName}` : folderName;
        const existing = foldersMap.get(folderPath);
        if (existing) {
          existing.item_count += 1;
        } else {
          foldersMap.set(folderPath, {
            name: folderName,
            path: folderPath,
            type: 'folder',
            item_count: 1,
          });
        }
      } else {
        childFiles.push({
          name: rest,
          path: f.relative_path,
          type: 'file',
          size_bytes: f.size_bytes,
          content_type: f.content_type,
          created_at: f.created_at,
        });
      }
    }

    if (dir && foldersMap.size === 0 && childFiles.length === 0) {
      res.status(404).json({ error: 'Folder not found.' });
      return;
    }

    const folders = Array.from(foldersMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    childFiles.sort((a, b) => a.name.localeCompare(b.name));

    let readme: { path: string; html: string } | null = null;
    if (dir === '' && loaded.repo.readme_enabled) {
      const readmeFile = allFiles.find((f) => f.relative_path.toLowerCase() === 'readme.md');
      if (readmeFile && storage.exists(readmeFile.storage_key) && readmeFile.size_bytes <= MAX_TEXT_VIEW_BYTES) {
        const buf = storage.readObject(readmeFile.storage_key);
        if (!isBinaryBuffer(readmeFile.relative_path, buf)) {
          readme = {
            path: readmeFile.relative_path,
            html: renderSafeMarkdown(buf.toString('utf8')),
          };
        }
      }
    }

    res.json({
      path: dir,
      entries: [...folders, ...childFiles],
      readme,
    });
  });

  // ---- Safe File Viewer ----
  router.get('/repositories/:id/file', (req, res) => {
    const repoId = String(req.params.id || '');
    const loaded = loadAuthorizedRepo(req, res, repoId);
    if (!loaded) return;

    const norm = normalizeRelativePath(String(req.query.path || ''));
    if (!norm.ok) {
      res.status(400).json({ error: norm.error });
      return;
    }

    const fileRow = db
      .prepare(`SELECT relative_path, storage_key, content_type, size_bytes, created_at FROM repository_files WHERE repository_id = ? AND relative_path = ?`)
      .get(repoId, norm.path) as
      | { relative_path: string; storage_key: string; content_type: string; size_bytes: number; created_at: string }
      | undefined;

    if (!fileRow || !storage.exists(fileRow.storage_key)) {
      res.status(404).json({ error: 'File not found.' });
      return;
    }

    const buf = storage.readObject(fileRow.storage_key);
    const binary = isBinaryBuffer(fileRow.relative_path, buf) || fileRow.size_bytes > MAX_TEXT_VIEW_BYTES;

    if (binary) {
      res.json({
        path: fileRow.relative_path,
        content_type: fileRow.content_type,
        size_bytes: fileRow.size_bytes,
        created_at: fileRow.created_at,
        is_binary: true,
        content: null,
        rendered_html: null,
      });
      return;
    }

    const text = buf.toString('utf8');
    const ext = path.extname(fileRow.relative_path).toLowerCase();
    const isMd = ext === '.md' || ext === '.markdown';

    res.json({
      path: fileRow.relative_path,
      content_type: fileRow.content_type,
      size_bytes: fileRow.size_bytes,
      created_at: fileRow.created_at,
      is_binary: false,
      content: text,
      rendered_html: isMd ? renderSafeMarkdown(text) : null,
    });
  });

  // ---- File Download (never executed on origin) ----
  router.get('/repositories/:id/download', (req, res) => {
    const repoId = String(req.params.id || '');
    const loaded = loadAuthorizedRepo(req, res, repoId);
    if (!loaded) return;

    const norm = normalizeRelativePath(String(req.query.path || ''));
    if (!norm.ok) {
      res.status(400).json({ error: norm.error });
      return;
    }

    const fileRow = db
      .prepare(`SELECT relative_path, storage_key, size_bytes FROM repository_files WHERE repository_id = ? AND relative_path = ?`)
      .get(repoId, norm.path) as { relative_path: string; storage_key: string; size_bytes: number } | undefined;

    if (!fileRow || !storage.exists(fileRow.storage_key)) {
      res.status(404).json({ error: 'File not found.' });
      return;
    }

    const buf = storage.readObject(fileRow.storage_key);
    const filename = sanitizeDownloadFilename(fileRow.relative_path);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(buf.length));
    res.send(buf);
  });

  return router;
}
