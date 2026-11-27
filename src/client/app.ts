declare const lucide: { createIcons?: () => void } | undefined;

interface UserSummary {
  id: string;
  username: string;
  email: string;
}

interface ProfileData {
  display_name: string;
  bio: string;
  location: string;
  location_public: boolean;
  website: string;
  website_public: boolean;
  public_contact: string;
  public_contact_public: boolean;
  updated_at?: string;
}

interface ProfileImage {
  id: string;
  image_type: 'banner' | 'featured' | 'gallery';
  url: string;
  mime_type: string;
  size_bytes: number;
  caption: string;
  sort_order: number;
  created_at: string;
}

interface SocialLink {
  id?: string;
  platform: string;
  label: string;
  url: string;
  sort_order?: number;
}

interface HeatmapDay {
  date: string;
  count: number;
  level: number;
}

interface RepoSummary {
  id: string;
  owner_id?: string;
  owner_username?: string;
  owner_display_name?: string | null;
  name: string;
  description: string;
  visibility: 'public' | 'private';
  readme_enabled: boolean | number;
  created_at: string;
  updated_at: string;
  file_count: number;
  total_bytes: number;
}

interface TreeEntryFolder {
  name: string;
  path: string;
  type: 'folder';
  item_count: number;
}

interface TreeEntryFile {
  name: string;
  path: string;
  type: 'file';
  size_bytes: number;
  content_type: string;
  created_at: string;
}

type TreeEntry = TreeEntryFolder | TreeEntryFile;

interface FileViewerData {
  path: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  is_binary: boolean;
  content: string | null;
  rendered_html: string | null;
}

interface SelectedUploadFile {
  file: File;
  relativePath: string;
}

interface StatsData {
  publicRepositories: number;
  publicFiles: number;
  developers: number;
  profileReadmes: number;
}

interface UserProfileResponse {
  isOwner: boolean;
  user: {
    id: string;
    username: string;
    created_at: string;
  };
  profile: ProfileData;
  images: ProfileImage[];
  socialLinks: SocialLink[];
  readme: {
    markdown_content?: string;
    rendered_html: string;
    has_content: boolean;
    updated_at: string | null;
  };
  repositories: RepoSummary[];
  heatmap: HeatmapDay[];
}

const MAX_UPLOAD_FILES_PER_BATCH = 250;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_BYTES = 45 * 1024 * 1024;

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T | null => document.querySelector(sel);

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return ch;
    }
  });
}

function icons(): void {
  try {
    lucide?.createIcons?.();
  } catch {
    // ignore icon render fallback
  }
}

let toastTimer: number | undefined;
function showToast(msg: string): void {
  const el = $('#toast');
  const txt = $('#toast-msg');
  if (!el || !txt) return;
  txt.textContent = msg;
  el.classList.add('on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('on'), 4200);
}

async function copyText(text: string, label: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showToast(label);
  } catch {
    showToast('Unable to copy to clipboard.');
  }
}

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function apiJson<T>(url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const headers = new Headers(init.headers || {});
  headers.set('X-Requested-With', 'XMLHttpRequest');
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, status: res.status, data };
}

function openModal(title: string, bodyHtml: string): void {
  const t = $('#modal-title');
  const b = $('#modal-body');
  const bd = $('#modal-backdrop');
  if (!t || !b || !bd) return;
  t.textContent = title;
  b.innerHTML = bodyHtml;
  bd.classList.add('open');
  icons();
}

function closeModal(): void {
  $('#modal-backdrop')?.classList.remove('open');
}

// ---- Relative path normalization for local folder selection ----
function sanitizeClientRelativePath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

function stripSingleCommonRoot(items: Array<{ file: File; rawPath: string }>): SelectedUploadFile[] {
  const cleaned = items
    .map((it) => ({ file: it.file, rel: sanitizeClientRelativePath(it.rawPath) }))
    .filter((it) => it.rel.length > 0);

  if (cleaned.length === 0) return [];

  const firstSegments = cleaned.map((it) => {
    const idx = it.rel.indexOf('/');
    return idx === -1 ? '' : it.rel.slice(0, idx);
  });

  const firstRoot = firstSegments[0];
  const allShareWrapper =
    firstRoot.length > 0 &&
    firstSegments.every((seg, i) => seg === firstRoot && cleaned[i].rel.length > firstRoot.length + 1);

  return cleaned.map((it) => ({
    file: it.file,
    relativePath: allShareWrapper ? it.rel.slice(firstRoot.length + 1) : it.rel,
  }));
}

function collectFromFileList(fileList: FileList | File[]): SelectedUploadFile[] {
  const arr = Array.from(fileList);
  const rawItems = arr.map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    return { file, rawPath: rel };
  });
  return stripSingleCommonRoot(rawItems);
}

async function readAllDirectoryEntries(dirEntry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dirEntry.createReader();
  const entries: FileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch.length) break;
    entries.push(...batch);
  }
  return entries;
}

async function collectDroppedItems(dataTransfer: DataTransfer): Promise<SelectedUploadFile[]> {
  const items = Array.from(dataTransfer.items || []);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e !== null);

  if (entries.length === 0) {
    return collectFromFileList(dataTransfer.files);
  }

  const rawItems: Array<{ file: File; rawPath: string }> = [];

  async function walk(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });
      rawItems.push({ file, rawPath: prefix ? `${prefix}/${entry.name}` : entry.name });
    } else if (entry.isDirectory) {
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const children = await readAllDirectoryEntries(entry as FileSystemDirectoryEntry);
      for (const child of children) {
        await walk(child, nextPrefix);
      }
    }
  }

  for (const entry of entries) {
    await walk(entry, '');
  }

  return stripSingleCommonRoot(rawItems);
}

async function uploadSelectedFilesInBatches(
  repoId: string,
  selected: SelectedUploadFile[],
  overwrite: boolean,
  onProgress: (pct: number, text: string) => void
): Promise<{ ok: boolean; uploaded: number; error?: string }> {
  // Pre-validate per-file limit
  const oversized = selected.find((item) => item.file.size > MAX_FILE_BYTES);
  if (oversized) {
    return {
      ok: false,
      uploaded: 0,
      error: `"${oversized.relativePath}" (${fmtBytes(oversized.file.size)}) exceeds the 10 MB per-file limit.`,
    };
  }

  // Group into batches <= 250 files and <= 45 MB
  const batches: SelectedUploadFile[][] = [];
  let current: SelectedUploadFile[] = [];
  let currentBytes = 0;

  for (const item of selected) {
    if (
      current.length >= MAX_UPLOAD_FILES_PER_BATCH ||
      (current.length > 0 && currentBytes + item.file.size > MAX_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += item.file.size;
  }
  if (current.length > 0) batches.push(current);

  let uploadedTotal = 0;
  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batch = batches[bIdx];
    onProgress(
      Math.round((uploadedTotal / selected.length) * 100),
      `Uploading batch ${bIdx + 1} of ${batches.length} (${batch.length} files)...`
    );

    const fd = new FormData();
    const paths = batch.map((it) => it.relativePath);
    fd.append('paths', JSON.stringify(paths));
    fd.append('overwrite', overwrite ? 'true' : 'false');
    for (const it of batch) {
      fd.append('files', it.file, it.file.name);
    }

    const res = await apiJson<{ uploadedCount: number }>(`/api/repositories/${encodeURIComponent(repoId)}/upload`, {
      method: 'POST',
      body: fd,
    });

    if (!res.ok) {
      return {
        ok: false,
        uploaded: uploadedTotal,
        error: res.data.error || `Upload failed during batch ${bIdx + 1}.`,
      };
    }
    uploadedTotal += batch.length;
    onProgress(Math.round((uploadedTotal / selected.length) * 100), `Uploaded ${uploadedTotal} of ${selected.length} files.`);
  }

  return { ok: true, uploaded: uploadedTotal };
}

// ---- App State & Router ----
type RouteState =
  | { kind: 'explore'; query: string; sort: string }
  | { kind: 'dashboard' }
  | { kind: 'new' }
  | { kind: 'profile'; username: string; tab: 'overview' | 'readme' | 'repos' }
  | { kind: 'repo'; owner: string; repo: string; tab: 'code' | 'upload' | 'settings'; path: string; file: string };

const state = {
  me: null as UserSummary | null,
  meProfile: null as ProfileData | null,
  authLoaded: false,
  route: { kind: 'explore', query: '', sort: 'recent' } as RouteState,

  // Explore
  exploreRepos: [] as RepoSummary[],
  exploreStats: { publicRepositories: 0, publicFiles: 0, developers: 0, profileReadmes: 0 } as StatsData,
  exploreLoading: false,

  // Dashboard
  myRepos: [] as RepoSummary[],
  dashLoading: false,

  // New repo + upload draft
  newRepoError: '',
  newRepoCreatedSlug: '',
  newFiles: [] as SelectedUploadFile[],
  newUploadPct: 0,
  newUploadStatus: '',
  newSubmitting: false,

  // Repo Browser
  repoLoading: false,
  repoNotFound: false,
  repoIsOwner: false,
  repoData: null as RepoSummary | null,
  treeLoading: false,
  treeError: '',
  treeEntries: [] as TreeEntry[],
  treeReadme: null as { path: string; html: string } | null,
  fileLoading: false,
  fileData: null as FileViewerData | null,
  fileRenderMode: 'rendered' as 'rendered' | 'source',
  repoUploadFiles: [] as SelectedUploadFile[],
  repoUploadOverwrite: true,
  repoUploadPct: 0,
  repoUploadStatus: '',
  repoUploadError: '',
  repoUploading: false,

  // Developer Profile
  profileLoading: false,
  profileNotFound: false,
  profileData: null as UserProfileResponse | null,
  editingReadme: false,
  readmeMode: 'edit' as 'edit' | 'preview',
  readmeDraft: '',
  readmePreviewHtml: '',
  readmeSaving: false,
};

function parseRouteFromLocation(): RouteState {
  const pathname = location.pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(location.search);

  if (pathname === '/explore' || pathname === '/search') {
    return {
      kind: 'explore',
      query: params.get('q') || '',
      sort: params.get('sort') || 'recent',
    };
  }
  if (pathname === '/dashboard') {
    return { kind: 'dashboard' };
  }
  if (pathname === '/new') {
    return { kind: 'new' };
  }

  const parts = pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts.length === 1) {
    const tabParam = params.get('tab');
    const tab = tabParam === 'readme' || tabParam === 'repos' ? tabParam : 'overview';
    return { kind: 'profile', username: parts[0].toLowerCase(), tab };
  }
  if (parts.length >= 2) {
    const tabParam = params.get('tab');
    const tab = tabParam === 'upload' || tabParam === 'settings' ? tabParam : 'code';
    return {
      kind: 'repo',
      owner: parts[0].toLowerCase(),
      repo: parts[1],
      tab,
      path: params.get('path') || '',
      file: params.get('file') || '',
    };
  }

  return { kind: 'explore', query: '', sort: 'recent' };
}

function navigate(url: string, replace = false): void {
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  void handleRouteChange();
}

async function refreshMe(): Promise<void> {
  const res = await apiJson<{ user: UserSummary; profile: ProfileData }>('/api/me');
  if (res.ok && res.data.user) {
    state.me = res.data.user;
    state.meProfile = res.data.profile;
  } else {
    state.me = null;
    state.meProfile = null;
  }
  state.authLoaded = true;
}

async function loadExploreData(query: string, sort: string): Promise<void> {
  state.exploreLoading = true;
  render();
  const [reposRes, statsRes] = await Promise.all([
    apiJson<{ repositories: RepoSummary[] }>(`/api/explore?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(sort)}`),
    apiJson<StatsData>('/api/stats'),
  ]);
  state.exploreLoading = false;
  if (reposRes.ok) state.exploreRepos = reposRes.data.repositories || [];
  if (statsRes.ok) state.exploreStats = statsRes.data;
  render();
}

