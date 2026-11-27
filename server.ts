import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { initDb, type KexDb } from './src/server/db.ts';
import { LocalObjectStorage } from './src/server/storage.ts';
import { createApiRouter } from './src/server/routes.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  dataDir?: string;
  isProd?: boolean;
}

export async function createServerApp(options: ServerOptions = {}) {
  const isProd = options.isProd ?? process.env.NODE_ENV === 'production';
  const dataDir = options.dataDir ?? process.env.KEX_DATA_DIR ?? path.resolve(__dirname, 'data');

  const db: KexDb = initDb(dataDir);
  const storage = new LocalObjectStorage(dataDir);

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', createApiRouter(db, storage));

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: __dirname,
      server: { middlewareMode: true },
      appType: 'custom',
    });

    app.use(vite.middlewares);

    app.use(async (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      const reqPath = req.path;
      if (reqPath.startsWith('/api/') || reqPath.startsWith('/assets/')) {
        next();
        return;
      }

      try {
        let htmlFile = 'app.html';
        if (reqPath === '/' || reqPath === '/index.html') {
          htmlFile = 'index.html';
        } else if (reqPath === '/login' || reqPath === '/signup' || reqPath === '/reset' || reqPath === '/login.html') {
          htmlFile = 'login.html';
        }

        const rawHtml = fs.readFileSync(path.resolve(__dirname, htmlFile), 'utf8');
        const transformed = await vite.transformIndexHtml(req.originalUrl, rawHtml);
        res.status(200).setHeader('Content-Type', 'text/html').end(transformed);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir, { index: false }));

    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      const reqPath = req.path;
      if (reqPath.startsWith('/api/') || reqPath.startsWith('/assets/')) {
        next();
        return;
      }
      let htmlFile = 'app.html';
      if (reqPath === '/' || reqPath === '/index.html') {
        htmlFile = 'index.html';
      } else if (reqPath === '/login' || reqPath === '/signup' || reqPath === '/reset' || reqPath === '/login.html') {
        htmlFile = 'login.html';
      }
      const target = path.resolve(distDir, htmlFile);
      if (fs.existsSync(target)) {
        res.sendFile(target);
      } else {
        res.status(404).send('Not found');
      }
    });
  }

  return { app, db, storage };
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const port = Number(process.env.PORT || 3000);
  createServerApp().then(({ app }) => {
    app.listen(port, '0.0.0.0', () => {
      console.log(`KEX server listening on http://0.0.0.0:${port}`);
    });
  });
}
