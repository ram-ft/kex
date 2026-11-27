import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServerApp } from '../server.ts';

async function startTestServer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kex-test-'));
  const { app, db } = await createServerApp({ dataDir: tempDir, isProd: true });

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    db,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function jsonReq(
  baseUrl: string,
  urlPath: string,
  options: RequestInit & { token?: string } = {}
) {
  const headers = new Headers(options.headers || {});
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${baseUrl}${urlPath}`, { ...options, headers });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, data, headers: res.headers };
}

test('KEX end-to-end API, permissions, nested tree, and profile README', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  let aliceToken = '';
  let bobToken = '';
  let publicRepoId = '';
  let privateRepoId = '';

  await t.test('Auth signup, validation, reserved names, login, logout', async () => {
    // Reserved username rejected
    const reserved = await jsonReq(srv.baseUrl, '/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: 'dashboard', email: 'res@example.com', password: 'password123' }),
    });
    assert.equal(reserved.status, 400);

    // Valid signup Alice
    const sAlice = await jsonReq(srv.baseUrl, '/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        username: 'alice-dev',
        email: 'alice@example.com',
        password: 'StrongPassword1!',
        displayName: 'Alice Developer',
      }),
    });
    assert.equal(sAlice.status, 201);
    assert.equal(sAlice.data.user.username, 'alice-dev');
    assert.ok(sAlice.data.token);
    aliceToken = sAlice.data.token;

    // Duplicate username rejected
    const dupUser = await jsonReq(srv.baseUrl, '/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        username: 'alice-dev',
        email: 'other@example.com',
        password: 'StrongPassword1!',
      }),
    });
    assert.equal(dupUser.status, 409);

    // Valid signup Bob
    const sBob = await jsonReq(srv.baseUrl, '/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        username: 'bob-builds',
        email: 'bob@example.com',
        password: 'StrongPassword2!',
      }),
    });
    assert.equal(sBob.status, 201);
    bobToken = sBob.data.token;

    // Wrong password rejected
    const badLogin = await jsonReq(srv.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'alice-dev', password: 'wrong-password' }),
    });
    assert.equal(badLogin.status, 401);

    // Valid login + logout revokes session
    const goodLogin = await jsonReq(srv.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'alice@example.com', password: 'StrongPassword1!' }),
    });
    assert.equal(goodLogin.status, 200);
    const tempTok = goodLogin.data.token;

    const meOk = await jsonReq(srv.baseUrl, '/api/me', { token: tempTok });
    assert.equal(meOk.status, 200);

    await jsonReq(srv.baseUrl, '/api/auth/logout', { method: 'POST', token: tempTok });
    const meRevoked = await jsonReq(srv.baseUrl, '/api/me', { token: tempTok });
    assert.equal(meRevoked.status, 401);
  });

  await t.test('Repository creation, nested folder upload, immediate-child tree, and path guards', async () => {
    const createPub = await jsonReq(srv.baseUrl, '/api/repositories', {
      method: 'POST',
      token: aliceToken,
      body: JSON.stringify({
        name: 'my-project',
        description: 'Nested project demo',
        visibility: 'public',
        readme_enabled: true,
      }),
    });
    assert.equal(createPub.status, 201);
    publicRepoId = createPub.data.repository.id;

    // Reject path traversal
    const badFd = new FormData();
    badFd.append('paths', JSON.stringify(['../secret.txt']));
    badFd.append('files', new Blob(['oops']), 'secret.txt');
    const travRes = await jsonReq(srv.baseUrl, `/api/repositories/${publicRepoId}/upload`, {
      method: 'POST',
      token: aliceToken,
      body: badFd,
    });
    assert.equal(travRes.status, 400);

    // Reject absolute path
    const absFd = new FormData();
    absFd.append('paths', JSON.stringify(['/etc/passwd']));
    absFd.append('files', new Blob(['oops']), 'passwd');
    const absRes = await jsonReq(srv.baseUrl, `/api/repositories/${publicRepoId}/upload`, {
      method: 'POST',
      token: aliceToken,
      body: absFd,
    });
    assert.equal(absRes.status, 400);

    // Upload valid nested folder structure
    const validFd = new FormData();
    const uploadPaths = [
      'package.json',
      'README.md',
      'src/app.ts',
      'src/components/Button.svelte',
      'public/logo.png',
    ];
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    validFd.append('paths', JSON.stringify(uploadPaths));
    validFd.append('files', new Blob(['{"name":"my-project"}'], { type: 'application/json' }), 'package.json');
    validFd.append('files', new Blob(['# My Project\n\nNested **README** <script>alert(1)</script>']), 'README.md');
    validFd.append('files', new Blob(['export const ok = true;\n']), 'app.ts');
    validFd.append('files', new Blob(['<button>Click</button>\n']), 'Button.svelte');
    validFd.append('files', new Blob([pngBytes], { type: 'image/png' }), 'logo.png');

    const upRes = await jsonReq(srv.baseUrl, `/api/repositories/${publicRepoId}/upload`, {
      method: 'POST',
      token: aliceToken,
      body: validFd,
    });
    assert.equal(upRes.status, 201);
    assert.equal(upRes.data.uploadedCount, 5);

    // Duplicate path conflict when overwrite=false
    const dupFd = new FormData();
    dupFd.append('paths', JSON.stringify(['src/app.ts']));
    dupFd.append('overwrite', 'false');
    dupFd.append('files', new Blob(['updated']), 'app.ts');
    const dupUp = await jsonReq(srv.baseUrl, `/api/repositories/${publicRepoId}/upload`, {
      method: 'POST',
      token: aliceToken,
      body: dupFd,
    });
    assert.equal(dupUp.status, 409);

    // Immediate children at root: folders first (public, src), then files (package.json, README.md)
    const rootTree = await jsonReq(srv.baseUrl, `/api/repositories/${publicRepoId}/tree`);
    assert.equal(rootTree.status, 200);
    assert.deepEqual(
      rootTree.data.entries.map((e: any) => `${e.type}:${e.name}`),
      ['folder:public', 'folder:src', 'file:package.json', 'file:README.md']
    );
    assert.ok(rootTree.data.readme);
    assert.ok(!rootTree.data.readme.html.includes('<script>'));

    // Immediate children inside src/: components/ BEFORE app.ts
    const srcTree = await jsonReq(srv.baseUrl, `/api/repositories/${publicRepoId}/tree?path=src`);
    assert.equal(srcTree.status, 200);
    assert.deepEqual(
      srcTree.data.entries.map((e: any) => `${e.type}:${e.name}`),
      ['folder:components', 'file:app.ts']
    );
    assert.equal(srcTree.data.readme, null);

    // Disable repo README -> root tree should no longer return readme
    const disableReadme = await jsonReq(srv.baseUrl, `/api/repositories/${publicRepoId}`, {
      method: 'PATCH',
      token: aliceToken,
      body: JSON.stringify({ readme_enabled: false }),
    });
    assert.equal(disableReadme.status, 200);

    const rootTreeNoReadme = await jsonReq(srv.baseUrl, `/api/repositories/${publicRepoId}/tree`);
    assert.equal(rootTreeNoReadme.data.readme, null);

    // Safe text file viewer
    const textFile = await jsonReq(
      srv.baseUrl,
      `/api/repositories/${publicRepoId}/file?path=${encodeURIComponent('src/components/Button.svelte')}`
    );
    assert.equal(textFile.status, 200);
    assert.equal(textFile.data.is_binary, false);
    assert.equal(textFile.data.content, '<button>Click</button>\n');

    // Binary file detection
    const binFile = await jsonReq(
      srv.baseUrl,
      `/api/repositories/${publicRepoId}/file?path=${encodeURIComponent('public/logo.png')}`
    );
    assert.equal(binFile.status, 200);
    assert.equal(binFile.data.is_binary, true);
    assert.equal(binFile.data.content, null);

    // Download headers enforce attachment & nosniff
    const dlRes = await fetch(`${srv.baseUrl}/api/repositories/${publicRepoId}/download?path=${encodeURIComponent('src/app.ts')}`);
    assert.equal(dlRes.status, 200);
    assert.equal(dlRes.headers.get('content-type'), 'application/octet-stream');
    assert.equal(dlRes.headers.get('x-content-type-options'), 'nosniff');
    assert.match(dlRes.headers.get('content-disposition') || '', /^attachment; filename="app\.ts"/);
    assert.equal(await dlRes.text(), 'export const ok = true;\n');
  });

  await t.test('Private repository server-side isolation across all endpoints', async () => {
    const createPriv = await jsonReq(srv.baseUrl, '/api/repositories', {
      method: 'POST',
      token: aliceToken,
      body: JSON.stringify({
        name: 'secret-vault',
        description: 'Private internal code',
        visibility: 'private',
        readme_enabled: true,
      }),
    });
    assert.equal(createPriv.status, 201);
    privateRepoId = createPriv.data.repository.id;

    const privFd = new FormData();
    privFd.append('paths', JSON.stringify(['secrets.txt']));
    privFd.append('files', new Blob(['TOP_SECRET']), 'secrets.txt');
    const upPriv = await jsonReq(srv.baseUrl, `/api/repositories/${privateRepoId}/upload`, {
      method: 'POST',
      token: aliceToken,
      body: privFd,
    });
    assert.equal(upPriv.status, 201);

    // Visitor & Bob (unauthorized) cannot view private repo via any endpoint
    for (const tok of [undefined, bobToken]) {
      assert.equal((await jsonReq(srv.baseUrl, `/api/repositories/by-slug/alice-dev/secret-vault`, { token: tok })).status, 404);
      assert.equal((await jsonReq(srv.baseUrl, `/api/repositories/${privateRepoId}`, { token: tok })).status, 404);
      assert.equal((await jsonReq(srv.baseUrl, `/api/repositories/${privateRepoId}/tree`, { token: tok })).status, 404);
      assert.equal((await jsonReq(srv.baseUrl, `/api/repositories/${privateRepoId}/file?path=secrets.txt`, { token: tok })).status, 404);
      assert.equal((await jsonReq(srv.baseUrl, `/api/repositories/${privateRepoId}/download?path=secrets.txt`, { token: tok })).status, 404);
    }

    // Bob cannot mutate Alice's repo
    const bobPatch = await jsonReq(srv.baseUrl, `/api/repositories/${publicRepoId}`, {
      method: 'PATCH',
      token: bobToken,
      body: JSON.stringify({ description: 'hacked' }),
    });
    assert.equal(bobPatch.status, 403);

    // Private repo hidden from /explore and public profile for visitors
    const explore = await jsonReq(srv.baseUrl, '/api/explore');
    assert.ok(explore.data.repositories.some((r: any) => r.name === 'my-project'));
    assert.ok(!explore.data.repositories.some((r: any) => r.name === 'secret-vault'));

    const bobViewingAlice = await jsonReq(srv.baseUrl, '/api/users/alice-dev', { token: bobToken });
    assert.equal(bobViewingAlice.status, 200);
    assert.equal(bobViewingAlice.data.isOwner, false);
    assert.ok(!bobViewingAlice.data.repositories.some((r: any) => r.name === 'secret-vault'));

    // Alice (owner) can access private repo everywhere
    const aliceOwnProfile = await jsonReq(srv.baseUrl, '/api/users/alice-dev', { token: aliceToken });
    assert.equal(aliceOwnProfile.data.isOwner, true);
    assert.ok(aliceOwnProfile.data.repositories.some((r: any) => r.name === 'secret-vault'));

    const alicePrivFile = await jsonReq(srv.baseUrl, `/api/repositories/${privateRepoId}/file?path=secrets.txt`, { token: aliceToken });
    assert.equal(alicePrivFile.status, 200);
    assert.equal(alicePrivFile.data.content, 'TOP_SECRET');
  });

  await t.test('Developer Profile: public/private optional fields, images (no avatars), social links, and Profile README.md', async () => {
    // Update profile with hidden location and public website
    const profRes = await jsonReq(srv.baseUrl, '/api/me/profile', {
      method: 'PATCH',
      token: aliceToken,
      body: JSON.stringify({
        display_name: 'Alice K.',
        bio: 'Systems builder',
        location: 'Private City',
        location_public: false,
        website: 'https://alice.example.dev',
        website_public: true,
        public_contact: 'hidden@example.com',
        public_contact_public: false,
      }),
    });
    assert.equal(profRes.status, 200);

    // Reject javascript: social link
    const badLinks = await jsonReq(srv.baseUrl, '/api/me/profile/social-links', {
      method: 'PUT',
      token: aliceToken,
      body: JSON.stringify({
        links: [{ platform: 'custom', label: 'XSS', url: 'javascript:alert(1)' }],
      }),
    });
    assert.equal(badLinks.status, 400);

    // Valid social links
    const goodLinks = await jsonReq(srv.baseUrl, '/api/me/profile/social-links', {
      method: 'PUT',
      token: aliceToken,
      body: JSON.stringify({
        links: [
          { platform: 'github', label: 'GitHub', url: 'https://github.com/alice' },
          { platform: 'email', label: 'Email', url: 'alice@example.dev' },
        ],
      }),
    });
    assert.equal(goodLinks.status, 200);

    // Upload banner image (valid PNG magic bytes) & reject invalid bytes
    const badImgFd = new FormData();
    badImgFd.append('image_type', 'banner');
    badImgFd.append('image', new Blob(['not an image']), 'fake.png');
    const badImgRes = await jsonReq(srv.baseUrl, '/api/me/profile/images', {
      method: 'POST',
      token: aliceToken,
      body: badImgFd,
    });
    assert.equal(badImgRes.status, 400);

    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const goodImgFd = new FormData();
    goodImgFd.append('image_type', 'banner');
    goodImgFd.append('caption', 'Workspace Banner');
    goodImgFd.append('image', new Blob([pngHeader], { type: 'image/png' }), 'banner.png');
    const goodImgRes = await jsonReq(srv.baseUrl, '/api/me/profile/images', {
      method: 'POST',
      token: aliceToken,
      body: goodImgFd,
    });
    assert.equal(goodImgRes.status, 201);
    assert.equal(goodImgRes.data.image_type, 'banner');

    // Profile README.md with XSS payload -> sanitized and stored separately from repository README
    const unsafeMd = `# About Alice\n\n<script>alert('xss')</script>\n\n[Bad](javascript:alert(1)) and [Good](https://example.com)\n\n<img src="https://example.com/a.png" onerror="alert(1)">\n\n| Col1 | Col2 |\n| --- | --- |\n| A | B |`;
    const saveReadme = await jsonReq(srv.baseUrl, '/api/me/profile/readme', {
      method: 'PUT',
      token: aliceToken,
      body: JSON.stringify({ markdown_content: unsafeMd }),
    });
    assert.equal(saveReadme.status, 200);
    assert.ok(saveReadme.data.rendered_html.includes('About Alice'));
    assert.ok(saveReadme.data.rendered_html.includes('<table>'));
    assert.ok(!saveReadme.data.rendered_html.includes('<script>'));
    assert.ok(!saveReadme.data.rendered_html.includes('onerror'));
    assert.ok(!saveReadme.data.rendered_html.includes('javascript:'));

    // Visitor reads public profile: hidden location/contact are masked, markdown_content is omitted, banner & links shown
    const pubProfile = await jsonReq(srv.baseUrl, '/api/users/alice-dev');
    assert.equal(pubProfile.status, 200);
    assert.equal(pubProfile.data.profile.location, '');
    assert.equal(pubProfile.data.profile.public_contact, '');
    assert.equal(pubProfile.data.profile.website, 'https://alice.example.dev/');
    assert.equal(pubProfile.data.readme.markdown_content, undefined);
    assert.ok(pubProfile.data.readme.rendered_html.includes('About Alice'));
    assert.equal(pubProfile.data.images.length, 1);
    assert.equal(pubProfile.data.socialLinks.length, 2);

    // Separate check: Repository README.md was NOT overwritten by Profile README.md
    await jsonReq(srv.baseUrl, `/api/repositories/${publicRepoId}`, {
      method: 'PATCH',
      token: aliceToken,
      body: JSON.stringify({ readme_enabled: true }),
    });
    const repoTreeCheck = await jsonReq(srv.baseUrl, `/api/repositories/${publicRepoId}/tree`);
    assert.ok(repoTreeCheck.data.readme.html.includes('My Project'));
    assert.ok(!repoTreeCheck.data.readme.html.includes('About Alice'));
  });
});