async function loadDashboardData(): Promise<void> {
  if (!state.me) {
    location.assign(`/login?next=${encodeURIComponent('/dashboard')}`);
    return;
  }
  state.dashLoading = true;
  render();
  const res = await apiJson<{ repositories: RepoSummary[] }>('/api/me/repositories');
  state.dashLoading = false;
  if (res.ok) state.myRepos = res.data.repositories || [];
  render();
}

async function loadProfileData(username: string): Promise<void> {
  state.profileLoading = true;
  state.profileNotFound = false;
  state.editingReadme = false;
  render();
  const res = await apiJson<UserProfileResponse>(`/api/users/${encodeURIComponent(username)}`);
  state.profileLoading = false;
  if (!res.ok) {
    state.profileNotFound = true;
    state.profileData = null;
  } else {
    state.profileData = res.data;
    if (res.data.isOwner) {
      state.readmeDraft = res.data.readme.markdown_content || '';
    }
  }
  render();
}

async function loadRepoBrowserData(owner: string, repoName: string, dirPath: string, filePath: string): Promise<void> {
  const sameRepo =
    state.repoData &&
    (state.repoData.owner_username || '').toLowerCase() === owner.toLowerCase() &&
    state.repoData.name === repoName;

  if (!sameRepo) {
    state.repoLoading = true;
    state.repoNotFound = false;
    state.repoData = null;
    state.treeEntries = [];
    state.treeReadme = null;
    state.fileData = null;
    render();

    const metaRes = await apiJson<{ isOwner: boolean; repository: RepoSummary }>(
      `/api/repositories/by-slug/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`
    );
    state.repoLoading = false;
    if (!metaRes.ok || !metaRes.data.repository) {
      state.repoNotFound = true;
      render();
      return;
    }
    state.repoIsOwner = Boolean(metaRes.data.isOwner);
    state.repoData = metaRes.data.repository;
  }

  if (!state.repoData) return;

  if (filePath) {
    state.fileLoading = true;
    state.treeError = '';
    render();
    const fRes = await apiJson<FileViewerData>(
      `/api/repositories/${encodeURIComponent(state.repoData.id)}/file?path=${encodeURIComponent(filePath)}`
    );
    state.fileLoading = false;
    if (fRes.ok) {
      state.fileData = fRes.data;
      state.fileRenderMode = fRes.data.rendered_html ? 'rendered' : 'source';
    } else {
      state.fileData = null;
      state.treeError = fRes.data.error || 'File could not be loaded.';
    }
    render();
    return;
  }

  state.fileData = null;
  state.treeLoading = true;
  state.treeError = '';
  render();

  const treeRes = await apiJson<{ path: string; entries: TreeEntry[]; readme: { path: string; html: string } | null }>(
    `/api/repositories/${encodeURIComponent(state.repoData.id)}/tree?path=${encodeURIComponent(dirPath)}`
  );
  state.treeLoading = false;
  if (treeRes.ok) {
    state.treeEntries = treeRes.data.entries || [];
    state.treeReadme = treeRes.data.readme || null;
  } else {
    state.treeEntries = [];
    state.treeReadme = null;
    state.treeError = treeRes.data.error || 'Directory not found.';
  }
  render();
}

async function handleRouteChange(): Promise<void> {
  if (!state.authLoaded) {
    await refreshMe();
  }
  const route = parseRouteFromLocation();
  state.route = route;

  if (route.kind === 'explore') {
    document.title = 'KEX — Explore Repositories';
    await loadExploreData(route.query, route.sort);
  } else if (route.kind === 'dashboard') {
    document.title = 'KEX — Developer Dashboard';
    await loadDashboardData();
  } else if (route.kind === 'new') {
    if (!state.me) {
      location.assign(`/login?next=${encodeURIComponent('/new')}`);
      return;
    }
    document.title = 'KEX — New Repository';
    state.newRepoError = '';
    state.newUploadPct = 0;
    state.newUploadStatus = '';
    render();
  } else if (route.kind === 'profile') {
    document.title = `@${route.username} — KEX Developer Profile`;
    await loadProfileData(route.username);
  } else if (route.kind === 'repo') {
    document.title = `${route.owner}/${route.repo} — KEX`;
    await loadRepoBrowserData(route.owner, route.repo, route.path, route.file);
  }

  window.scrollTo({ top: 0, behavior: 'auto' });
}

// ---- Shared Header (STRICTLY NO AVATARS OR INITIALS CIRCLES) ----
function renderHeaderBar(dark = true): string {
  const brandLink = `<a href="/" class="brand-btn" aria-label="KEX Home">kex</a>`;
  const btnCls = dark ? 'btn-ghost-dk' : '';
  const primaryCls = dark ? 'btn-light-dk' : 'btn-dark';

  const authNav = state.me
    ? `
      <a href="/explore" class="btn ${btnCls} btn-sm" data-nav><i data-lucide="compass"></i><span>Explore</span></a>
      <a href="/dashboard" class="btn ${btnCls} btn-sm" data-nav><i data-lucide="layout-dashboard"></i><span>Dashboard</span></a>
      <a href="/new" class="btn ${primaryCls} btn-sm" data-nav><i data-lucide="plus"></i><span>New Repository</span></a>
      <a href="/${encodeURIComponent(state.me.username)}" class="pill-profile" data-nav aria-label="Open developer profile">
        <i data-lucide="user-round"></i>
        <span class="mono">@${esc(state.me.username)}</span>
      </a>
      <button type="button" class="btn ${btnCls} btn-sm" id="nav-logout"><i data-lucide="log-out"></i><span>Sign out</span></button>
    `
    : `
      <a href="/explore" class="btn ${btnCls} btn-sm" data-nav><i data-lucide="compass"></i><span>Explore</span></a>
      <a href="/login" class="btn ${btnCls} btn-sm"><i data-lucide="log-in"></i><span>Sign in</span></a>
      <a href="/login#signup" class="btn ${primaryCls} btn-sm"><i data-lucide="user-plus"></i><span>Create account</span></a>
    `;

  return `
    <div class="top-inline ${dark ? '' : 'lt'}">
      ${brandLink}
      <nav class="nav-actions" aria-label="Workspace navigation">
        ${authNav}
      </nav>
    </div>
  `;
}

// ---- View: Explore ----
function renderExplore(route: Extract<RouteState, { kind: 'explore' }>): string {
  const repos = state.exploreRepos;
  const st = state.exploreStats;

  return `
    <section class="sec-dk dk" style="padding-top:clamp(18px,2.6vh,32px)">
      ${renderHeaderBar(true)}
      <div class="hero-grid">
        <div>
          <h1 class="hero-title">kex: host folders, share repositories.</h1>
          <p class="dk-mut" style="margin-top:1rem;max-width:54ch;font-size:1.02rem">
            Upload complete local project folders with nested directory trees preserved, keep sensitive work private on the server, and publish your developer profile with README.md.
          </p>
          <form class="hero-search" id="explore-search-form">
            <i data-lucide="search" style="color:#a0a0a6"></i>
            <input id="explore-search-input" type="search" value="${esc(route.query)}" placeholder="Search public repositories, owners, or descriptions..." aria-label="Search public repositories">
            <span class="kbd">/</span>
            <button type="submit" class="btn btn-light-dk btn-sm">Search</button>
          </form>
        </div>
        <div>
          <div class="pn-dk" style="padding:1.15rem">
            <span class="mono dk-mut" style="font-size:.78rem">QUICK START</span>
            <div class="cmd-box mono">
              <i data-lucide="folder-tree" style="color:#a0a0a6"></i>
              <code>/${state.me ? esc(state.me.username) : 'username'}/my-project</code>
              <a href="${state.me ? '/new' : '/login#signup'}" class="btn btn-light-dk btn-sm" ${state.me ? 'data-nav' : ''}>New Repo</a>
            </div>
            <p class="dk-mut" style="font-size:.84rem;margin-top:.75rem">
              Zero profile avatars · Immediate-child folder tree · Private repos enforced server-side.
            </p>
          </div>
        </div>
      </div>

      <div class="counters">
        <div class="counter-cell"><b class="mono">${st.publicRepositories}</b><span>Public Repositories</span></div>
        <div class="counter-cell"><b class="mono">${st.publicFiles}</b><span>Public Files</span></div>
        <div class="counter-cell"><b class="mono">${st.developers}</b><span>Developers</span></div>
        <div class="counter-cell"><b class="mono">${st.profileReadmes}</b><span>Profile READMEs</span></div>
      </div>
    </section>

    <section class="sec-lt">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:.75rem;flex-wrap:wrap">
        <div>
          <h2 class="sec-title">Public Repositories</h2>
          <p class="mut" style="font-size:.9rem;margin-top:.2rem">
            Showing <b style="color:var(--ink)">${repos.length}</b> public ${repos.length === 1 ? 'repository' : 'repositories'}${route.query ? ` matching "${esc(route.query)}"` : ''}.
          </p>
        </div>
        <div style="display:flex;gap:.55rem;align-items:center;flex-wrap:wrap">
          <select id="explore-sort" class="select-box" aria-label="Sort public repositories">
            <option value="recent"${route.sort === 'recent' ? ' selected' : ''}>Recently Updated</option>
            <option value="name"${route.sort === 'name' ? ' selected' : ''}>Name A–Z</option>
            <option value="files"${route.sort === 'files' ? ' selected' : ''}>Most Files</option>
          </select>
          ${route.query ? `<button type="button" class="btn btn-sm" id="explore-clear">Clear search</button>` : ''}
        </div>
      </div>

      <div class="pkg-list">
        ${
          state.exploreLoading
            ? `<div class="pn" style="padding:2rem;text-align:center" class="mut">Loading public repositories...</div>`
            : repos.length > 0
            ? repos
                .map((r) => {
                  const owner = r.owner_username || '';
                  return `
                    <article class="pn pkg-card">
                      <div>
                        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:.45rem">
                          <a href="/${encodeURIComponent(owner)}" class="mono mut" style="font-size:.94rem" data-nav>@${esc(owner)}</a>
                          <span class="mut">/</span>
                          <a href="/${encodeURIComponent(owner)}/${encodeURIComponent(r.name)}" class="pkg-name-link mono" data-nav>${esc(r.name)}</a>
                          <span class="chip" style="font-size:.72rem"><i data-lucide="globe"></i>Public</span>
                        </div>
                        <p class="mut" style="margin-top:.4rem;font-size:.92rem">${r.description ? esc(r.description) : 'No description provided.'}</p>
                        <div class="pkg-meta mono">
                          <span>${Number(r.file_count || 0)} files</span>
                          <span>${fmtBytes(Number(r.total_bytes || 0))}</span>
                          <span>Updated ${fmtDate(r.updated_at)}</span>
                        </div>
                      </div>
                      <div class="pkg-right">
                        <a href="/${encodeURIComponent(owner)}/${encodeURIComponent(r.name)}" class="btn btn-dark btn-sm" data-nav>
                          <i data-lucide="folder-open"></i>Browse Repo
                        </a>
                      </div>
                    </article>
                  `;
                })
                .join('')
            : `
              <div class="pn" style="padding:2.5rem;text-align:center">
                <p style="font-weight:700;font-size:1.05rem">${route.query ? 'No public repositories matched your query.' : 'No public repositories yet.'}</p>
                <p class="mut" style="font-size:.9rem;margin-top:.35rem">
                  ${route.query ? 'Try a different keyword or clear your search filter.' : 'Create the first repository and upload a local project folder.'}
                </p>
                <div style="margin-top:1rem">
                  <a href="${state.me ? '/new' : '/login#signup'}" class="btn btn-dark btn-sm" ${state.me ? 'data-nav' : ''}>
                    <i data-lucide="folder-plus"></i>Create Repository
                  </a>
                </div>
              </div>
            `
        }
      </div>
    </section>
  `;
}

