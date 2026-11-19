/* Team sharing through SharePoint (Microsoft Graph). Jobs live in the shared "Tile Set-outs" folder:
   <folder>/<Job name> [jobId]/job.json  +  img-<id>.jpg for each drawing. */
(function () {
  'use strict';
  const CFG = {
    clientId: '6822399f-e427-4c03-bc69-042dd6f5de88',
    tenantId: 'f00f8d2e-499f-4adf-887f-337bc55b1f9a',
    share: 'https://naosfloors.sharepoint.com/:f:/s/OfficeData/IgB1SNxJxAqrS6YpDLAKzfy7AXWimxMWiPVSBT-kf6JdRMw?e=kd9nnp',
  };
  const SCOPES = ['User.Read', 'Sites.ReadWrite.All'];
  const G = 'https://graph.microsoft.com/v1.0';
  let pca = null, account = null, root = null, ready = false;
  const redirect = () => location.origin + location.pathname.replace(/index\.html$/, '');

  async function init() {
    root = JSON.parse(localStorage.getItem('tso-root') || 'null');
    if (window.__tsoFakeToken) { account = { name: 'Test User', username: 'test@naosfloors.co.uk' }; ready = true; return; }
    if (!window.msal) return;
    try {
      pca = new msal.PublicClientApplication({
        auth: { clientId: CFG.clientId, authority: `https://login.microsoftonline.com/${CFG.tenantId}`, redirectUri: redirect(), postLogoutRedirectUri: redirect(), navigateToLoginRequestUrl: true },
        cache: { cacheLocation: 'localStorage' },
      });
      await pca.initialize();
      const r = await pca.handleRedirectPromise().catch(e => { console.warn('sign-in', e); window.__tsoSignInError = e.message; return null; });
      account = r?.account || pca.getActiveAccount() || pca.getAllAccounts()[0] || null;
      if (account) pca.setActiveAccount(account);
      ready = true;
    } catch (e) { console.warn('MSAL init failed', e); }
  }
  const signedIn = () => !!account;
  const user = () => account ? (account.name || account.username) : '';
  function signIn() { if (!pca) throw new Error('Sign-in is not available (no signal when the app started?)'); return pca.loginRedirect({ scopes: SCOPES, redirectStartPage: location.href, prompt: 'select_account' }); }
  function signOut() { localStorage.removeItem('tso-root'); root = null; if (pca) return pca.logoutRedirect({ account }); account = null; }

  async function token() {
    if (window.__tsoFakeToken) return window.__tsoFakeToken;
    if (!pca || !account) throw Object.assign(new Error('Not signed in'), { code: 'signin' });
    try { return (await pca.acquireTokenSilent({ scopes: SCOPES, account })).accessToken; }
    catch (e) {
      if (e instanceof msal.InteractionRequiredAuthError || /interaction_required|login_required|consent/i.test(e.errorCode || e.message)) {
        throw Object.assign(new Error('Microsoft sign-in has expired — tap Sign in again'), { code: 'signin' });
      }
      throw e;
    }
  }
  async function api(path, opts = {}) {
    const t = await token();
    const r = await fetch(path.startsWith('http') ? path : G + path, { ...opts, headers: { Authorization: 'Bearer ' + t, ...(opts.headers || {}) } });
    if (!r.ok) {
      let body = null; try { body = await r.json(); } catch (e) { }
      const msg = body?.error?.message || `SharePoint error ${r.status}`;
      throw Object.assign(new Error(msg), { status: r.status, body });
    }
    return r;
  }
  function shareId(url) { const b = btoa(unescape(encodeURIComponent(url))).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-'); return 'u!' + b; }
  async function getRoot() {
    if (root) return root;
    const j = await (await api(`/shares/${shareId(CFG.share)}/driveItem?$select=id,name,webUrl,parentReference`)).json();
    root = { driveId: j.parentReference.driveId, id: j.id, name: j.name, webUrl: j.webUrl };
    localStorage.setItem('tso-root', JSON.stringify(root));
    return root;
  }
  const safe = s => (s || 'Job').replace(/["*:<>?/\\|#%&{}~]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Job';
  const folderName = job => `${safe(job.name)} [${job.id}]`;
  const idFrom = name => (/\[([A-Za-z0-9]+)\]\s*$/.exec(name) || [])[1] || null;

  /* all team jobs: [{jobId, folderId, name, modified, by, webUrl}] */
  async function list() {
    const R = await getRoot(); const out = [];
    let url = `/drives/${R.driveId}/items/${R.id}/children?$top=500&$select=id,name,folder,lastModifiedDateTime,lastModifiedBy,webUrl`;
    while (url) {
      const j = await (await api(url)).json();
      (j.value || []).forEach(it => { const id = it.folder ? idFrom(it.name) : null; if (id) out.push({ jobId: id, folderId: it.id, name: it.name.replace(/\s*\[[A-Za-z0-9]+\]\s*$/, ''), modified: it.lastModifiedDateTime, by: it.lastModifiedBy?.user?.displayName || '', webUrl: it.webUrl }); });
      url = j['@odata.nextLink'] || null;
    }
    return out;
  }
  async function findFolder(jobId) { return (await list()).find(x => x.jobId === jobId) || null; }
  async function ensureFolder(job) {
    const R = await getRoot(); const c = job._cloud || {};
    if (c.folderId) {
      if (c.folderName !== folderName(job)) {
        try { await api(`/drives/${R.driveId}/items/${c.folderId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: folderName(job) }) }); c.folderName = folderName(job); }
        catch (e) { if (e.status === 404) { c.folderId = null; } else console.warn('rename', e); }
      }
      if (c.folderId) return c.folderId;
    }
    const found = await findFolder(job.id);
    if (found) { c.folderId = found.folderId; c.folderName = found.name + ` [${job.id}]`; const meta = await jobMeta(found.folderId).catch(() => null); if (meta && !c.eTag) c.needsCheck = meta.eTag; return c.folderId; }
    const j = await (await api(`/drives/${R.driveId}/items/${R.id}/children`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: folderName(job), folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }) })).json();
    c.folderId = j.id; c.folderName = j.name; c.imgs = []; c.eTag = null;
    return c.folderId;
  }
  function dataUrlToBlob(d) { const [h, b] = d.split(','); const mime = /data:([^;]+)/.exec(h)[1]; const bin = atob(b); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: mime }); }
  function blobToDataUrl(b) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); }); }
  const stripped = job => JSON.stringify({ app: 'naos-tile-setout', v: 4, savedBy: user(), job: { ...job, images: Object.fromEntries(Object.keys(job.images || {}).map(k => [k, 'file'])), _cloud: undefined } });

  /* upload a job. force = ignore someone else's newer save. Throws {conflict:true} if someone else saved first. */
  async function push(job, force) {
    const R = await getRoot(); job._cloud = job._cloud || {}; const c = job._cloud;
    const folderId = await ensureFolder(job);
    c.imgs = c.imgs || [];
    for (const [id, d] of Object.entries(job.images || {})) {
      if (c.imgs.includes(id) || !d || !d.startsWith('data:')) continue;
      await api(`/drives/${R.driveId}/items/${folderId}:/img-${id}.jpg:/content`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: dataUrlToBlob(d) });
      c.imgs.push(id);
    }
    if (c.needsCheck && !force) { const meta = await jobMeta(folderId).catch(() => null); throw Object.assign(new Error('This job is already in SharePoint'), { conflict: true, by: meta?.by, when: meta?.when }); }
    delete c.needsCheck;
    const headers = { 'Content-Type': 'application/json' };
    if (c.eTag && !force) headers['If-Match'] = c.eTag;
    try {
      const j = await (await api(`/drives/${R.driveId}/items/${folderId}:/job.json:/content`, { method: 'PUT', headers, body: stripped(job) })).json();
      c.eTag = j.eTag; c.lastSync = Date.now(); c.dirty = false;
      return c;
    } catch (e) {
      if (e.status === 412) { const meta = await jobMeta(folderId).catch(() => null); throw Object.assign(new Error('Someone else saved this job'), { conflict: true, by: meta?.by, when: meta?.when }); }
      throw e;
    }
  }
  async function jobMeta(folderId) {
    const R = await getRoot();
    const j = await (await api(`/drives/${R.driveId}/items/${folderId}:/job.json?$select=id,eTag,lastModifiedDateTime,lastModifiedBy`)).json();
    return { eTag: j.eTag, when: j.lastModifiedDateTime, by: j.lastModifiedBy?.user?.displayName || '' };
  }
  /* download a job (and any drawings we don't have yet) */
  async function pull(folderId, localImages = {}) {
    const R = await getRoot();
    const meta = await (await api(`/drives/${R.driveId}/items/${folderId}:/job.json?$select=id,eTag,lastModifiedDateTime,lastModifiedBy`)).json();
    const txt = await (await api(`/drives/${R.driveId}/items/${folderId}:/job.json:/content`)).text();
    const data = JSON.parse(txt); const job = data.job || data;
    const images = {}; const imgs = [];
    for (const id of Object.keys(job.images || {})) {
      if (localImages[id] && localImages[id].startsWith('data:')) { images[id] = localImages[id]; imgs.push(id); continue; }
      try { const b = await (await api(`/drives/${R.driveId}/items/${folderId}:/img-${id}.jpg:/content`)).blob(); images[id] = await blobToDataUrl(b); imgs.push(id); } catch (e) { console.warn('image', id, e); }
    }
    job.images = images;
    const fold = await (await api(`/drives/${R.driveId}/items/${folderId}?$select=id,name`)).json();
    job._cloud = { folderId, folderName: fold.name, eTag: meta.eTag, imgs, dirty: false, lastSync: Date.now(), by: meta.lastModifiedBy?.user?.displayName || '' };
    job.shared = true;
    return job;
  }
  async function remove(folderId) { const R = await getRoot(); await api(`/drives/${R.driveId}/items/${folderId}`, { method: 'DELETE' }); }
  const folderUrl = () => root?.webUrl || CFG.share;

  window.Cloud = { init, signedIn, user, signIn, signOut, list, push, pull, jobMeta, remove, folderUrl, isReady: () => ready, available: () => !!(pca || window.__tsoFakeToken) };
})();