// ---- View: Dashboard ----
function renderDashboard(): string {
  const me = state.me!;
  const repos = state.myRepos;
  const pubCount = repos.filter((r) => r.visibility === 'public').length;
  const privCount = repos.filter((r) => r.visibility === 'private').length;
  const totalFiles = repos.reduce((sum, r) => sum + Number(r.file_count || 0), 0);

  return `
    <div class="wrap" style="display:grid;gap:1.8rem;padding-top:clamp(18px,2.6vh,32px)">
      ${renderHeaderBar(false)}
      <div style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:1rem">
        <div>
          <span class="mono mut" style="font-size:.8rem">DEVELOPER WORKSPACE · @${esc(me.username)}</span>
          <h1 style="font-size:clamp(1.7rem,2.8vw,2.4rem);margin-top:.2rem">Repository Dashboard</h1>
        </div>
        <div style="display:flex;gap:.55rem;flex-wrap:wrap">
          <a href="/${encodeURIComponent(me.username)}" class="btn btn-sm" data-nav><i data-lucide="user-round"></i>Developer Profile</a>
          <a href="/${encodeURIComponent(me.username)}?tab=readme" class="btn btn-sm" data-nav><i data-lucide="file-pen-line"></i>Profile README.md</a>
          <a href="/new" class="btn btn-dark btn-sm" data-nav><i data-lucide="folder-plus"></i>New Repository</a>
        </div>
      </div>

      <div class="counters" style="margin-top:0">
        <div class="counter-cell" style="background:var(--pn);color:var(--ink)"><b class="mono">${repos.length}</b><span class="mut" style="color:var(--mut)">Your Repositories</span></div>
        <div class="counter-cell" style="background:var(--pn);color:var(--ink)"><b class="mono">${pubCount}</b><span class="mut" style="color:var(--mut)">Public</span></div>
        <div class="counter-cell" style="background:var(--pn);color:var(--ink)"><b class="mono">${privCount}</b><span class="mut" style="color:var(--mut)">Private</span></div>
        <div class="counter-cell" style="background:var(--pn);color:var(--ink)"><b class="mono">${totalFiles}</b><span class="mut" style="color:var(--mut)">Hosted Files</span></div>
      </div>

      <section>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.8rem;gap:.75rem;flex-wrap:wrap">
          <h2 class="sec-title">Your Repositories (${repos.length})</h2>
        </div>

        ${
          state.dashLoading
            ? `<div class="pn" style="padding:2rem;text-align:center" class="mut">Loading repositories...</div>`
            : repos.length > 0
            ? `
              <div class="pn tbl-wrap">
                <table class="tbl">
                  <thead>
                    <tr>
                      <th>Repository</th>
                      <th>Visibility</th>
                      <th>Repo README</th>
                      <th>Files</th>
                      <th>Size</th>
                      <th>Updated</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${repos
                      .map((r) => {
                        const slugUrl = `/${encodeURIComponent(me.username)}/${encodeURIComponent(r.name)}`;
                        return `
                          <tr>
                            <td>
                              <a href="${slugUrl}" class="pkg-name-link mono" style="font-size:.95rem" data-nav>${esc(r.name)}</a>
                              ${r.description ? `<div class="mut" style="font-size:.82rem;margin-top:.15rem">${esc(r.description)}</div>` : ''}
                            </td>
                            <td>
                              <span class="chip ${r.visibility === 'private' ? 'chip-solid' : ''}" style="font-size:.73rem">
                                <i data-lucide="${r.visibility === 'private' ? 'lock' : 'globe'}"></i>${r.visibility === 'private' ? 'Private' : 'Public'}
                              </span>
                            </td>
                            <td class="mono" style="font-size:.82rem">${r.readme_enabled ? 'Enabled' : 'Disabled'}</td>
                            <td class="mono">${Number(r.file_count || 0)}</td>
                            <td class="mono">${fmtBytes(Number(r.total_bytes || 0))}</td>
                            <td class="mono mut">${fmtDate(r.updated_at)}</td>
                            <td>
                              <div style="display:flex;gap:.4rem;flex-wrap:wrap">
                                <a href="${slugUrl}" class="btn btn-sm" data-nav><i data-lucide="folder-open"></i>Browse</a>
                                <a href="${slugUrl}?tab=upload" class="btn btn-sm" data-nav><i data-lucide="upload"></i>Upload</a>
                                <a href="${slugUrl}?tab=settings" class="btn btn-sm" data-nav><i data-lucide="settings"></i>Settings</a>
                              </div>
                            </td>
                          </tr>
                        `;
                      })
                      .join('')}
                  </tbody>
                </table>
              </div>
            `
            : `
              <div class="pn" style="padding:2.4rem;text-align:center">
                <p style="font-weight:700;font-size:1.05rem">You haven’t created a repository yet.</p>
                <p class="mut" style="font-size:.9rem;margin-top:.35rem">Create a public or private repository and upload an existing project folder while keeping every nested subdirectory intact.</p>
                <div style="margin-top:1rem">
                  <a href="/new" class="btn btn-dark btn-sm" data-nav><i data-lucide="folder-plus"></i>Create Your First Repository</a>
                </div>
              </div>
            `
        }
      </section>
    </div>
  `;
}

// ---- View: Create Repository & Upload Folder ----
function renderNewRepo(): string {
  const me = state.me!;
  const files = state.newFiles;
  const totalBytes = files.reduce((s, f) => s + f.file.size, 0);
  const preview = files.slice(0, 25);

  return `
    <div class="wrap" style="display:grid;gap:1.5rem;padding-top:clamp(18px,2.6vh,32px);max-width:960px;width:100%;margin:0 auto">
      ${renderHeaderBar(false)}
      <div style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:1rem">
        <div>
          <span class="mono mut" style="font-size:.8rem">NEW PROJECT · @${esc(me.username)}</span>
          <h1 style="font-size:clamp(1.6rem,2.6vw,2.2rem);margin-top:.2rem">Create Repository &amp; Upload Folder</h1>
        </div>
        <a href="/dashboard" class="btn btn-sm" data-nav><i data-lucide="arrow-left"></i>Back to Dashboard</a>
      </div>

      ${
        state.newRepoError
          ? `
            <div class="err-banner">
              <i data-lucide="alert-circle"></i>
              <div style="flex:1">${esc(state.newRepoError)}</div>
              ${state.newRepoCreatedSlug ? `<a href="${esc(state.newRepoCreatedSlug)}?tab=upload" class="btn btn-dark btn-sm" data-nav>Open Repo Upload</a>` : ''}
            </div>
          `
          : ''
      }

      <form id="new-repo-form" class="pn form-grid" style="padding:1.4rem">
        <div class="form-grid two-col">
          <div class="field">
            <label for="repo-name">Repository Name</label>
            <input id="repo-name" class="mono" placeholder="my-project" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}">
            <small class="mut" style="font-size:.76rem;display:block;margin-top:.25rem">URL: /${esc(me.username)}/&lt;repo-name&gt;</small>
          </div>
          <div class="field">
            <label for="repo-vis">Visibility</label>
            <select id="repo-vis">
              <option value="public">Public — anyone can view &amp; browse</option>
              <option value="private">Private — only you can view &amp; browse</option>
            </select>
          </div>
        </div>

        <div class="field">
          <label for="repo-desc">Description (optional)</label>
          <input id="repo-desc" placeholder="Short summary of your project" maxlength="500">
        </div>

        <div>
          <label class="chk-line">
            <input type="checkbox" id="repo-readme-enabled" checked>
            <span>Enable repository <code class="mono">README.md</code> display below root directory listing</span>
          </label>
        </div>

        <div style="border-top:1px solid var(--ln);padding-top:1rem">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.65rem">
            <div>
              <strong style="font-size:.94rem">Project Folder (optional on create, upload nested paths)</strong>
              <p class="mut" style="font-size:.82rem">Preserves nested paths like <span class="mono">src/components/Button.svelte</span>. Outer wrapper folder name is stripped automatically.</p>
            </div>
            ${files.length > 0 ? `<button type="button" class="btn btn-sm" id="new-clear-files">Clear (${files.length})</button>` : ''}
          </div>

          <div class="dropzone" id="new-dropzone">
            <i data-lucide="folder-up" style="width:1.8rem;height:1.8rem;margin-bottom:.4rem"></i>
            <p style="font-weight:600;font-size:.94rem">Drop a local project folder here, or pick from disk</p>
            <p class="mut" style="font-size:.8rem;margin-top:.2rem">Max 10 MB per file · Up to 250 files / 45 MB per upload batch</p>
            <div style="display:flex;justify-content:center;gap:.6rem;flex-wrap:wrap;margin-top:.9rem">
              <button type="button" class="btn btn-dark btn-sm" id="pick-folder-btn"><i data-lucide="folder"></i>Select Folder</button>
              <button type="button" class="btn btn-sm" id="pick-files-btn"><i data-lucide="files"></i>Select Files</button>
            </div>
            <input type="file" id="new-folder-input" webkitdirectory directory multiple hidden>
            <input type="file" id="new-files-input" multiple hidden>
          </div>

          ${
            files.length > 0
              ? `
                <div class="pn" style="margin-top:.9rem;background:var(--bg);padding:.9rem">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem;font-size:.84rem">
                    <strong>${files.length} file${files.length === 1 ? '' : 's'} queued</strong>
                    <span class="mono mut">${fmtBytes(totalBytes)}</span>
                  </div>
                  <div class="mono" style="font-size:.78rem;display:grid;gap:.22rem;max-height:190px;overflow-y:auto">
                    ${preview.map((f) => `<div style="display:flex;justify-content:space-between;gap:.75rem"><span>${esc(f.relativePath)}</span><span class="mut">${fmtBytes(f.file.size)}</span></div>`).join('')}
                    ${files.length > preview.length ? `<div class="mut">...and ${files.length - preview.length} more files</div>` : ''}
                  </div>
                </div>
              `
              : ''
          }
        </div>

        ${
          state.newSubmitting || state.newUploadStatus
            ? `
              <div style="display:grid;gap:.4rem">
                <div class="prog-track"><div class="prog-fill" style="width:${state.newUploadPct}%"></div></div>
                <span class="mono mut" style="font-size:.8rem">${esc(state.newUploadStatus)}</span>
              </div>
            `
            : ''
        }

        <div style="display:flex;justify-content:flex-end;gap:.6rem;padding-top:.4rem">
          <a href="/dashboard" class="btn" data-nav>Cancel</a>
          <button type="submit" class="btn btn-dark" id="new-submit-btn" ${state.newSubmitting ? 'disabled' : ''}>
            <i data-lucide="check"></i><span>${files.length > 0 ? 'Create Repository & Upload Folder' : 'Create Empty Repository'}</span>
          </button>
        </div>
      </form>
    </div>
  `;
}

// ---- View: Repository Browser (/:owner/:repo) ----
function renderRepoBrowser(route: Extract<RouteState, { kind: 'repo' }>): string {
  if (state.repoLoading) {
    return `
      <div class="wrap" style="padding-top:clamp(18px,2.6vh,32px)">
        ${renderHeaderBar(false)}
        <div class="pn" style="padding:2.5rem;text-align:center" class="mut">Loading repository...</div>
      </div>
    `;
  }

  if (state.repoNotFound || !state.repoData) {
    return `
      <div class="wrap" style="padding-top:clamp(18px,2.6vh,32px)">
        ${renderHeaderBar(false)}
        <div class="pn" style="padding:3rem 1.5rem;text-align:center;max-width:560px;margin:2rem auto">
          <i data-lucide="folder-x" style="width:2rem;height:2rem;margin-bottom:.6rem"></i>
          <h1 style="font-size:1.5rem">Repository not found</h1>
          <p class="mut" style="margin-top:.45rem;font-size:.92rem">
            This repository either does not exist or is private and requires authorization from its owner.
          </p>
          <div style="display:flex;justify-content:center;gap:.6rem;margin-top:1.2rem;flex-wrap:wrap">
            <a href="/explore" class="btn btn-dark btn-sm" data-nav><i data-lucide="compass"></i>Explore Public Projects</a>
            ${!state.me ? `<a href="/login?next=${encodeURIComponent(location.pathname)}" class="btn btn-sm"><i data-lucide="log-in"></i>Sign in</a>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  const repo = state.repoData;
  const owner = repo.owner_username || route.owner;
  const isOwner = state.repoIsOwner;
  const baseSlug = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo.name)}`;
  const activeTab = !isOwner && (route.tab === 'upload' || route.tab === 'settings') ? 'code' : route.tab;

  // Breadcrumb segments
  const dirSegments = route.path ? route.path.split('/').filter(Boolean) : [];
  const parentDir = dirSegments.length > 1 ? dirSegments.slice(0, -1).join('/') : '';

  let bodyHtml = '';

  if (activeTab === 'code') {
    if (route.file) {
      if (state.fileLoading) {
        bodyHtml = `<div class="pn" style="padding:2rem;text-align:center" class="mut">Loading file...</div>`;
      } else if (!state.fileData) {
        bodyHtml = `
          <div class="pn" style="padding:2rem;text-align:center">
            <p style="font-weight:600">${esc(state.treeError || 'File not found.')}</p>
            <button type="button" class="btn btn-sm" id="file-back-btn" style="margin-top:.75rem">Back to folder</button>
          </div>
        `;
      } else {
        const fd = state.fileData;
        const downloadUrl = `/api/repositories/${encodeURIComponent(repo.id)}/download?path=${encodeURIComponent(fd.path)}`;
        const parentOfFile = fd.path.includes('/') ? fd.path.slice(0, fd.path.lastIndexOf('/')) : '';

        if (fd.is_binary) {
          bodyHtml = `
            <div class="code-viewer-box">
              <div class="code-viewer-head">
                <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
                  <button type="button" class="btn btn-sm" id="file-back-btn" data-back-dir="${esc(parentOfFile)}"><i data-lucide="arrow-left"></i>Back</button>
                  <span class="mono" style="font-weight:700">${esc(fd.path)}</span>
                  <span class="mut mono">${fmtBytes(fd.size_bytes)}</span>
                </div>
                <a href="${downloadUrl}" class="btn btn-dark btn-sm"><i data-lucide="download"></i>Download</a>
              </div>
              <div style="padding:2.6rem 1.2rem;text-align:center">
                <i data-lucide="file-archive" style="width:2rem;height:2rem;margin-bottom:.5rem"></i>
                <p style="font-weight:700">Binary or large file</p>
                <p class="mut" style="font-size:.88rem;margin-top:.25rem">
                  Type: <span class="mono">${esc(fd.content_type)}</span> · Size: <span class="mono">${fmtBytes(fd.size_bytes)}</span>. Download to inspect locally.
                </p>
                <a href="${downloadUrl}" class="btn btn-dark btn-sm" style="margin-top:1rem"><i data-lucide="download"></i>Download File</a>
              </div>
            </div>
          `;
        } else {
          const text = fd.content ?? '';
          const lines = text.split('\n');
          bodyHtml = `
            <div class="code-viewer-box">
              <div class="code-viewer-head">
                <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
                  <button type="button" class="btn btn-sm" id="file-back-btn" data-back-dir="${esc(parentOfFile)}"><i data-lucide="arrow-left"></i>Back</button>
                  <span class="mono" style="font-weight:700">${esc(fd.path)}</span>
                  <span class="mut mono">${lines.length} lines · ${fmtBytes(fd.size_bytes)}</span>
                </div>
                <div style="display:flex;gap:.45rem;flex-wrap:wrap">
                  ${
                    fd.rendered_html
                      ? `
                        <button type="button" class="btn btn-sm ${state.fileRenderMode === 'rendered' ? 'btn-dark' : ''}" id="file-mode-rendered">Rendered</button>
                        <button type="button" class="btn btn-sm ${state.fileRenderMode === 'source' ? 'btn-dark' : ''}" id="file-mode-source">Source</button>
                      `
                      : ''
                  }
                  <button type="button" class="btn btn-sm" id="copy-file-btn"><i data-lucide="copy"></i>Copy</button>
                  <a href="${downloadUrl}" class="btn btn-dark btn-sm"><i data-lucide="download"></i>Download</a>
                </div>
              </div>
              ${
                fd.rendered_html && state.fileRenderMode === 'rendered'
                  ? `<div class="md-body">${fd.rendered_html}</div>`
                  : `<div class="code-lines">${lines
                      .map((l, idx) => `<div class="code-line"><span class="ln-no">${idx + 1}</span><span class="ln-txt">${esc(l) || ' '}</span></div>`)
                      .join('')}</div>`
              }
            </div>
          `;
        }
      }
    } else {
      // Directory immediate-child browser
      const crumbsHtml = `
        <div class="crumbs mono">
          <button type="button" class="crumb-btn" data-nav-dir="">${esc(repo.name)}</button>
          ${dirSegments
            .map((seg, i) => {
              const segPath = dirSegments.slice(0, i + 1).join('/');
              return `<span class="mut">/</span><button type="button" class="crumb-btn" data-nav-dir="${esc(segPath)}">${esc(seg)}</button>`;
            })
            .join('')}
        </div>
      `;

      const treeContent = state.treeLoading
        ? `<div style="padding:2rem;text-align:center" class="mut">Loading folder contents...</div>`
        : state.treeError
        ? `<div style="padding:2rem;text-align:center">${esc(state.treeError)}</div>`
        : state.treeEntries.length === 0
        ? `
          <div style="padding:2.4rem 1.2rem;text-align:center">
            <p style="font-weight:600">This repository has no uploaded files yet.</p>
            ${
              isOwner
                ? `<p class="mut" style="font-size:.88rem;margin-top:.3rem">Upload a local project folder to preserve its nested structure here.</p>
                   <button type="button" class="btn btn-dark btn-sm" id="empty-go-upload" style="margin-top:.9rem"><i data-lucide="folder-up"></i>Upload Project Folder</button>`
                : ''
            }
          </div>
        `
        : `
          ${
            route.path
              ? `
                <div class="tree-row">
                  <button type="button" class="tree-entry-btn mono" data-nav-dir="${esc(parentDir)}">
                    <i data-lucide="corner-left-up"></i><span>.. (parent folder)</span>
                  </button>
                  <span></span>
                  <span></span>
                </div>
              `
              : ''
          }
          ${state.treeEntries
            .map((entry) => {
              if (entry.type === 'folder') {
                return `
                  <div class="tree-row">
                    <button type="button" class="tree-entry-btn mono" style="font-weight:600" data-nav-dir="${esc(entry.path)}">
                      <i data-lucide="folder"></i><span>${esc(entry.name)}/</span>
                    </button>
                    <span class="mut mono" style="font-size:.8rem">${entry.item_count} ${entry.item_count === 1 ? 'file' : 'files'}</span>
                    <span class="mut mono" style="font-size:.8rem">Folder</span>
                  </div>
                `;
              }
              const dl = `/api/repositories/${encodeURIComponent(repo.id)}/download?path=${encodeURIComponent(entry.path)}`;
              return `
                <div class="tree-row">
                  <button type="button" class="tree-entry-btn mono" data-nav-file="${esc(entry.path)}">
                    <i data-lucide="file-code-2"></i><span>${esc(entry.name)}</span>
                  </button>
                  <span class="mut mono" style="font-size:.8rem">${fmtBytes(entry.size_bytes)}</span>
                  <a href="${dl}" class="btn btn-sm" title="Download ${esc(entry.name)}"><i data-lucide="download"></i></a>
                </div>
              `;
            })
            .join('')}
        `;

      const repoReadmeHtml =
        route.path === '' && repo.readme_enabled && state.treeReadme
          ? `
            <div class="pn" style="margin-top:1.4rem;overflow:hidden">
              <div class="crumbs mono" style="justify-content:space-between">
                <span><i data-lucide="book-open" style="vertical-align:-2px;margin-right:.35rem"></i>${esc(state.treeReadme.path)}</span>
                <span class="mut" style="font-size:.76rem">Repository README</span>
              </div>
              <div class="md-body">${state.treeReadme.html}</div>
            </div>
          `
          : '';

      bodyHtml = `
        <div class="pn" style="overflow:hidden">
          ${crumbsHtml}
          ${treeContent}
        </div>
        ${repoReadmeHtml}
      `;
    }
  } else if (activeTab === 'upload' && isOwner) {
    const files = state.repoUploadFiles;
    const totalBytes = files.reduce((s, f) => s + f.file.size, 0);
    const preview = files.slice(0, 25);

    bodyHtml = `
      <div class="pn" style="padding:1.4rem;display:grid;gap:1rem">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
          <div>
            <h2 style="font-size:1.2rem">Upload Folder to ${esc(repo.name)}</h2>
            <p class="mut" style="font-size:.86rem">Select a local folder or files. Nested relative paths are preserved automatically.</p>
          </div>
          ${files.length > 0 ? `<button type="button" class="btn btn-sm" id="repo-clear-files">Clear (${files.length})</button>` : ''}
        </div>

        ${state.repoUploadError ? `<div class="err-banner"><i data-lucide="alert-circle"></i><span>${esc(state.repoUploadError)}</span></div>` : ''}

        <div class="dropzone" id="repo-dropzone">
          <i data-lucide="folder-up" style="width:1.8rem;height:1.8rem;margin-bottom:.4rem"></i>
          <p style="font-weight:600">Drop a project folder here, or pick from disk</p>
          <div style="display:flex;justify-content:center;gap:.6rem;flex-wrap:wrap;margin-top:.85rem">
            <button type="button" class="btn btn-dark btn-sm" id="repo-pick-folder"><i data-lucide="folder"></i>Select Folder</button>
            <button type="button" class="btn btn-sm" id="repo-pick-files"><i data-lucide="files"></i>Select Files</button>
          </div>
          <input type="file" id="repo-folder-input" webkitdirectory directory multiple hidden>
          <input type="file" id="repo-files-input" multiple hidden>
        </div>

        <label class="chk-line">
          <input type="checkbox" id="repo-overwrite-chk" ${state.repoUploadOverwrite ? 'checked' : ''}>
          <span>Overwrite existing files if relative paths already exist in this repository</span>
        </label>

        ${
          files.length > 0
            ? `
              <div class="pn" style="background:var(--bg);padding:.9rem">
                <div style="display:flex;justify-content:space-between;margin-bottom:.45rem;font-size:.84rem">
                  <strong>${files.length} file${files.length === 1 ? '' : 's'} ready</strong>
                  <span class="mono mut">${fmtBytes(totalBytes)}</span>
                </div>
                <div class="mono" style="font-size:.78rem;display:grid;gap:.2rem;max-height:180px;overflow-y:auto">
                  ${preview.map((f) => `<div style="display:flex;justify-content:space-between;gap:.75rem"><span>${esc(f.relativePath)}</span><span class="mut">${fmtBytes(f.file.size)}</span></div>`).join('')}
                  ${files.length > preview.length ? `<div class="mut">...and ${files.length - preview.length} more files</div>` : ''}
                </div>
              </div>
            `
            : ''
        }

        ${
          state.repoUploading || state.repoUploadStatus
            ? `
              <div style="display:grid;gap:.4rem">
                <div class="prog-track"><div class="prog-fill" style="width:${state.repoUploadPct}%"></div></div>
                <span class="mono mut" style="font-size:.8rem">${esc(state.repoUploadStatus)}</span>
              </div>
            `
            : ''
        }

        <div style="display:flex;justify-content:flex-end;gap:.6rem">
          <button type="button" class="btn btn-dark" id="repo-upload-submit" ${files.length === 0 || state.repoUploading ? 'disabled' : ''}>
            <i data-lucide="upload"></i><span>Upload ${files.length > 0 ? `${files.length} Files` : 'Folder'}</span>
          </button>
        </div>
      </div>
    `;
  } else if (activeTab === 'settings' && isOwner) {
    bodyHtml = `
      <div style="display:grid;gap:1.25rem;max-width:720px">
        <form id="repo-settings-form" class="pn form-grid" style="padding:1.4rem">
          <h2 style="font-size:1.2rem">Repository Settings</h2>
          <div class="form-grid two-col">
            <div class="field">
              <label for="set-repo-name">Repository Name</label>
              <input id="set-repo-name" class="mono" value="${esc(repo.name)}" required>
            </div>
            <div class="field">
              <label for="set-repo-vis">Visibility</label>
              <select id="set-repo-vis">
                <option value="public"${repo.visibility === 'public' ? ' selected' : ''}>Public</option>
                <option value="private"${repo.visibility === 'private' ? ' selected' : ''}>Private</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label for="set-repo-desc">Description</label>
            <input id="set-repo-desc" value="${esc(repo.description)}" maxlength="500">
          </div>
          <label class="chk-line">
            <input type="checkbox" id="set-repo-readme" ${repo.readme_enabled ? 'checked' : ''}>
            <span>Render repository <code class="mono">README.md</code> below root file list</span>
          </label>
          <div style="display:flex;justify-content:flex-end">
            <button type="submit" class="btn btn-dark"><i data-lucide="save"></i>Save Settings</button>
          </div>
        </form>

        <div class="pn" style="padding:1.4rem;display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap">
          <div>
            <h3 style="font-size:1.05rem">Delete Repository</h3>
            <p class="mut" style="font-size:.86rem;margin-top:.2rem">Permanently removes this repository and all uploaded files from storage.</p>
          </div>
          <button type="button" class="btn btn-dark btn-sm" id="delete-repo-btn"><i data-lucide="trash-2"></i>Delete Repository</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="pkg-head-card dk" style="padding-top:clamp(18px,2.6vh,32px)">
      ${renderHeaderBar(true)}
      <div class="pkg-head-grid">
        <div>
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:.5rem">
            <a href="/${encodeURIComponent(owner)}" class="mono dk-mut" style="font-size:1.15rem;text-decoration:underline;text-underline-offset:3px" data-nav>@${esc(owner)}</a>
            <span class="dk-mut">/</span>
            <h1 class="mono" style="font-size:clamp(1.5rem,2.6vw,2.2rem)">${esc(repo.name)}</h1>
            <span class="chip chip-dk" style="font-size:.75rem">
              <i data-lucide="${repo.visibility === 'private' ? 'lock' : 'globe'}"></i>${repo.visibility === 'private' ? 'Private' : 'Public'}
            </span>
          </div>
          <p class="dk-mut" style="margin-top:.6rem;max-width:62ch">${repo.description ? esc(repo.description) : 'No repository description.'}</p>
        </div>
        <div class="pn-dk" style="padding:.95rem 1.1rem;display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap">
          <div class="mono" style="font-size:.84rem">
            <div><strong style="color:#ececee">${Number(repo.file_count || 0)}</strong> <span class="dk-mut">files</span></div>
            <div><strong style="color:#ececee">${fmtBytes(Number(repo.total_bytes || 0))}</strong> <span class="dk-mut">total</span></div>
          </div>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap">
            <button type="button" class="btn btn-ghost-dk btn-sm" id="copy-repo-url"><i data-lucide="copy"></i>Copy URL</button>
            ${isOwner ? `<button type="button" class="btn btn-light-dk btn-sm" id="repo-quick-upload"><i data-lucide="upload"></i>Upload Folder</button>` : ''}
          </div>
        </div>
      </div>
    </div>

    <div class="wrap">
      <div class="subtabs" role="tablist" aria-label="Repository tabs">
        <a href="${baseSlug}" class="subtab" data-nav aria-selected="${activeTab === 'code'}"><i data-lucide="folder-tree"></i>Code</a>
        ${isOwner ? `<a href="${baseSlug}?tab=upload" class="subtab" data-nav aria-selected="${activeTab === 'upload'}"><i data-lucide="folder-up"></i>Upload Folder</a>` : ''}
        ${isOwner ? `<a href="${baseSlug}?tab=settings" class="subtab" data-nav aria-selected="${activeTab === 'settings'}"><i data-lucide="settings"></i>Settings</a>` : ''}
      </div>
      ${bodyHtml}
    </div>
  `;
}

// ---- View: Developer Profile (/:username) — STRICTLY NO AVATARS OR INITIALS CIRCLES ----
function buildHeatmapHtml(heatmap: HeatmapDay[]): string {
  const totalEvents = heatmap.reduce((s, d) => s + d.count, 0);
  const cells = heatmap
    .map(
      (d) =>
        `<button type="button" class="hm-cell" data-l="${d.level}" title="${d.count} ${d.count === 1 ? 'activity' : 'activities'} on ${esc(d.date)}" aria-label="${d.count} activities on ${esc(d.date)}"></button>`
    )
    .join('');

  return `
    <div class="pn hm-wrap">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;flex-wrap:wrap;gap:.5rem">
        <span style="font-weight:700;font-size:.94rem">26-Week Activity</span>
        <span class="mut mono" style="font-size:.78rem">${totalEvents} recorded events · 182 days</span>
      </div>
      <div class="hm-grid">${cells}</div>
    </div>
  `;
}

function socialIcon(platform: string): string {
  switch (platform) {
    case 'github': return 'github';
    case 'linkedin': return 'linkedin';
    case 'youtube': return 'youtube';
    case 'email': return 'mail';
    case 'website':
    case 'portfolio': return 'globe';
    default: return 'link';
  }
}

function renderProfile(route: Extract<RouteState, { kind: 'profile' }>): string {
  if (state.profileLoading) {
    return `
      <div class="wrap" style="padding-top:clamp(18px,2.6vh,32px)">
        ${renderHeaderBar(false)}
        <div class="pn" style="padding:2.5rem;text-align:center" class="mut">Loading developer profile...</div>
      </div>
    `;
  }

  if (state.profileNotFound || !state.profileData) {
    return `
      <div class="wrap" style="padding-top:clamp(18px,2.6vh,32px)">
        ${renderHeaderBar(false)}
        <div class="pn" style="padding:3rem 1.5rem;text-align:center;max-width:560px;margin:2rem auto">
          <i data-lucide="user-x" style="width:2rem;height:2rem;margin-bottom:.6rem"></i>
          <h1 style="font-size:1.5rem">Developer profile not found</h1>
          <p class="mut" style="margin-top:.4rem;font-size:.92rem">No developer account matches <span class="mono">@${esc(route.username)}</span>.</p>
          <div style="margin-top:1rem">
            <a href="/explore" class="btn btn-dark btn-sm" data-nav><i data-lucide="compass"></i>Back to Explore</a>
          </div>
        </div>
      </div>
    `;
  }

  const data = state.profileData;
  const { isOwner, user, profile, images, socialLinks, readme, repositories, heatmap } = data;
  const bannerImg = images.find((img) => img.image_type === 'banner');
  const featuredImg = images.find((img) => img.image_type === 'featured');
  const galleryImgs = images.filter((img) => img.image_type === 'gallery');
  const totalFiles = repositories.reduce((s, r) => s + Number(r.file_count || 0), 0);
  const totalAct = heatmap.reduce((s, d) => s + d.count, 0);

  // Optional metadata items (only rendered when provided and public, or shown with Private badge to owner)
  const metaPills: string[] = [];
  if (profile.location && (profile.location_public || isOwner)) {
    metaPills.push(
      `<span><i data-lucide="map-pin"></i> ${esc(profile.location)}${!profile.location_public && isOwner ? ' (private)' : ''}</span>`
    );
  }
  if (profile.website && (profile.website_public || isOwner)) {
    metaPills.push(
      `<a href="${esc(profile.website)}" target="_blank" rel="noopener noreferrer" style="text-decoration:underline;text-underline-offset:3px"><i data-lucide="globe"></i> ${esc(profile.website)}${!profile.website_public && isOwner ? ' (private)' : ''}</a>`
    );
  }
  if (profile.public_contact && (profile.public_contact_public || isOwner)) {
    metaPills.push(
      `<span><i data-lucide="mail"></i> ${esc(profile.public_contact)}${!profile.public_contact_public && isOwner ? ' (private)' : ''}</span>`
    );
  }

  // Profile README section (separate from repository READMEs)
  const readmeSection = `
    <section class="pn" style="overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:.75rem;flex-wrap:wrap;padding:.85rem 1.25rem;border-bottom:1px solid var(--ln);background:#e4e4e7">
        <div class="mono" style="font-size:.86rem;font-weight:700;display:flex;align-items:center;gap:.45rem">
          <i data-lucide="file-text"></i>
          <span>${esc(user.username)} / README.md</span>
        </div>
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
          ${readme.updated_at ? `<span class="mut mono" style="font-size:.76rem">Updated ${fmtDate(readme.updated_at)}</span>` : ''}
          ${
            isOwner && !state.editingReadme
              ? `<button type="button" class="btn btn-dark btn-sm" id="edit-profile-readme-btn"><i data-lucide="pencil"></i>Edit README</button>`
              : ''
          }
        </div>
      </div>

      ${
        isOwner && state.editingReadme
          ? `
            <div style="padding:1.25rem;display:grid;gap:1rem">
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.6rem">
                <div class="subtabs" style="margin-bottom:0;border-bottom:0;padding-bottom:0">
                  <button type="button" class="subtab" id="readme-mode-edit" aria-selected="${state.readmeMode === 'edit'}"><i data-lucide="code"></i>Edit</button>
                  <button type="button" class="subtab" id="readme-mode-preview" aria-selected="${state.readmeMode === 'preview'}"><i data-lucide="eye"></i>Preview</button>
                </div>
                <button type="button" class="btn btn-sm" id="readme-insert-template"><i data-lucide="sparkles"></i>Insert Starter Template</button>
              </div>

              ${
                state.readmeMode === 'edit'
                  ? `
                    <div class="field">
                      <textarea id="profile-readme-textarea" class="mono" rows="13" placeholder="# Hi, I'm ${esc(profile.display_name)}&#10;&#10;Write your developer profile README.md using Markdown (headings, lists, links, images, code blocks, tables)...">${esc(state.readmeDraft)}</textarea>
                    </div>
                  `
                  : `
                    <div class="pn md-body" style="background:var(--bg);min-height:220px">
                      ${state.readmePreviewHtml || '<p class="mut">Nothing to preview yet.</p>'}
                    </div>
                  `
              }

              <div style="display:flex;justify-content:flex-end;gap:.55rem;flex-wrap:wrap">
                <button type="button" class="btn btn-sm" id="readme-cancel-btn">Cancel</button>
                <button type="button" class="btn btn-dark btn-sm" id="readme-save-btn" ${state.readmeSaving ? 'disabled' : ''}>
                  <i data-lucide="save"></i><span>${state.readmeSaving ? 'Saving...' : 'Save README.md'}</span>
                </button>
              </div>
            </div>
          `
          : readme.has_content
          ? `<div class="md-body">${readme.rendered_html}</div>`
          : `
            <div style="padding:2rem 1.25rem;text-align:center">
              <p class="mut" style="font-size:.92rem">${isOwner ? 'You haven’t written a profile README.md yet.' : 'No profile README.md published yet.'}</p>
              ${
                isOwner
                  ? `<button type="button" class="btn btn-dark btn-sm" id="create-profile-readme-btn" style="margin-top:.8rem"><i data-lucide="file-pen-line"></i>Create Profile README.md</button>`
                  : ''
              }
            </div>
          `
      }
    </section>
  `;

  // Selected Images section (Banner rendered in dark header; Featured & Gallery rendered here ONLY if present)
  const visualsSection =
    featuredImg || galleryImgs.length > 0
      ? `
        <section style="display:grid;gap:1rem">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
            <h2 class="sec-title">Selected Visuals</h2>
            ${isOwner ? `<button type="button" class="btn btn-sm" id="manage-images-btn-2"><i data-lucide="image"></i>Manage Images</button>` : ''}
          </div>
          ${
            featuredImg
              ? `
                <div class="pn" style="overflow:hidden">
                  <img src="${esc(featuredImg.url)}" alt="${esc(featuredImg.caption || 'Featured visual')}" class="featured-img" style="border:0;border-radius:0">
                  ${featuredImg.caption ? `<div class="mut" style="padding:.6rem .9rem;font-size:.84rem;border-top:1px solid var(--ln)">${esc(featuredImg.caption)}</div>` : ''}
                </div>
              `
              : ''
          }
          ${
            galleryImgs.length > 0
              ? `
                <div class="gallery-grid">
                  ${galleryImgs
                    .map(
                      (img) => `
                        <figure class="pn gallery-item">
                          <img src="${esc(img.url)}" alt="${esc(img.caption || 'Gallery image')}">
                          ${img.caption ? `<figcaption class="mut" style="padding:.5rem .75rem;font-size:.8rem">${esc(img.caption)}</figcaption>` : ''}
                        </figure>
                      `
                    )
                    .join('')}
                </div>
              `
              : ''
          }
        </section>
      `
      : '';

  // Repositories section
  const reposSection = `
    <section style="display:grid;gap:.9rem">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.75rem">
        <h2 class="sec-title">${isOwner ? 'Repositories' : 'Public Repositories'} (${repositories.length})</h2>
        ${isOwner ? `<a href="/new" class="btn btn-dark btn-sm" data-nav><i data-lucide="folder-plus"></i>New Repository</a>` : ''}
      </div>

      ${
        repositories.length > 0
          ? `
            <div class="pkg-mini-grid" style="margin-top:0">
              ${repositories
                .map((r) => {
                  const href = `/${encodeURIComponent(user.username)}/${encodeURIComponent(r.name)}`;
                  return `
                    <a href="${href}" class="pn pkg-mini" data-nav>
                      <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;width:100%">
                        <span class="mono" style="font-weight:700;font-size:.98rem">${esc(r.name)}</span>
                        <span class="chip ${r.visibility === 'private' ? 'chip-solid' : ''}" style="font-size:.72rem">
                          <i data-lucide="${r.visibility === 'private' ? 'lock' : 'globe'}"></i>${r.visibility === 'private' ? 'Private' : 'Public'}
                        </span>
                      </div>
                      <p class="mut" style="font-size:.85rem;line-height:1.45">${r.description ? esc(r.description) : 'No description provided.'}</p>
                      <div style="display:flex;justify-content:space-between;align-items:center;width:100%;margin-top:auto;padding-top:.4rem;font-size:.76rem" class="mut mono">
                        <span>${Number(r.file_count || 0)} files</span>
                        <span>${fmtDate(r.updated_at)}</span>
                      </div>
                    </a>
                  `;
                })
                .join('')}
            </div>
          `
          : `<div class="pn" style="padding:2rem;text-align:center" class="mut">${isOwner ? 'No repositories created yet.' : 'No public repositories published yet.'}</div>`
      }
    </section>
  `;

  return `
    <div class="sec-dk dk" style="padding-top:clamp(18px,2.6vh,32px);padding-bottom:2.2rem">
      ${renderHeaderBar(true)}
      ${bannerImg ? `<img src="${esc(bannerImg.url)}" alt="${esc(bannerImg.caption || 'Profile banner')}" class="profile-banner">` : ''}

      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1.5rem">
        <div>
          <div style="display:flex;align-items:center;gap:.65rem;flex-wrap:wrap">
            <h1 style="font-size:clamp(1.75rem,3vw,2.45rem)">${esc(profile.display_name)}</h1>
            <span class="chip chip-dk mono">@${esc(user.username)}</span>
          </div>
          ${profile.bio ? `<p class="dk-mut" style="margin-top:.55rem;max-width:60ch">${esc(profile.bio)}</p>` : ''}
          ${
            metaPills.length > 0
              ? `<div class="dk-mut mono" style="display:flex;flex-wrap:wrap;gap:1rem;margin-top:.7rem;font-size:.82rem">${metaPills.join('')}</div>`
              : ''
          }
          ${
            socialLinks.length > 0
              ? `
                <div style="display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.9rem">
                  ${socialLinks
                    .map(
                      (l) => `
                        <a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" class="chip chip-dk" style="font-size:.78rem">
                          <i data-lucide="${socialIcon(l.platform)}"></i><span>${esc(l.label || l.platform)}</span>
                        </a>
                      `
                    )
                    .join('')}
                </div>
              `
              : ''
          }
        </div>

        ${
          isOwner
            ? `
              <div style="display:flex;gap:.5rem;flex-wrap:wrap">
                <button type="button" class="btn btn-ghost-dk btn-sm" id="edit-profile-modal-btn"><i data-lucide="pencil"></i>Edit Profile</button>
                <button type="button" class="btn btn-ghost-dk btn-sm" id="manage-images-btn"><i data-lucide="image-plus"></i>Selected Images</button>
                <button type="button" class="btn btn-ghost-dk btn-sm" id="manage-links-btn"><i data-lucide="link"></i>Social Links</button>
                <button type="button" class="btn btn-light-dk btn-sm" id="owner-edit-readme-btn"><i data-lucide="file-pen-line"></i>Edit README</button>
              </div>
            `
            : ''
        }
      </div>

      <div class="counters" style="grid-template-columns:repeat(3,1fr);margin-top:1.75rem">
        <div class="counter-cell"><b class="mono">${repositories.length}</b><span>${isOwner ? 'Repositories' : 'Public Repositories'}</span></div>
        <div class="counter-cell"><b class="mono">${totalFiles}</b><span>Total Files</span></div>
        <div class="counter-cell"><b class="mono">${totalAct}</b><span>Activity (182d)</span></div>
      </div>
    </div>

    <div class="wrap" style="display:grid;gap:1.8rem">
      ${readmeSection}
      ${visualsSection}
      ${buildHeatmapHtml(heatmap)}
      ${reposSection}
    </div>
  `;
}

// ---- Owner Modals (Profile Info, Selected Images [no avatars], Social Links) ----
function openEditProfileModal(): void {
  if (!state.profileData) return;
  const { user, profile } = state.profileData;
  openModal('Edit Developer Profile', `
    <form id="modal-profile-form" class="form-grid">
      <div class="form-grid two-col">
        <div class="field">
          <label for="mp-display">Display Name</label>
          <input id="mp-display" value="${esc(profile.display_name)}" required maxlength="80">
        </div>
        <div class="field">
          <label for="mp-username">Username</label>
          <input id="mp-username" class="mono" value="${esc(user.username)}" required pattern="[a-z0-9-]{3,32}">
        </div>
      </div>
      <div class="field">
        <label for="mp-bio">Bio / Description</label>
        <textarea id="mp-bio" rows="3" maxlength="600">${esc(profile.bio)}</textarea>
      </div>
      <div class="field">
        <label for="mp-loc">Location (optional)</label>
        <input id="mp-loc" value="${esc(profile.location)}" maxlength="120" placeholder="City, Country">
        <label class="chk-line" style="margin-top:.35rem">
          <input type="checkbox" id="mp-loc-pub" ${profile.location_public ? 'checked' : ''}>
          <span>Show location on public profile</span>
        </label>
      </div>
      <div class="field">
        <label for="mp-web">Website (optional, https://...)</label>
        <input id="mp-web" value="${esc(profile.website)}" maxlength="300" placeholder="https://example.dev">
        <label class="chk-line" style="margin-top:.35rem">
          <input type="checkbox" id="mp-web-pub" ${profile.website_public ? 'checked' : ''}>
          <span>Show website on public profile</span>
        </label>
      </div>
      <div class="field">
        <label for="mp-contact">Public Contact (optional)</label>
        <input id="mp-contact" value="${esc(profile.public_contact)}" maxlength="180" placeholder="you@domain.dev or Matrix handle">
        <label class="chk-line" style="margin-top:.35rem">
          <input type="checkbox" id="mp-contact-pub" ${profile.public_contact_public ? 'checked' : ''}>
          <span>Show contact info on public profile</span>
        </label>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:.55rem;margin-top:.4rem">
        <button type="button" class="btn" id="mp-cancel">Cancel</button>
        <button type="submit" class="btn btn-dark"><i data-lucide="save"></i>Save Profile</button>
      </div>
    </form>
  `);

  $('#mp-cancel')?.addEventListener('click', closeModal);
  $('#modal-profile-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      display_name: ($('#mp-display') as HTMLInputElement).value.trim(),
      username: ($('#mp-username') as HTMLInputElement).value.trim().toLowerCase(),
      bio: ($('#mp-bio') as HTMLTextAreaElement).value.trim(),
      location: ($('#mp-loc') as HTMLInputElement).value.trim(),
      location_public: ($('#mp-loc-pub') as HTMLInputElement).checked,
      website: ($('#mp-web') as HTMLInputElement).value.trim(),
      website_public: ($('#mp-web-pub') as HTMLInputElement).checked,
      public_contact: ($('#mp-contact') as HTMLInputElement).value.trim(),
      public_contact_public: ($('#mp-contact-pub') as HTMLInputElement).checked,
    };

    const res = await apiJson<{ username: string }>('/api/me/profile', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      showToast(res.data.error || 'Could not update profile.');
      return;
    }
    closeModal();
    await refreshMe();
    showToast('Profile saved');
    navigate(`/${encodeURIComponent(res.data.username)}`, true);
  });
}

function openManageImagesModal(): void {
  if (!state.profileData) return;
  const images = state.profileData.images;
  const banner = images.find((i) => i.image_type === 'banner');
  const featured = images.find((i) => i.image_type === 'featured');
  const gallery = images.filter((i) => i.image_type === 'gallery');

  openModal('Manage Selected Images (No Avatars)', `
    <div class="form-grid">
      <p class="mut" style="font-size:.86rem">Select optional visuals for your developer profile (banner, featured image, and up to 6 gallery images). PNG, JPEG, WebP, or GIF up to 5 MB.</p>

      <div class="pn" style="padding:1rem;display:grid;gap:.6rem">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>Banner Image</strong>
          ${banner ? `<button type="button" class="btn btn-sm img-del-btn" data-img-id="${esc(banner.id)}">Remove</button>` : ''}
        </div>
        ${banner ? `<img src="${esc(banner.url)}" alt="Banner" style="width:100%;max-height:110px;object-fit:cover;border-radius:6px">` : '<span class="mut" style="font-size:.82rem">No banner selected</span>'}
        <form class="img-up-form" data-type="banner" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" required style="flex:1;min-width:180px">
          <button type="submit" class="btn btn-dark btn-sm">${banner ? 'Replace' : 'Upload'}</button>
        </form>
      </div>

      <div class="pn" style="padding:1rem;display:grid;gap:.6rem">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>Featured Image</strong>
          ${featured ? `<button type="button" class="btn btn-sm img-del-btn" data-img-id="${esc(featured.id)}">Remove</button>` : ''}
        </div>
        ${featured ? `<img src="${esc(featured.url)}" alt="Featured" style="width:100%;max-height:110px;object-fit:cover;border-radius:6px">` : '<span class="mut" style="font-size:.82rem">No featured image selected</span>'}
        <form class="img-up-form" data-type="featured" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" required style="flex:1;min-width:180px">
          <input type="text" placeholder="Caption (optional)" maxlength="140" style="width:140px;background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:.35rem .5rem">
          <button type="submit" class="btn btn-dark btn-sm">${featured ? 'Replace' : 'Upload'}</button>
        </form>
      </div>

      <div class="pn" style="padding:1rem;display:grid;gap:.6rem">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>Gallery Images (${gallery.length}/6)</strong>
        </div>
        ${
          gallery.length > 0
            ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:.5rem">
                ${gallery
                  .map(
                    (g) => `
                      <div style="border:1px solid var(--ln);border-radius:6px;overflow:hidden;background:var(--bg)">
                        <img src="${esc(g.url)}" alt="${esc(g.caption || 'Gallery')}" style="width:100%;height:70px;object-fit:cover;display:block">
                        <div style="padding:.35rem;display:flex;justify-content:space-between;align-items:center;gap:.25rem">
                          <span class="mut" style="font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.caption || 'Image')}</span>
                          <button type="button" class="icon-btn img-del-btn" data-img-id="${esc(g.id)}" aria-label="Remove image"><i data-lucide="trash-2"></i></button>
                        </div>
                      </div>
                    `
                  )
                  .join('')}
              </div>`
            : '<span class="mut" style="font-size:.82rem">No gallery images added</span>'
        }
        ${
          gallery.length < 6
            ? `<form class="img-up-form" data-type="gallery" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" required style="flex:1;min-width:180px">
                <input type="text" placeholder="Caption (optional)" maxlength="140" style="width:140px;background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:.35rem .5rem">
                <button type="submit" class="btn btn-dark btn-sm">Add Gallery Image</button>
              </form>`
            : ''
        }
      </div>
    </div>
  `);

  document.querySelectorAll<HTMLFormElement>('.img-up-form').forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fileInp = form.querySelector<HTMLInputElement>('input[type="file"]');
      const capInp = form.querySelector<HTMLInputElement>('input[type="text"]');
      const file = fileInp?.files?.[0];
      if (!file) return;

      const fd = new FormData();
      fd.append('image_type', form.dataset.type || 'gallery');
      fd.append('caption', capInp?.value.trim() || '');
      fd.append('image', file);

      const res = await apiJson('/api/me/profile/images', { method: 'POST', body: fd });
      if (!res.ok) {
        showToast(res.data.error || 'Image upload failed.');
        return;
      }
      showToast('Profile image updated');
      if (state.profileData) {
        await loadProfileData(state.profileData.user.username);
        openManageImagesModal();
      }
    };
  });

  document.querySelectorAll<HTMLButtonElement>('.img-del-btn').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.imgId;
      if (!id) return;
      const res = await apiJson(`/api/me/profile/images/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) {
        showToast(res.data.error || 'Could not remove image.');
        return;
      }
      showToast('Image removed');
      if (state.profileData) {
        await loadProfileData(state.profileData.user.username);
        openManageImagesModal();
      }
    };
  });
}

function openManageSocialLinksModal(): void {
  if (!state.profileData) return;
  const draftLinks: SocialLink[] = state.profileData.socialLinks.map((l) => ({ ...l }));

  function renderLinksModalBody(): void {
    const rowsHtml =
      draftLinks.length > 0
        ? draftLinks
            .map(
              (l, idx) => `
                <div class="pn" style="padding:.75rem;display:grid;gap:.5rem" data-link-idx="${idx}">
                  <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
                    <select class="select-box sl-platform" style="padding:.4rem .6rem">
                      ${['github', 'linkedin', 'x', 'youtube', 'website', 'portfolio', 'email', 'custom']
                        .map((p) => `<option value="${p}"${l.platform === p ? ' selected' : ''}>${p}</option>`)
                        .join('')}
                    </select>
                    <input type="text" class="sl-label" value="${esc(l.label)}" placeholder="Label" maxlength="60" style="flex:1;min-width:120px;background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:.4rem .6rem">
                    <button type="button" class="btn btn-sm sl-remove" data-idx="${idx}">Remove</button>
                  </div>
                  <input type="text" class="sl-url mono" value="${esc(l.url)}" placeholder="https://... or mailto:..." style="width:100%;background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:.4rem .6rem;font-size:.84rem">
                </div>
              `
            )
            .join('')
        : `<p class="mut" style="font-size:.86rem">No social links configured yet.</p>`;

    openModal('Manage Social Links', `
      <form id="sl-form" class="form-grid">
        <div id="sl-rows" style="display:grid;gap:.6rem">${rowsHtml}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;flex-wrap:wrap;padding-top:.4rem">
          <button type="button" class="btn btn-sm" id="sl-add" ${draftLinks.length >= 12 ? 'disabled' : ''}><i data-lucide="plus"></i>Add Link</button>
          <div style="display:flex;gap:.5rem">
            <button type="button" class="btn btn-sm" id="sl-cancel">Cancel</button>
            <button type="submit" class="btn btn-dark btn-sm"><i data-lucide="save"></i>Save Links</button>
          </div>
        </div>
      </form>
    `);

    function syncDraftFromInputs(): void {
      document.querySelectorAll<HTMLElement>('[data-link-idx]').forEach((row) => {
        const idx = Number(row.dataset.linkIdx);
        draftLinks[idx] = {
          platform: row.querySelector<HTMLSelectElement>('.sl-platform')?.value || 'custom',
          label: row.querySelector<HTMLInputElement>('.sl-label')?.value.trim() || '',
          url: row.querySelector<HTMLInputElement>('.sl-url')?.value.trim() || '',
        };
      });
    }

    $('#sl-add')?.addEventListener('click', () => {
      syncDraftFromInputs();
      if (draftLinks.length < 12) {
        draftLinks.push({ platform: 'github', label: 'GitHub', url: 'https://github.com/' });
        renderLinksModalBody();
      }
    });

    document.querySelectorAll<HTMLButtonElement>('.sl-remove').forEach((btn) => {
      btn.onclick = () => {
        syncDraftFromInputs();
        draftLinks.splice(Number(btn.dataset.idx), 1);
        renderLinksModalBody();
      };
    });

    $('#sl-cancel')?.addEventListener('click', closeModal);
    $('#sl-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      syncDraftFromInputs();
      const res = await apiJson('/api/me/profile/social-links', {
        method: 'PUT',
        body: JSON.stringify({ links: draftLinks }),
      });
      if (!res.ok) {
        showToast(res.data.error || 'Could not save social links.');
        return;
      }
      closeModal();
      showToast('Social links updated');
      if (state.profileData) {
        await loadProfileData(state.profileData.user.username);
      }
    });
  }

  renderLinksModalBody();
}

// ---- Render & Bind ----
function render(): void {
  const app = $('#app');
  if (!app) return;

  const r = state.route;
  if (r.kind === 'explore') app.innerHTML = renderExplore(r);
  else if (r.kind === 'dashboard') app.innerHTML = renderDashboard();
  else if (r.kind === 'new') app.innerHTML = renderNewRepo();
  else if (r.kind === 'repo') app.innerHTML = renderRepoBrowser(r);
  else if (r.kind === 'profile') app.innerHTML = renderProfile(r);

  bindHandlers();
  icons();
}

function bindHandlers(): void {
  // SPA navigation links
  document.querySelectorAll<HTMLAnchorElement>('a[data-nav]').forEach((a) => {
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const href = a.getAttribute('href');
      if (href && href.startsWith('/')) {
        e.preventDefault();
        navigate(href);
      }
    });
  });

  // Logout
  $('#nav-logout')?.addEventListener('click', async () => {
    await apiJson('/api/auth/logout', { method: 'POST' });
    state.me = null;
    state.meProfile = null;
    location.assign('/login');
  });

  // Explore
  if (state.route.kind === 'explore') {
    const form = $('#explore-search-form');
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = ($('#explore-search-input') as HTMLInputElement)?.value.trim() || '';
      const sort = ($('#explore-sort') as HTMLSelectElement)?.value || 'recent';
      navigate(`/explore?q=${encodeURIComponent(q)}&sort=${encodeURIComponent(sort)}`);
    });
    $('#explore-sort')?.addEventListener('change', (e) => {
      const sort = (e.target as HTMLSelectElement).value;
      const q = (state.route as Extract<RouteState, { kind: 'explore' }>).query;
      navigate(`/explore?q=${encodeURIComponent(q)}&sort=${encodeURIComponent(sort)}`);
    });
    $('#explore-clear')?.addEventListener('click', () => navigate('/explore'));
  }

  // New Repository + Folder Upload
  if (state.route.kind === 'new') {
    const folderInp = $('#new-folder-input') as HTMLInputElement | null;
    const filesInp = $('#new-files-input') as HTMLInputElement | null;
    const dropzone = $('#new-dropzone');

    $('#pick-folder-btn')?.addEventListener('click', () => folderInp?.click());
    $('#pick-files-btn')?.addEventListener('click', () => filesInp?.click());
    $('#new-clear-files')?.addEventListener('click', () => {
      state.newFiles = [];
      state.newRepoError = '';
      render();
    });

    folderInp?.addEventListener('change', () => {
      if (folderInp.files && folderInp.files.length > 0) {
        state.newFiles = collectFromFileList(folderInp.files);
        state.newRepoError = '';
        render();
      }
    });

    filesInp?.addEventListener('change', () => {
      if (filesInp.files && filesInp.files.length > 0) {
        state.newFiles = collectFromFileList(filesInp.files);
        state.newRepoError = '';
        render();
      }
    });

    if (dropzone) {
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('over');
      });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
      dropzone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropzone.classList.remove('over');
        if (e.dataTransfer) {
          state.newFiles = await collectDroppedItems(e.dataTransfer);
          state.newRepoError = '';
          render();
        }
      });
    }

    $('#new-repo-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (state.newSubmitting || !state.me) return;

      const name = ($('#repo-name') as HTMLInputElement).value.trim();
      const description = ($('#repo-desc') as HTMLInputElement).value.trim();
      const visibility = ($('#repo-vis') as HTMLSelectElement).value;
      const readme_enabled = ($('#repo-readme-enabled') as HTMLInputElement).checked;

      state.newSubmitting = true;
      state.newRepoError = '';
      state.newRepoCreatedSlug = '';
      state.newUploadPct = 10;
      state.newUploadStatus = 'Creating repository...';
      render();

      const createRes = await apiJson<{ repository: RepoSummary }>('/api/repositories', {
        method: 'POST',
        body: JSON.stringify({ name, description, visibility, readme_enabled }),
      });

      if (!createRes.ok || !createRes.data.repository) {
        state.newSubmitting = false;
        state.newRepoError = createRes.data.error || 'Could not create repository.';
        state.newUploadStatus = '';
        render();
        return;
      }

      const repo = createRes.data.repository;
      const repoUrl = `/${encodeURIComponent(state.me.username)}/${encodeURIComponent(repo.name)}`;

      if (state.newFiles.length > 0) {
        const upRes = await uploadSelectedFilesInBatches(repo.id, state.newFiles, false, (pct, text) => {
          state.newUploadPct = Math.max(10, pct);
          state.newUploadStatus = text;
          const fill = document.querySelector<HTMLElement>('.prog-fill');
          if (fill) fill.style.width = `${state.newUploadPct}%`;
        });

        if (!upRes.ok) {
          state.newSubmitting = false;
          state.newRepoError = `Repository "${repo.name}" was created, but upload failed: ${upRes.error}`;
          state.newRepoCreatedSlug = repoUrl;
          render();
          return;
        }
      }

      state.newSubmitting = false;
      state.newFiles = [];
      state.newUploadPct = 100;
      state.newUploadStatus = '';
      showToast(`Repository "${repo.name}" ready`);
      navigate(repoUrl);
    });
  }

  // Repository Browser
  if (state.route.kind === 'repo' && state.repoData) {
    const repo = state.repoData;
    const owner = repo.owner_username || state.route.owner;
    const baseSlug = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo.name)}`;

    $('#copy-repo-url')?.addEventListener('click', () => {
      void copyText(`${location.origin}${baseSlug}`, 'Repository URL copied');
    });

    $('#repo-quick-upload')?.addEventListener('click', () => {
      navigate(`${baseSlug}?tab=upload`);
    });

    $('#empty-go-upload')?.addEventListener('click', () => {
      navigate(`${baseSlug}?tab=upload`);
    });

    document.querySelectorAll<HTMLElement>('[data-nav-dir]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextDir = btn.dataset.navDir || '';
        const q = nextDir ? `?path=${encodeURIComponent(nextDir)}` : '';
        navigate(`${baseSlug}${q}`);
      });
    });

    document.querySelectorAll<HTMLElement>('[data-nav-file]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fPath = btn.dataset.navFile || '';
        const dirPath = fPath.includes('/') ? fPath.slice(0, fPath.lastIndexOf('/')) : '';
        const params = new URLSearchParams();
        if (dirPath) params.set('path', dirPath);
        params.set('file', fPath);
        navigate(`${baseSlug}?${params.toString()}`);
      });
    });

    $('#file-back-btn')?.addEventListener('click', (e) => {
      const dir = (e.currentTarget as HTMLElement).dataset.backDir || '';
      navigate(dir ? `${baseSlug}?path=${encodeURIComponent(dir)}` : baseSlug);
    });

    $('#file-mode-rendered')?.addEventListener('click', () => {
      state.fileRenderMode = 'rendered';
      render();
    });
    $('#file-mode-source')?.addEventListener('click', () => {
      state.fileRenderMode = 'source';
      render();
    });

    $('#copy-file-btn')?.addEventListener('click', () => {
      if (state.fileData && typeof state.fileData.content === 'string') {
        void copyText(state.fileData.content, `Copied ${state.fileData.path}`);
      }
    });

    // Repo Upload Tab
    const rFolderInp = $('#repo-folder-input') as HTMLInputElement | null;
    const rFilesInp = $('#repo-files-input') as HTMLInputElement | null;
    const rDropzone = $('#repo-dropzone');

    $('#repo-pick-folder')?.addEventListener('click', () => rFolderInp?.click());
    $('#repo-pick-files')?.addEventListener('click', () => rFilesInp?.click());
    $('#repo-clear-files')?.addEventListener('click', () => {
      state.repoUploadFiles = [];
      state.repoUploadError = '';
      render();
    });
    $('#repo-overwrite-chk')?.addEventListener('change', (e) => {
      state.repoUploadOverwrite = (e.target as HTMLInputElement).checked;
    });

    rFolderInp?.addEventListener('change', () => {
      if (rFolderInp.files && rFolderInp.files.length > 0) {
        state.repoUploadFiles = collectFromFileList(rFolderInp.files);
        state.repoUploadError = '';
        render();
      }
    });

    rFilesInp?.addEventListener('change', () => {
      if (rFilesInp.files && rFilesInp.files.length > 0) {
        state.repoUploadFiles = collectFromFileList(rFilesInp.files);
        state.repoUploadError = '';
        render();
      }
    });

    if (rDropzone) {
      rDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        rDropzone.classList.add('over');
      });
      rDropzone.addEventListener('dragleave', () => rDropzone.classList.remove('over'));
      rDropzone.addEventListener('drop', async (e) => {
        e.preventDefault();
        rDropzone.classList.remove('over');
        if (e.dataTransfer) {
          state.repoUploadFiles = await collectDroppedItems(e.dataTransfer);
          state.repoUploadError = '';
          render();
        }
      });
    }

    $('#repo-upload-submit')?.addEventListener('click', async () => {
      if (state.repoUploadFiles.length === 0 || state.repoUploading) return;
      state.repoUploading = true;
      state.repoUploadError = '';
      state.repoUploadPct = 5;
      state.repoUploadStatus = 'Preparing upload...';
      render();

      const res = await uploadSelectedFilesInBatches(
        repo.id,
        state.repoUploadFiles,
        state.repoUploadOverwrite,
        (pct, text) => {
          state.repoUploadPct = pct;
          state.repoUploadStatus = text;
          const fill = document.querySelector<HTMLElement>('.prog-fill');
          if (fill) fill.style.width = `${pct}%`;
        }
      );

      state.repoUploading = false;
      if (!res.ok) {
        state.repoUploadError = res.error || 'Upload failed.';
        render();
        return;
      }

      state.repoUploadFiles = [];
      state.repoUploadStatus = '';
      state.repoData = null; // force fresh file_count / readme fetch
      showToast(`Uploaded ${res.uploaded} file${res.uploaded === 1 ? '' : 's'}`);
      navigate(baseSlug);
    });

    // Repo Settings Tab
    $('#repo-settings-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        name: ($('#set-repo-name') as HTMLInputElement).value.trim(),
        description: ($('#set-repo-desc') as HTMLInputElement).value.trim(),
        visibility: ($('#set-repo-vis') as HTMLSelectElement).value,
        readme_enabled: ($('#set-repo-readme') as HTMLInputElement).checked,
      };
      const res = await apiJson<{ repository: RepoSummary }>(`/api/repositories/${encodeURIComponent(repo.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      if (!res.ok || !res.data.repository) {
        showToast(res.data.error || 'Could not save settings.');
        return;
      }
      state.repoData = res.data.repository;
      showToast('Repository settings saved');
      const nextSlug = `/${encodeURIComponent(owner)}/${encodeURIComponent(res.data.repository.name)}?tab=settings`;
      navigate(nextSlug, true);
    });

    $('#delete-repo-btn')?.addEventListener('click', () => {
      openModal('Delete Repository', `
        <p>Are you sure you want to permanently delete <strong class="mono">${esc(owner)}/${esc(repo.name)}</strong> and all hosted files?</p>
        <div style="display:flex;justify-content:flex-end;gap:.55rem;margin-top:1.2rem">
          <button type="button" class="btn btn-sm" id="confirm-del-cancel">Cancel</button>
          <button type="button" class="btn btn-dark btn-sm" id="confirm-del-yes"><i data-lucide="trash-2"></i>Delete Permanently</button>
        </div>
      `);
      $('#confirm-del-cancel')?.addEventListener('click', closeModal);
      $('#confirm-del-yes')?.addEventListener('click', async () => {
        const delRes = await apiJson(`/api/repositories/${encodeURIComponent(repo.id)}`, { method: 'DELETE' });
        if (!delRes.ok) {
          showToast(delRes.data.error || 'Could not delete repository.');
          return;
        }
        closeModal();
        state.repoData = null;
        showToast(`Deleted ${repo.name}`);
        navigate('/dashboard');
      });
    });
  }

  // Developer Profile
  if (state.route.kind === 'profile' && state.profileData) {
    $('#edit-profile-modal-btn')?.addEventListener('click', openEditProfileModal);
    $('#manage-images-btn')?.addEventListener('click', openManageImagesModal);
    $('#manage-images-btn-2')?.addEventListener('click', openManageImagesModal);
    $('#manage-links-btn')?.addEventListener('click', openManageSocialLinksModal);

    const startReadmeEdit = () => {
      state.editingReadme = true;
      state.readmeMode = 'edit';
      state.readmeDraft = state.profileData?.readme.markdown_content || '';
      render();
    };

    $('#edit-profile-readme-btn')?.addEventListener('click', startReadmeEdit);
    $('#owner-edit-readme-btn')?.addEventListener('click', startReadmeEdit);
    $('#create-profile-readme-btn')?.addEventListener('click', startReadmeEdit);

    $('#readme-cancel-btn')?.addEventListener('click', () => {
      state.editingReadme = false;
      render();
    });

    const syncTextarea = () => {
      const ta = $('#profile-readme-textarea') as HTMLTextAreaElement | null;
      if (ta) state.readmeDraft = ta.value;
    };

    $('#readme-insert-template')?.addEventListener('click', () => {
      const u = state.profileData!.user.username;
      const dn = state.profileData!.profile.display_name;
      state.readmeDraft =
        `# Hi, I'm ${dn} (@${u})\n\n` +
        `Building tools, libraries, and open-source projects on **KEX**.\n\n` +
        `## Focus Areas\n` +
        `- Systems & CLI tooling\n` +
        `- Full-stack TypeScript web apps\n\n` +
        `\`\`\`ts\nconsole.log("Hello from @${u}");\n\`\`\`\n\n` +
        `| Area | Stack |\n| --- | --- |\n| Backend | Node.js, TypeScript, SQLite |\n| UI | HTML, CSS, Lucide |\n`;
      state.readmeMode = 'edit';
      render();
    });

    $('#readme-mode-edit')?.addEventListener('click', () => {
      state.readmeMode = 'edit';
      render();
    });

    $('#readme-mode-preview')?.addEventListener('click', async () => {
      syncTextarea();
      state.readmeMode = 'preview';
      const res = await apiJson<{ rendered_html: string }>('/api/markdown/preview', {
        method: 'POST',
        body: JSON.stringify({ markdown_content: state.readmeDraft }),
      });
      state.readmePreviewHtml = res.ok ? res.data.rendered_html : '<p>Preview failed.</p>';
      render();
    });

    $('#readme-save-btn')?.addEventListener('click', async () => {
      syncTextarea();
      state.readmeSaving = true;
      render();

      const res = await apiJson<{ markdown_content: string; rendered_html: string; updated_at: string }>('/api/me/profile/readme', {
        method: 'PUT',
        body: JSON.stringify({ markdown_content: state.readmeDraft }),
      });
      state.readmeSaving = false;
      if (!res.ok) {
        showToast(res.data.error || 'Could not save Profile README.');
        render();
        return;
      }

      if (state.profileData) {
        state.profileData.readme = {
          markdown_content: res.data.markdown_content,
          rendered_html: res.data.rendered_html,
          has_content: res.data.markdown_content.trim().length > 0,
          updated_at: res.data.updated_at,
        };
      }
      state.editingReadme = false;
      showToast('Profile README.md saved');
      render();
    });
  }
}

// Global modal & keyboard hooks
$('#modal-close')?.addEventListener('click', closeModal);
$('#modal-backdrop')?.addEventListener('click', (e) => {
  if (e.target === $('#modal-backdrop')) closeModal();
});
$('#toast')?.addEventListener('click', () => $('#toast')?.classList.remove('on'));

window.addEventListener('keydown', (e) => {
  const activeTag = document.activeElement?.tagName || '';
  if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)) {
    e.preventDefault();
    const target = $('#explore-search-input');
    if (target) target.focus();
    else navigate('/explore');
  } else if (e.key === 'Escape') {
    closeModal();
  }
});

window.addEventListener('popstate', () => {
  void handleRouteChange();
});

void handleRouteChange();
