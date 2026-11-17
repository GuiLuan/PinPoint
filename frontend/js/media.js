import { store } from './state.js';
import { canvas } from './canvas.js';

const API_BASE = '/api/v1';
export const MAX_ASSET_BYTES = 500 * 1024 * 1024;
export const CARD_HEADER_HEIGHT = 36;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.ogg', '.mkv', '.avi']);
const HTML_EXTS = new Set(['.html', '.htm']);
const SHORTCUT_EXTS = new Set(['.url', '.webloc']);

function getExt(name = '') {
  const m = String(name).toLowerCase().match(/(\.[^./\\]+)$/);
  return m ? m[1] : '';
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripExt(name = '') {
  return String(name).replace(/\.[^./\\]+$/, '').trim() || String(name);
}

export function isValidHttpUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const VIDEO_SITE_HOST_RE = /(?:^|\.)(bilibili\.com|b23\.tv|youtube\.com|youtu\.be|youtube-nocookie\.com|vimeo\.com|twitch\.tv|douyin\.com|tiktok\.com|iqiyi\.com|youku\.com|v\.qq\.com|acfun\.cn|nicovideo\.jp|dailymotion\.com|mgtv\.com|tv\.sohu\.com|ixigua\.com|kuaishou\.com|kick\.com|rumble\.com)$/i;
const VIDEO_SITE_PATH_RE = /(\/video\/|\/watch\b|\/embed\/|\/live\/|player\.)/i;

export function isLikelyVideoSiteUrl(rawUrl) {
  if (!rawUrl || !isValidHttpUrl(rawUrl)) return false;
  try {
    const u = new URL(rawUrl);
    if (VIDEO_SITE_HOST_RE.test(u.hostname)) return true;
    if (VIDEO_SITE_PATH_RE.test(u.pathname) || u.hostname.startsWith('player.')) return true;
  } catch {}
  return false;
}

export function sanitizeIframeUrl(rawUrl) {
  if (!rawUrl || !isValidHttpUrl(rawUrl)) return rawUrl || '';
  try {
    const u = new URL(rawUrl);
    if (u.searchParams.has('autoplay')) {
      const val = (u.searchParams.get('autoplay') || '').toLowerCase();
      if (val === '1' || val === 'true') {
        u.searchParams.set('autoplay', '0');
      }
    }
    if (u.searchParams.has('auto_play')) {
      const val = (u.searchParams.get('auto_play') || '').toLowerCase();
      if (val === '1' || val === 'true') {
        u.searchParams.set('auto_play', '0');
      }
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export function shouldWebpageStartDormant(card, loadedSet) {
  if (!card || card.kind !== 'webpage') return false;
  const m = card.media || {};
  if ((m.viewMode || 'iframe') === 'bookmark') return false;
  if (loadedSet && loadedSet.has(card.id)) return false;
  const mode = store.getMediaSettings?.()?.webpageLoadMode || 'smart';
  if (mode === 'eager') return false;
  if (mode === 'lazy') return true;
  return isLikelyVideoSiteUrl(m.url || m.src || '');
}

export function classifyUrlByExt(url) {
  try {
    const u = new URL(url);
    const ext = getExt(u.pathname);
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    return 'webpage';
  } catch {
    return 'webpage';
  }
}

export function classifyFile(file) {
  if (!file) return null;
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.pinpoint.zip')) return 'pinpoint-zip';
  if (name.endsWith('.pinpoint')) return 'pinpoint';
  const ext = getExt(name);
  const type = (file.type || '').toLowerCase();
  if (IMAGE_EXTS.has(ext) || type.startsWith('image/')) return 'image';
  if (VIDEO_EXTS.has(ext) || type.startsWith('video/')) return 'video';
  if (HTML_EXTS.has(ext) || type === 'text/html') return 'html';
  if (SHORTCUT_EXTS.has(ext)) return 'shortcut';
  return null;
}

export async function parseShortcutFile(file) {
  const text = await file.text();
  const ext = getExt(file.name);
  if (ext === '.url') {
    const m = text.match(/^\s*URL\s*=\s*(.+)$/im);
    const url = m ? m[1].trim() : '';
    return isValidHttpUrl(url) ? url : null;
  }
  if (ext === '.webloc') {
    const m = text.match(/<key>\s*URL\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i)
      || text.match(/<string>\s*(https?:\/\/[^<]+?)\s*<\/string>/i);
    const url = m ? m[1].trim() : '';
    return isValidHttpUrl(url) ? url : null;
  }
  return null;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function probeImageSize(src, timeoutMs = 4500) {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (dims) => {
      if (done) return;
      done = true;
      resolve(dims);
    };
    const timer = setTimeout(() => finish({ width: 0, height: 0 }), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      finish({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
    };
    img.onerror = () => {
      clearTimeout(timer);
      finish({ width: 0, height: 0 });
    };
    img.src = src;
  });
}

export function probeVideoSize(src, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    let done = false;
    const finish = (dims) => {
      if (done) return;
      done = true;
      video.removeAttribute('src');
      video.load();
      resolve(dims);
    };
    const timer = setTimeout(() => finish({ width: 0, height: 0, duration: 0 }), timeoutMs);
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      finish({
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0
      });
    };
    video.onerror = () => {
      clearTimeout(timer);
      finish({ width: 0, height: 0, duration: 0 });
    };
    video.src = src;
  });
}

export function computeInitialCardSize(kind, naturalWidth = 0, naturalHeight = 0) {
  if (kind === 'webpage') {
    return { width: 460, height: 360 };
  }
  const hasDims = naturalWidth > 0 && naturalHeight > 0;
  if (kind === 'image') {
    if (!hasDims) return { width: 360, height: 240 };
    const ratio = naturalWidth / naturalHeight;
    let targetW = Math.min(460, Math.max(300, Math.round(naturalWidth)));
    if (naturalWidth > 460) targetW = ratio >= 1.4 ? 440 : (ratio <= 0.75 ? 320 : 380);
    let bodyH = Math.round(targetW / ratio);
    if (bodyH > 460) {
      bodyH = 460;
      targetW = Math.max(250, Math.round(bodyH * ratio));
    }
    if (bodyH < 120) bodyH = 120;
    return { width: Math.max(250, targetW), height: CARD_HEADER_HEIGHT + bodyH };
  }
  if (kind === 'video') {
    if (!hasDims) return { width: 400, height: 264 };
    const ratio = naturalWidth / naturalHeight;
    let targetW = ratio >= 1.4 ? 440 : (ratio <= 0.8 ? 320 : 400);
    let bodyH = Math.round(targetW / ratio);
    if (bodyH > 440) {
      bodyH = 440;
      targetW = Math.max(260, Math.round(bodyH * ratio));
    }
    if (bodyH < 140) bodyH = 140;
    return { width: Math.max(260, targetW), height: CARD_HEADER_HEIGHT + bodyH };
  }
  return { width: 310, height: 140 };
}

export function buildInlineImageHtml(src, title = '图片', assetId = '', originUrl = '') {
  const safeSrc = escapeHtml(src);
  const safeTitle = escapeHtml(title);
  const safeAid = escapeHtml(assetId);
  const safeOrigin = escapeHtml(originUrl);
  return (
    `<span class="inline-media-block inline-media-image" contenteditable="false" data-media-kind="image" data-src="${safeSrc}" data-title="${safeTitle}" data-asset-id="${safeAid}" data-origin-url="${safeOrigin}">`
    + `<img src="${safeSrc}" alt="${safeTitle}" draggable="false" />`
    + `<span class="inline-media-actions">`
    + `<button type="button" class="inline-media-action-btn inline-media-action-zoom" title="放大预览">⤢</button>`
    + `<button type="button" class="inline-media-action-btn inline-media-action-popout" title="拆出为独立画布卡片">↗</button>`
    + `<button type="button" class="inline-media-action-btn inline-media-action-delete" title="移除">×</button>`
    + `</span></span>`
  );
}

export function buildInlineVideoHtml(src, title = '视频', assetId = '', originUrl = '') {
  const safeSrc = escapeHtml(src);
  const safeTitle = escapeHtml(title);
  const safeAid = escapeHtml(assetId);
  const safeOrigin = escapeHtml(originUrl);
  return (
    `<span class="inline-media-block inline-media-video" contenteditable="false" data-media-kind="video" data-src="${safeSrc}" data-title="${safeTitle}" data-asset-id="${safeAid}" data-origin-url="${safeOrigin}">`
    + `<video src="${safeSrc}" controls preload="metadata" playsinline></video>`
    + `<span class="inline-media-actions">`
    + `<button type="button" class="inline-media-action-btn inline-media-action-zoom" title="放大预览">⤢</button>`
    + `<button type="button" class="inline-media-action-btn inline-media-action-popout" title="拆出为独立画布卡片">↗</button>`
    + `<button type="button" class="inline-media-action-btn inline-media-action-delete" title="移除">×</button>`
    + `</span></span>`
  );
}

export function buildInlineLinkHtml(url, title = '', assetId = '', sourceType = 'url') {
  const safeUrl = escapeHtml(url);
  let label = (title || '').trim();
  if (!label) {
    try {
      const u = new URL(url);
      label = u.hostname + (u.pathname && u.pathname !== '/' ? u.pathname : '');
    } catch {
      label = url;
    }
  }
  const safeLabel = escapeHtml(label.slice(0, 64));
  const safeTitle = escapeHtml(title || label);
  const safeAid = escapeHtml(assetId);
  const safeSource = escapeHtml(sourceType);
  return (
    `<span class="inline-link-chip" contenteditable="false" data-media-kind="webpage" data-url="${safeUrl}" data-title="${safeTitle}" data-asset-id="${safeAid}" data-source-type="${safeSource}" title="${safeUrl}">`
    + `<span class="inline-link-icon">🔗</span>`
    + `<a class="inline-link-anchor" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`
    + `<span class="inline-link-actions">`
    + `<button type="button" class="inline-media-action-btn inline-media-action-popout" title="拆出为独立网页卡片">↗</button>`
    + `<button type="button" class="inline-media-action-btn inline-media-action-delete" title="移除">×</button>`
    + `</span></span>`
  );
}

class MediaManager {
  constructor() {
    this.lightboxEl = null;
    this.entryPickerEl = null;
    this.dropBannerEl = null;
    this.dropCaretEl = null;
    this._currentDropHighlight = null;
  }

  init() {
    this.lightboxEl = document.getElementById('media-lightbox');
    this.entryPickerEl = document.getElementById('html-entry-picker');
    this.dropBannerEl = document.getElementById('media-drop-banner');
    if (!this.dropCaretEl) {
      const el = document.createElement('div');
      el.id = 'media-drop-caret';
      el.className = 'media-drop-caret';
      document.body.appendChild(el);
      this.dropCaretEl = el;
    }
    this.bindLightboxEvents();
  }

  isBackendConnected() {
    return !!window.__sync?.connected;
  }

  bindLightboxEvents() {
    if (!this.lightboxEl) return;
    const close = () => this.closeLightbox();
    this.lightboxEl.querySelector('#btn-close-lightbox')?.addEventListener('click', close);
    this.lightboxEl.addEventListener('mousedown', (e) => {
      if (e.target === this.lightboxEl || e.target.classList.contains('media-lightbox-stage')) {
        close();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.lightboxEl?.classList.contains('is-open')) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    }, true);
  }

  openLightbox({ kind, src, title, naturalWidth, naturalHeight }) {
    if (!this.lightboxEl || !src) return;
    const stageEl = this.lightboxEl.querySelector('#media-lightbox-stage');
    const titleEl = this.lightboxEl.querySelector('#media-lightbox-title');
    const metaEl = this.lightboxEl.querySelector('#media-lightbox-meta');
    const openBtn = this.lightboxEl.querySelector('#btn-lightbox-open');
    if (!stageEl) return;

    stageEl.innerHTML = '';
    if (titleEl) titleEl.textContent = title || (kind === 'video' ? '视频预览' : '图片预览');
    if (metaEl) {
      metaEl.textContent = (naturalWidth && naturalHeight) ? `${naturalWidth} × ${naturalHeight}` : '';
    }
    if (openBtn) {
      openBtn.href = src;
    }

    if (kind === 'video') {
      const video = document.createElement('video');
      video.src = src;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.className = 'media-lightbox-video';
      stageEl.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = src;
      img.alt = title || '图片预览';
      img.className = 'media-lightbox-img';
      stageEl.appendChild(img);
    }

    this.lightboxEl.classList.add('is-open');
  }

  closeLightbox() {
    if (!this.lightboxEl) return;
    const video = this.lightboxEl.querySelector('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    const stageEl = this.lightboxEl.querySelector('#media-lightbox-stage');
    if (stageEl) stageEl.innerHTML = '';
    this.lightboxEl.classList.remove('is-open');
  }

  pickHtmlEntry(entries, folderName) {
    return new Promise((resolve) => {
      if (!this.entryPickerEl) {
        resolve(entries[0] || null);
        return;
      }
      const listEl = this.entryPickerEl.querySelector('#html-entry-list');
      const titleEl = this.entryPickerEl.querySelector('#html-entry-folder-name');
      const cancelBtn = this.entryPickerEl.querySelector('#btn-cancel-html-entry');
      if (titleEl) titleEl.textContent = folderName || 'HTML 文件夹';
      if (listEl) {
        listEl.innerHTML = '';
        entries.forEach((relPath) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'html-entry-option';
          btn.textContent = relPath;
          btn.addEventListener('click', () => {
            cleanup();
            resolve(relPath);
          });
          listEl.appendChild(btn);
        });
      }
      const onCancel = () => {
        cleanup();
        resolve(null);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') onCancel();
      };
      const cleanup = () => {
        this.entryPickerEl.classList.remove('is-open');
        cancelBtn?.removeEventListener('click', onCancel);
        window.removeEventListener('keydown', onKey, true);
      };
      cancelBtn?.addEventListener('click', onCancel);
      window.addEventListener('keydown', onKey, true);
      this.entryPickerEl.classList.add('is-open');
    });
  }

  async uploadSingleFile(file, kindHint = null) {
    if (!this.isBackendConnected()) {
      store.emitToast('服务当前离线，无法上传本地媒体文件，请先连接本地服务', 'warning');
      return null;
    }
    if (file.size > MAX_ASSET_BYTES) {
      store.emitToast(`「${file.name}」超过单文件 500MB 上限`, 'warning');
      return null;
    }
    if (file.size === 0) {
      store.emitToast(`「${file.name}」是空文件，无法导入`, 'warning');
      return null;
    }
    const kind = kindHint || classifyFile(file);
    const params = new URLSearchParams({ filename: file.name || 'media.bin' });
    if (kind) params.set('kind', kind);
    const res = await fetch(`${API_BASE}/assets?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-PinPoint-Filename': encodeURIComponent(file.name || 'media.bin'),
        ...(kind ? { 'X-PinPoint-Kind': kind } : {})
      },
      body: file
    });
    const json = await res.json();
    if (!res.ok || !json?.ok) {
      throw new Error(json?.error?.message || `上传失败 (${res.status})`);
    }
    return json.data;
  }

  async uploadFolderBundle(filesWithRel, rootName, entryPath) {
    if (!this.isBackendConnected()) {
      store.emitToast('服务当前离线，无法上传本地 HTML 文件夹', 'warning');
      return null;
    }
    const totalSize = filesWithRel.reduce((acc, it) => acc + (it.file?.size || 0), 0);
    if (totalSize > MAX_ASSET_BYTES) {
      store.emitToast(`文件夹「${rootName}」总大小超过 500MB 上限`, 'warning');
      return null;
    }
    const fd = new FormData();
    if (rootName) fd.append('rootName', rootName);
    if (entryPath) fd.append('entry', entryPath);
    for (const item of filesWithRel) {
      fd.append('files', item.file, item.relPath);
    }
    const res = await fetch(`${API_BASE}/assets/bundle`, {
      method: 'POST',
      headers: {
        'X-PinPoint-Filename': encodeURIComponent(rootName || 'site')
      },
      body: fd
    });
    const json = await res.json();
    if (!res.ok || !json?.ok) {
      throw new Error(json?.error?.message || `上传文件夹失败 (${res.status})`);
    }
    return json.data;
  }

  async fetchRemoteMedia(url, expectedKind = null) {
    if (!this.isBackendConnected()) {
      return { fallbackExternal: true, reason: 'OFFLINE', url };
    }
    try {
      const res = await fetch(`${API_BASE}/assets/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, expectedKind })
      });
      const json = await res.json();
      if (res.ok && json?.ok) return json.data;
      return { fallbackExternal: true, reason: json?.error?.message || 'FETCH_FAILED', url };
    } catch (err) {
      return { fallbackExternal: true, reason: String(err), url };
    }
  }

  async probeUrl(url) {
    if (!this.isBackendConnected()) {
      let host = url;
      try { host = new URL(url).hostname; } catch {}
      return {
        url,
        mediaKind: classifyUrlByExt(url),
        embeddable: true,
        blockReason: null,
        title: host,
        favicon: null,
        description: ''
      };
    }
    try {
      const res = await fetch(`${API_BASE}/url/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const json = await res.json();
      if (res.ok && json?.ok) return json.data;
    } catch {}
    let host = url;
    try { host = new URL(url).hostname; } catch {}
    return {
      url,
      mediaKind: classifyUrlByExt(url),
      embeddable: false,
      blockReason: '探测失败',
      title: host,
      favicon: null,
      description: ''
    };
  }

  async prepareSpecFromFile(file) {
    const kind = classifyFile(file);
    if (!kind) return { unsupported: true, name: file.name };

    if (kind === 'pinpoint' || kind === 'pinpoint-zip') {
      return { kind, file };
    }

    if (kind === 'shortcut') {
      const targetUrl = await parseShortcutFile(file);
      if (!targetUrl) {
        return { error: `无法解析快捷方式「${file.name}」中的有效网址` };
      }
      return this.prepareSpecFromUrl(targetUrl, stripExt(file.name));
    }

    const asset = await this.uploadSingleFile(file, kind);
    if (!asset) return { aborted: true };

    if (kind === 'html') {
      const hasRelativeDeps = /<(?:script|link)\b[^>]+(?:src|href)=["'](?!https?:|data:|blob:|\/\/)[^"']+["']/i.test(await file.text());
      if (hasRelativeDeps) {
        store.emitToast('提示：检测到本地 HTML 引用了相对路径脚本或样式，如需完整加载请直接拖入包含它们的整个文件夹', 'info');
      }
      const dims = computeInitialCardSize('webpage');
      return {
        kind: 'webpage',
        title: stripExt(file.name) || '本地网页',
        width: dims.width,
        height: dims.height,
        media: {
          sourceType: 'html-file',
          assetId: asset.id,
          src: asset.url,
          url: asset.url,
          fileName: asset.fileName,
          fileSize: asset.sizeBytes,
          embeddable: true,
          viewMode: 'iframe',
          isLocal: true
        }
      };
    }

    if (kind === 'image') {
      const natural = await probeImageSize(asset.url);
      const dims = computeInitialCardSize('image', natural.width, natural.height);
      return {
        kind: 'image',
        title: stripExt(file.name) || '未命名图片',
        width: dims.width,
        height: dims.height,
        media: {
          assetId: asset.id,
          src: asset.url,
          mimeType: asset.mimeType,
          fileName: asset.fileName,
          fileSize: asset.sizeBytes,
          naturalWidth: natural.width,
          naturalHeight: natural.height,
          isExternal: false
        }
      };
    }

    if (kind === 'video') {
      const natural = await probeVideoSize(asset.url);
      const dims = computeInitialCardSize('video', natural.width, natural.height);
      return {
        kind: 'video',
        title: stripExt(file.name) || '未命名视频',
        width: dims.width,
        height: dims.height,
        media: {
          assetId: asset.id,
          src: asset.url,
          mimeType: asset.mimeType,
          fileName: asset.fileName,
          fileSize: asset.sizeBytes,
          naturalWidth: natural.width,
          naturalHeight: natural.height,
          duration: natural.duration || 0,
          isExternal: false
        }
      };
    }
    return { unsupported: true, name: file.name };
  }

  async prepareSpecFromUrl(rawUrl, fallbackTitle = '') {
    const url = String(rawUrl || '').trim();
    if (!isValidHttpUrl(url)) return null;

    const extKind = classifyUrlByExt(url);
    let resolvedKind = extKind;
    let probeInfo = null;

    if (extKind === 'webpage') {
      probeInfo = await this.probeUrl(url);
      if (probeInfo?.mediaKind === 'image' || probeInfo?.mediaKind === 'video') {
        resolvedKind = probeInfo.mediaKind;
      }
    }

    if (resolvedKind === 'image' || resolvedKind === 'video') {
      const fetched = await this.fetchRemoteMedia(url, resolvedKind);
      let src = url;
      let assetId = null;
      let mimeType = '';
      let fileName = '';
      let fileSize = 0;
      let isExternal = false;

      if (fetched && !fetched.fallbackExternal && fetched.asset) {
        src = fetched.asset.url;
        assetId = fetched.asset.id;
        mimeType = fetched.asset.mimeType;
        fileName = fetched.asset.fileName;
        fileSize = fetched.asset.sizeBytes;
      } else {
        isExternal = true;
        try {
          fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
        } catch {}
        store.emitToast('无法下载到本地，已改用外链加载（可能随原站失效）', 'warning');
      }

      if (resolvedKind === 'image') {
        const natural = await probeImageSize(src);
        const dims = computeInitialCardSize('image', natural.width, natural.height);
        return {
          kind: 'image',
          title: fallbackTitle || stripExt(fileName) || '网络图片',
          width: dims.width,
          height: dims.height,
          media: {
            ...(assetId ? { assetId } : {}),
            src,
            originUrl: url,
            mimeType,
            fileName,
            fileSize,
            naturalWidth: natural.width,
            naturalHeight: natural.height,
            isExternal
          }
        };
      }

      const natural = await probeVideoSize(src);
      const dims = computeInitialCardSize('video', natural.width, natural.height);
      return {
        kind: 'video',
        title: fallbackTitle || stripExt(fileName) || '网络视频',
        width: dims.width,
        height: dims.height,
        media: {
          ...(assetId ? { assetId } : {}),
          src,
          originUrl: url,
          mimeType,
          fileName,
          fileSize,
          naturalWidth: natural.width,
          naturalHeight: natural.height,
          duration: natural.duration || 0,
          isExternal
        }
      };
    }

    // Webpage URL
    if (!probeInfo) probeInfo = await this.probeUrl(url);
    const dims = computeInitialCardSize('webpage');
    const embeddable = probeInfo?.embeddable !== false;
    return {
      kind: 'webpage',
      title: fallbackTitle || probeInfo?.title || url,
      width: dims.width,
      height: dims.height,
      media: {
        sourceType: 'url',
        url: probeInfo?.url || url,
        src: probeInfo?.url || url,
        title: probeInfo?.title || fallbackTitle || url,
        favicon: probeInfo?.favicon || '',
        description: probeInfo?.description || '',
        embeddable,
        blockReason: probeInfo?.blockReason || null,
        viewMode: embeddable ? 'iframe' : 'bookmark',
        isLocal: false
      }
    };
  }

  async prepareSpecFromFolderEntry(dirEntry) {
    const filesWithRel = [];
    const readEntries = (reader) => new Promise((res, rej) => reader.readEntries(res, rej));
    const readFile = (entry) => new Promise((res, rej) => entry.file(res, rej));

    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await readFile(entry);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        filesWithRel.push({ file, relPath });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch = [];
        do {
          batch = await readEntries(reader);
          for (const child of batch) {
            await walk(child, prefix ? `${prefix}/${entry.name}` : entry.name);
          }
        } while (batch.length > 0);
      }
    };

    const topReader = dirEntry.createReader();
    let topBatch = [];
    do {
      topBatch = await readEntries(topReader);
      for (const child of topBatch) {
        await walk(child, '');
      }
    } while (topBatch.length > 0);

    const htmlEntries = filesWithRel
      .map(it => it.relPath)
      .filter(p => HTML_EXTS.has(getExt(p)));

    if (htmlEntries.length > 0) {
      const topHtml = htmlEntries.filter(p => !p.includes('/'));
      let chosenEntry = null;
      if (topHtml.includes('index.html')) chosenEntry = 'index.html';
      else if (topHtml.includes('index.htm')) chosenEntry = 'index.htm';
      else if (topHtml.length === 1) chosenEntry = topHtml[0];
      else if (htmlEntries.length === 1) chosenEntry = htmlEntries[0];
      else {
        const candidates = topHtml.length > 1 ? topHtml : htmlEntries;
        chosenEntry = await this.pickHtmlEntry(candidates, dirEntry.name);
        if (!chosenEntry) return [];
      }

      const asset = await this.uploadFolderBundle(filesWithRel, dirEntry.name, chosenEntry);
      if (!asset) return [];
      const dims = computeInitialCardSize('webpage');
      return [{
        kind: 'webpage',
        title: dirEntry.name || '本地网页项目',
        width: dims.width,
        height: dims.height,
        media: {
          sourceType: 'html-bundle',
          assetId: asset.id,
          entryPath: asset.entryPath,
          htmlEntries: asset.htmlEntries || htmlEntries,
          src: asset.url,
          url: asset.url,
          fileName: asset.fileName,
          fileSize: asset.sizeBytes,
          embeddable: true,
          viewMode: 'iframe',
          isLocal: true
        }
      }];
    }

    // No HTML inside folder -> expand media files
    const specs = [];
    let skipped = 0;
    for (const item of filesWithRel) {
      const k = classifyFile(item.file);
      if (k === 'image' || k === 'video') {
        const spec = await this.prepareSpecFromFile(item.file);
        if (spec && !spec.unsupported && !spec.aborted && !spec.error) {
          specs.push(spec);
        }
      } else {
        skipped += 1;
      }
    }
    if (specs.length === 0) {
      store.emitToast(`文件夹「${dirEntry.name}」中未找到 HTML、图片或视频文件`, 'warning');
    } else if (skipped > 0) {
      store.emitToast(`已导入 ${specs.length} 个媒体文件，跳过 ${skipped} 个不支持的文件`, 'info');
    }
    return specs;
  }

  extractUrlsFromDataTransfer(dt) {
    if (!dt) return [];
    const urls = [];
    const seen = new Set();
    const pushUrl = (raw) => {
      const u = String(raw || '').trim();
      if (isValidHttpUrl(u) && !seen.has(u)) {
        seen.add(u);
        urls.push(u);
      }
    };

    const htmlStr = dt.getData('text/html') || '';
    if (htmlStr) {
      try {
        const doc = new DOMParser().parseFromString(htmlStr, 'text/html');
        const img = doc.querySelector('img[src]');
        const video = doc.querySelector('video[src], video source[src]');
        const anchor = doc.querySelector('a[href]');
        if (img?.getAttribute('src')) pushUrl(img.getAttribute('src'));
        else if (video?.getAttribute('src')) pushUrl(video.getAttribute('src'));
        else if (anchor?.getAttribute('href')) pushUrl(anchor.getAttribute('href'));
      } catch {}
    }

    const uriList = dt.getData('text/uri-list') || '';
    for (const line of uriList.split(/\r?\n/)) {
      if (line.trim() && !line.trim().startsWith('#')) {
        pushUrl(line.trim());
      }
    }

    const plain = (dt.getData('text/plain') || '').trim();
    if (plain && isValidHttpUrl(plain)) {
      pushUrl(plain);
    }

    return urls;
  }

  detectDropTarget(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return { type: 'canvas' };
    const cardEl = el.closest?.('.note-card');
    if (cardEl) {
      const cardId = cardEl.id.replace('card-dom-', '');
      const card = store.state.cards.find(c => c.id === cardId);
      if (card) {
        if (card.kind === 'subcanvas') {
          return { type: 'subcanvas', card, cardEl };
        }
        if (card.kind === 'image' || card.kind === 'video' || card.kind === 'webpage') {
          return { type: 'media-card', card, cardEl };
        }
        return { type: 'text-card', card, cardEl };
      }
    }
    const groupEl = el.closest?.('.node-group');
    if (groupEl) {
      const groupId = groupEl.id.replace('group-dom-', '');
      const group = store.state.groups?.find(g => g.id === groupId);
      if (group) {
        return { type: 'group', group, groupEl };
      }
    }
    return { type: 'canvas' };
  }

  clearDropIndicators() {
    if (this._currentDropHighlight) {
      this._currentDropHighlight.classList.remove('is-media-drop-target', 'group-drop-target');
      this._currentDropHighlight = null;
    }
    if (this.dropBannerEl) {
      this.dropBannerEl.classList.remove('is-visible');
    }
    if (this.dropCaretEl) {
      this.dropCaretEl.style.display = 'none';
      this.dropCaretEl.classList.remove('is-block-line');
    }
  }

  _getCaretRangeFromPoint(bodyEl, clientX, clientY) {
    if (!bodyEl) return null;
    const bodyRect = bodyEl.getBoundingClientRect();
    const x = Math.min(Math.max(clientX, bodyRect.left + 8), Math.max(bodyRect.left + 8, bodyRect.right - 8));
    const y = Math.min(Math.max(clientY, bodyRect.top + 8), Math.max(bodyRect.top + 8, bodyRect.bottom - 8));

    let range = null;
    if (typeof document.caretRangeFromPoint === 'function') {
      range = document.caretRangeFromPoint(x, y);
    } else if (typeof document.caretPositionFromPoint === 'function') {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos?.offsetNode) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }

    if (range && bodyEl.contains(range.startContainer) && range.startContainer !== bodyEl) {
      const startEl = range.startContainer.nodeType === 1
        ? range.startContainer
        : range.startContainer.parentElement;
      const inlineAtomic = startEl?.closest?.('.inline-media-block, .inline-link-chip, .text-capsule');
      if (inlineAtomic && bodyEl.contains(inlineAtomic)) {
        const br = inlineAtomic.getBoundingClientRect();
        if (inlineAtomic.classList.contains('inline-media-block')) {
          if (y < br.top + br.height / 2) {
            range.setStartBefore(inlineAtomic);
          } else {
            range.setStartAfter(inlineAtomic);
          }
        } else {
          if (x < br.left + br.width / 2) {
            range.setStartBefore(inlineAtomic);
          } else {
            range.setStartAfter(inlineAtomic);
          }
        }
        range.collapse(true);
      }
      return range;
    }

    // Geometric line/node resolution when caretRangeFromPoint is unavailable, off-screen, or hit container gap
    const items = [];
    const collectRect = (node) => {
      if (node.nodeType === 3) {
        if (!(node.textContent || '').length) return null;
        const r = document.createRange();
        r.selectNodeContents(node);
        return r.getBoundingClientRect();
      }
      if (node.nodeType === 1) {
        return node.getBoundingClientRect();
      }
      return null;
    };

    for (const child of [...bodyEl.childNodes]) {
      const rect = collectRect(child);
      if (rect && (rect.height > 0 || rect.width > 0)) {
        items.push({ node: child, rect });
      }
    }

    const resolved = document.createRange();
    if (items.length === 0) {
      resolved.setStart(bodyEl, 0);
      resolved.collapse(true);
      return resolved;
    }

    if (y < items[0].rect.top) {
      resolved.setStartBefore(items[0].node);
      resolved.collapse(true);
      return resolved;
    }
    const lastItem = items[items.length - 1];
    if (y > lastItem.rect.bottom) {
      resolved.setStartAfter(lastItem.node);
      resolved.collapse(true);
      return resolved;
    }

    // Find closest vertical item
    let best = items[0];
    let bestDist = Infinity;
    for (const it of items) {
      const dist = y < it.rect.top
        ? it.rect.top - y
        : (y > it.rect.bottom ? y - it.rect.bottom : 0);
      if (dist < bestDist) {
        bestDist = dist;
        best = it;
        if (dist === 0) break;
      }
    }

    const targetNode = best.node;
    if (targetNode.nodeType === 3) {
      const len = targetNode.textContent.length;
      if (x <= best.rect.left) {
        resolved.setStart(targetNode, 0);
      } else if (x >= best.rect.right) {
        resolved.setStart(targetNode, len);
      } else {
        // Binary search exact character offset
        let lo = 0;
        let hi = len;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          const cr = document.createRange();
          cr.setStart(targetNode, mid);
          cr.setEnd(targetNode, Math.min(len, mid + 1));
          const cRect = cr.getBoundingClientRect();
          if (x < cRect.left + cRect.width / 2) hi = mid;
          else lo = mid + 1;
        }
        resolved.setStart(targetNode, lo);
      }
      resolved.collapse(true);
      return resolved;
    }

    if (targetNode.nodeType === 1) {
      if (targetNode.classList?.contains('inline-media-block')) {
        if (y < best.rect.top + best.rect.height / 2) resolved.setStartBefore(targetNode);
        else resolved.setStartAfter(targetNode);
        resolved.collapse(true);
        return resolved;
      }
      if (targetNode.tagName === 'DIV' || targetNode.tagName === 'P') {
        const inner = this._getCaretRangeFromPoint(targetNode, x, y);
        if (inner) return inner;
      }
      if (y < best.rect.top + best.rect.height / 2) resolved.setStartBefore(targetNode);
      else resolved.setStartAfter(targetNode);
      resolved.collapse(true);
      return resolved;
    }

    resolved.setStart(bodyEl, bodyEl.childNodes.length);
    resolved.collapse(true);
    return resolved;
  }

  _showDropCaret(bodyEl, clientX, clientY) {
    if (!this.dropCaretEl || !bodyEl) return;
    const range = this._getCaretRangeFromPoint(bodyEl, clientX, clientY);
    if (!range) return;

    const bodyRect = bodyEl.getBoundingClientRect();
    if (clientY < bodyRect.top || clientY > bodyRect.bottom) {
      this.dropCaretEl.style.display = 'none';
      return;
    }

    let rect = range.getClientRects?.()[0] || range.getBoundingClientRect();
    const isLineMode = !rect || rect.height === 0 || range.startContainer === bodyEl;

    if (!isLineMode && rect && rect.height > 0) {
      this.dropCaretEl.classList.remove('is-block-line');
      this.dropCaretEl.style.left = `${Math.round(rect.left)}px`;
      this.dropCaretEl.style.top = `${Math.round(rect.top)}px`;
      this.dropCaretEl.style.width = '2px';
      this.dropCaretEl.style.height = `${Math.max(16, Math.min(26, Math.round(rect.height)))}px`;
      this.dropCaretEl.style.display = 'block';
      return;
    }

    // Horizontal line caret for empty body or between block nodes
    let lineTop = bodyRect.top + 12;
    if (bodyEl.childNodes.length > 0 && range.startOffset > 0) {
      const prev = bodyEl.childNodes[Math.min(range.startOffset - 1, bodyEl.childNodes.length - 1)];
      if (prev?.nodeType === 1) {
        lineTop = prev.getBoundingClientRect().bottom + 2;
      } else {
        const tmp = document.createRange();
        tmp.selectNodeContents(bodyEl);
        const r = tmp.getBoundingClientRect();
        if (r && r.height > 0) lineTop = r.bottom + 2;
      }
    }
    lineTop = Math.min(Math.max(lineTop, bodyRect.top + 8), bodyRect.bottom - 6);
    this.dropCaretEl.classList.add('is-block-line');
    this.dropCaretEl.style.left = `${Math.round(bodyRect.left + 12)}px`;
    this.dropCaretEl.style.top = `${Math.round(lineTop)}px`;
    this.dropCaretEl.style.width = `${Math.max(40, Math.round(bodyRect.width - 24))}px`;
    this.dropCaretEl.style.height = '2px';
    this.dropCaretEl.style.display = 'block';
  }

  showDropIndicator(targetInfo, clientX = null, clientY = null) {
    this.clearDropIndicators();
    let message = '释放鼠标即可添加媒体/网页卡片到画布';
    if (targetInfo.type === 'subcanvas' && targetInfo.cardEl) {
      targetInfo.cardEl.classList.add('is-media-drop-target');
      this._currentDropHighlight = targetInfo.cardEl;
      message = `释放以投递到子画布「${targetInfo.card.title || '子画布'}」`;
    } else if (targetInfo.type === 'media-card' && targetInfo.cardEl) {
      targetInfo.cardEl.classList.add('is-media-drop-target');
      this._currentDropHighlight = targetInfo.cardEl;
      message = `释放以替换「${targetInfo.card.title || '媒体卡片'}」内容`;
    } else if (targetInfo.type === 'text-card' && targetInfo.cardEl) {
      targetInfo.cardEl.classList.add('is-media-drop-target');
      this._currentDropHighlight = targetInfo.cardEl;
      message = `释放以嵌入到「${targetInfo.card.title || '节点'}」光标位置`;
      if (clientX !== null && clientY !== null) {
        const bodyEl = targetInfo.cardEl.querySelector('.note-body');
        this._showDropCaret(bodyEl, clientX, clientY);
      }
    } else if (targetInfo.type === 'group' && targetInfo.groupEl) {
      targetInfo.groupEl.classList.add('group-drop-target');
      this._currentDropHighlight = targetInfo.groupEl;
      message = `释放以创建卡片并加入组「${targetInfo.group.title || '节点组'}」`;
    }
    if (this.dropBannerEl) {
      this.dropBannerEl.textContent = message;
      this.dropBannerEl.classList.add('is-visible');
    }
  }

  _snapPos(pos) {
    let x = Math.round(pos.x);
    let y = Math.round(pos.y);
    if (store.state.settings?.gridSnapMode) {
      x = Math.round(x / 24) * 24;
      y = Math.round(y / 24) * 24;
    }
    return { x, y };
  }

  _layoutBatchPositions(specs, originPos) {
    const gap = 28;
    const cols = specs.length <= 1 ? 1 : Math.min(3, Math.ceil(Math.sqrt(specs.length)));
    const positions = [];
    let curX = originPos.x;
    let curY = originPos.y;
    let rowMaxH = 0;

    specs.forEach((spec, idx) => {
      const col = idx % cols;
      if (col === 0 && idx > 0) {
        curX = originPos.x;
        curY += rowMaxH + gap;
        rowMaxH = 0;
      }
      const pos = this._snapPos({ x: curX, y: curY });
      positions.push(pos);
      curX += (spec.width || 360) + gap;
      rowMaxH = Math.max(rowMaxH, spec.height || 240);
    });
    return positions;
  }

  _createCardObjectFromSpec(spec, pos) {
    return {
      id: store._nextId('card'),
      kind: spec.kind,
      title: spec.title,
      x: pos.x,
      y: pos.y,
      width: spec.width,
      height: spec.height,
      contentHtml: '',
      media: spec.media
    };
  }

  async _deliverToSubcanvas(subcanvasCard, specs) {
    const sid = subcanvasCard.subcanvasId;
    if (!sid) return;
    let entry = store.canvasesCache.get(sid);
    if (!entry && this.isBackendConnected()) {
      try {
        const res = await fetch(`${API_BASE}/canvases/${encodeURIComponent(sid)}`);
        if (res.ok) {
          const json = await res.json();
          if (json?.ok && json.data) {
            entry = {
              id: sid,
              parentCanvasId: json.data.parentCanvasId ?? store.activeCanvasId,
              title: json.data.title || subcanvasCard.title || '子画布',
              breadcrumbs: json.data.breadcrumbs || [...store.breadcrumbs, { id: sid, title: subcanvasCard.title }],
              viewport: json.data.viewport || { x: 0, y: 0, zoom: 1.0 },
              cards: json.data.cards || [],
              connections: json.data.connections || [],
              groups: json.data.groups || [],
              dirty: false,
              updatedAt: Date.now()
            };
          }
        }
      } catch {}
    }
    if (!entry) {
      store.emitToast('无法加载目标子画布', 'warning');
      return;
    }

    const basePos = entry.cards?.length
      ? {
          x: Math.max(...entry.cards.map(c => c.x + (c.width || 310))) + 64,
          y: Math.round(entry.cards.reduce((s, c) => s + c.y, 0) / entry.cards.length)
        }
      : { x: 140, y: 180 };

    const positions = this._layoutBatchPositions(specs, basePos);
    const created = specs.map((spec, i) => this._createCardObjectFromSpec(spec, positions[i]));
    entry.cards = [...(entry.cards || []), ...created];
    entry.dirty = true;
    entry.updatedAt = Date.now();
    store.putCachedCanvas(entry);
    store._refreshSubcanvasThumbnailsOnActive();
    window.__nodes?.render?.();
    window.__wires?.render?.();
    store.notifyCanvasTreeUpdated();
    store.emitToast(`已添加 ${created.length} 个媒体卡片到子画布「${subcanvasCard.title || '子画布'}」`, 'success');
  }

  _buildInlineSnippetFromSpec(spec) {
    const m = spec.media || {};
    if (spec.kind === 'image') {
      return buildInlineImageHtml(m.src, spec.title, m.assetId || '', m.originUrl || '');
    }
    if (spec.kind === 'video') {
      return buildInlineVideoHtml(m.src, spec.title, m.assetId || '', m.originUrl || '');
    }
    return buildInlineLinkHtml(m.url || m.src, spec.title, m.assetId || '', m.sourceType || 'url');
  }

  _buildInlineSnippetFromCard(card) {
    if (!card) return '';
    const m = card.media || {};
    if (card.kind === 'image') {
      return buildInlineImageHtml(m.src || '', card.title || '图片', m.assetId || '', m.originUrl || '');
    }
    if (card.kind === 'video') {
      return buildInlineVideoHtml(m.src || '', card.title || '视频', m.assetId || '', m.originUrl || '');
    }
    if (card.kind === 'webpage') {
      return buildInlineLinkHtml(m.url || m.src || '', m.title || card.title || '', m.assetId || '', m.sourceType || 'url');
    }
    return '';
  }

  _insertIntoTextCard(card, cardEl, specs, dropRange = null) {
    const bodyEl = cardEl?.querySelector('.note-body');
    const isBlockMedia = specs.some(s => s.kind === 'image' || s.kind === 'video');
    const snippets = specs.map(s => this._buildInlineSnippetFromSpec(s)).join(isBlockMedia ? '' : ' ');
    if (bodyEl) {
      this._insertInlineHtml(bodyEl, snippets, dropRange, { isBlockMedia });
      card.contentHtml = bodyEl.innerHTML;
    } else {
      const current = (card.contentHtml || '').trim();
      const sep = current ? '<br>' : '';
      const tail = isBlockMedia ? '<div><br></div>' : '';
      card.contentHtml = `${card.contentHtml || ''}${sep}${snippets}${tail}`;
    }
    store.commit();
    window.__nodes?.render?.();
    window.__wires?.render?.();
    store.scheduleAutoSave();
    store.emitToast(`已将 ${specs.length} 项内容嵌入「${card.title || '节点'}」`, 'success');
  }

  async applySpecsAtTarget(specs, targetInfo, boardPos) {
    if (!specs || specs.length === 0) return;
    const nodesMgr = window.__nodes;
    const wiresMgr = window.__wires;

    if (targetInfo.type === 'subcanvas' && targetInfo.card) {
      await this._deliverToSubcanvas(targetInfo.card, specs);
      return;
    }

    if (targetInfo.type === 'text-card' && targetInfo.card) {
      this._insertIntoTextCard(targetInfo.card, targetInfo.cardEl, specs, targetInfo.dropRange || null);
      return;
    }

    let remaining = specs;
    const createdIds = [];

    if (targetInfo.type === 'media-card' && targetInfo.card) {
      const targetCard = targetInfo.card;
      const first = specs[0];
      targetCard.kind = first.kind;
      targetCard.width = first.width;
      targetCard.height = first.height;
      targetCard.media = first.media;
      if (!targetCard.customTitle) {
        targetCard.title = first.title;
      }
      if (first.kind === 'webpage') {
        nodesMgr?.loadedWebpageIds?.add(targetCard.id);
      } else {
        nodesMgr?.loadedWebpageIds?.delete(targetCard.id);
      }
      remaining = specs.slice(1);
      createdIds.push(targetCard.id);
      if (remaining.length === 0) {
        store.commit();
        nodesMgr?.render?.();
        wiresMgr?.render?.();
        nodesMgr?.selectCard?.(targetCard.id, false);
        store.scheduleAutoSave();
        store.emitToast(`已替换「${targetCard.title}」的内容`, 'success');
        return;
      }
    }

    const origin = targetInfo.type === 'media-card' && targetInfo.card
      ? { x: targetInfo.card.x + (targetInfo.card.width || 360) + 32, y: targetInfo.card.y }
      : { x: boardPos.x - Math.round((remaining[0].width || 360) / 2), y: boardPos.y - 40 };

    const positions = this._layoutBatchPositions(remaining, origin);
    remaining.forEach((spec, idx) => {
      const cardObj = this._createCardObjectFromSpec(spec, positions[idx]);
      if (cardObj.kind === 'webpage') {
        nodesMgr?.loadedWebpageIds?.add(cardObj.id);
      }
      store.state.cards.push(cardObj);
      createdIds.push(cardObj.id);
      if (targetInfo.type === 'group' && targetInfo.group) {
        if (!targetInfo.group.cardIds.includes(cardObj.id)) {
          targetInfo.group.cardIds.push(cardObj.id);
        }
      }
    });

    store.commit();
    nodesMgr?.render?.();
    wiresMgr?.render?.();
    if (nodesMgr && createdIds.length > 0) {
      nodesMgr.selectedCardIds.clear();
      createdIds.forEach(id => nodesMgr.selectedCardIds.add(id));
      nodesMgr.updateSelectionVisuals();
      nodesMgr.updateAlignmentBar();
      nodesMgr.onSelectionChange?.();
    }
    store.scheduleAutoSave();
  }

  async handleDropEvent(e) {
    if (e.dataTransfer?.types?.includes('application/x-pinpoint-library')) return;
    e.preventDefault();
    e.stopPropagation();

    const targetInfo = this.detectDropTarget(e.clientX, e.clientY);
    if (targetInfo.type === 'text-card' && targetInfo.cardEl) {
      const bodyEl = targetInfo.cardEl.querySelector('.note-body');
      targetInfo.dropRange = bodyEl ? this._getCaretRangeFromPoint(bodyEl, e.clientX, e.clientY) : null;
    }
    const boardPos = canvas.screenToBoard(e.clientX, e.clientY);
    this.clearDropIndicators();

    if (store.isFocusMode && targetInfo.type === 'subcanvas') {
      store.emitToast('当前处于专注模式，暂不支持向子画布投递文件', 'warning');
      return;
    }

    const dt = e.dataTransfer;
    if (!dt) return;

    const specs = [];
    const unsupported = [];
    const items = [...(dt.items || [])];
    const dirEntries = items
      .map(it => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
      .filter(entry => entry && entry.isDirectory);

    try {
      if (dirEntries.length > 0) {
        for (const dir of dirEntries) {
          const folderSpecs = await this.prepareSpecFromFolderEntry(dir);
          specs.push(...folderSpecs);
        }
        // Also handle any loose files dragged alongside directories
        for (const it of items) {
          const entry = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
          if (entry && entry.isFile) {
            const file = it.getAsFile();
            if (file) {
              const res = await this.prepareSpecFromFile(file);
              if (res?.unsupported) unsupported.push(res.name);
              else if (res?.error) store.emitToast(res.error, 'warning');
              else if (res && !res.aborted) specs.push(res);
            }
          }
        }
      } else if (dt.files && dt.files.length > 0) {
        const fileList = [...dt.files];
        for (const file of fileList) {
          const kind = classifyFile(file);
          if (kind === 'pinpoint') {
            try {
              const content = await file.text();
              await store.importAsSubcanvas(JSON.parse(content), file.name, boardPos);
              window.__nodes?.render?.();
              window.__wires?.render?.();
            } catch {
              store.emitToast(`无效的 .pinpoint 文件「${file.name}」`, 'warning');
            }
            continue;
          }
          if (kind === 'pinpoint-zip') {
            await this.importZipAsSubcanvas(file, boardPos);
            continue;
          }
          const res = await this.prepareSpecFromFile(file);
          if (res?.unsupported) unsupported.push(res.name);
          else if (res?.error) store.emitToast(res.error, 'warning');
          else if (res && !res.aborted) specs.push(res);
        }
      } else {
        const urls = this.extractUrlsFromDataTransfer(dt);
        for (const u of urls) {
          const spec = await this.prepareSpecFromUrl(u);
          if (spec) specs.push(spec);
        }
        if (urls.length === 0 && dt.types?.length > 0) {
          store.emitToast('仅支持拖入图片、视频、网页/HTML 或 .pinpoint 文件', 'warning');
        }
      }
    } catch (err) {
      store.emitToast(err?.message || '导入媒体文件失败', 'warning');
    }

    if (unsupported.length > 0) {
      store.emitToast(`不支持的文件格式：${unsupported.slice(0, 3).join('、')}${unsupported.length > 3 ? ' 等' : ''}`, 'warning');
    }

    if (specs.length > 0) {
      await this.applySpecsAtTarget(specs, targetInfo, boardPos);
    }
  }

  async handlePasteEvent(e) {
    if (window.__settings?.isOpen?.()) return;
    const activeEl = document.activeElement instanceof Element ? document.activeElement : null;
    const editingBody = activeEl?.closest?.('.note-body');

    // Ignore if typing inside an input/textarea/title input
    if (!editingBody && activeEl?.closest?.('input, textarea, select, [contenteditable="true"]')) {
      return;
    }

    const cd = e.clipboardData;
    if (!cd) return;

    const files = [];
    for (const item of [...(cd.items || [])]) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    const plainText = (cd.getData('text/plain') || '').trim();
    const nodesMgr = window.__nodes;

    // 1. Inside a normal card's .note-body editor (Q20-A & Q21-A)
    const clip = nodesMgr?.clipboard;
    const hasInternalClip = !!(clip && clip.cards?.length > 0);
    const matchesInternalMarker = !!(hasInternalClip && clip.marker && plainText === clip.marker);

    if (editingBody) {
      const cardEl = editingBody.closest('.note-card');
      const cardId = cardEl?.id.replace('card-dom-', '');
      const card = store.state.cards.find(c => c.id === cardId);
      if (!card) return;

      if (files.length > 0) {
        e.preventDefault();
        const specs = [];
        for (const f of files) {
          const res = await this.prepareSpecFromFile(f);
          if (res?.unsupported) store.emitToast(`不支持的文件格式：${res.name}`, 'warning');
          else if (res && !res.aborted && !res.error) specs.push(res);
        }
        if (specs.length > 0) {
          const isBlockMedia = specs.some(s => s.kind === 'image' || s.kind === 'video');
          const html = specs.map(s => this._buildInlineSnippetFromSpec(s)).join(isBlockMedia ? '' : ' ');
          this._insertInlineHtml(editingBody, html, null, { isBlockMedia });
          card.contentHtml = editingBody.innerHTML;
          store.commit();
          window.__wires?.render?.();
          store.scheduleAutoSave();
        }
        return;
      }

      if (matchesInternalMarker || (hasInternalClip && !clip.markerWritten && !plainText)) {
        e.preventDefault();
        const mediaCards = clip.cards.filter(c => c.kind === 'image' || c.kind === 'video' || c.kind === 'webpage');
        if (mediaCards.length > 0) {
          const isBlockMedia = mediaCards.some(c => c.kind === 'image' || c.kind === 'video');
          const html = mediaCards.map(c => this._buildInlineSnippetFromCard(c)).join(isBlockMedia ? '' : ' ');
          this._insertInlineHtml(editingBody, html, null, { isBlockMedia });
          card.contentHtml = editingBody.innerHTML;
          store.commit();
          window.__wires?.render?.();
          store.scheduleAutoSave();
        } else {
          const textSnippets = clip.cards
            .filter(c => !c.kind || c.kind === 'card')
            .map(c => (c.contentHtml && c.contentHtml.trim()) ? c.contentHtml : escapeHtml(c.title || ''))
            .filter(Boolean);
          if (textSnippets.length > 0) {
            this._insertInlineHtml(editingBody, textSnippets.join('<br>'), null, { isBlockMedia: false });
            card.contentHtml = editingBody.innerHTML;
            store.commit();
            window.__wires?.render?.();
            store.scheduleAutoSave();
          }
        }
        return;
      }

      if (plainText.startsWith('pinpoint-clip:')) {
        e.preventDefault();
        return;
      }

      if (plainText && isValidHttpUrl(plainText) && !/\s/.test(plainText)) {
        e.preventDefault();
        const spec = await this.prepareSpecFromUrl(plainText);
        if (spec) {
          const isBlockMedia = spec.kind === 'image' || spec.kind === 'video';
          const html = this._buildInlineSnippetFromSpec(spec);
          this._insertInlineHtml(editingBody, html, null, { isBlockMedia });
          card.contentHtml = editingBody.innerHTML;
          store.commit();
          window.__wires?.render?.();
          store.scheduleAutoSave();
        }
        return;
      }
      return; // Normal plain text paste
    }

    // 2. Canvas focused (outside text editors) — Q23-A priority rule

    // If external files (e.g. screenshot) are present, always prioritize external media!
    if (files.length > 0) {
      e.preventDefault();
      const specs = [];
      for (const f of files) {
        const res = await this.prepareSpecFromFile(f);
        if (res?.unsupported) store.emitToast(`不支持的文件格式：${res.name}`, 'warning');
        else if (res && !res.aborted && !res.error) specs.push(res);
      }
      if (specs.length > 0) {
        const targetInfo = this._resolvePasteTarget(nodesMgr);
        const pos = nodesMgr?.mouseBoardPos || canvas.screenToBoard(window.innerWidth / 2, window.innerHeight / 2);
        await this.applySpecsAtTarget(specs, targetInfo, pos);
      }
      return;
    }

    if (matchesInternalMarker) {
      e.preventDefault();
      nodesMgr.pasteCards();
      return;
    }

    if (plainText && isValidHttpUrl(plainText) && !/\s/.test(plainText)) {
      e.preventDefault();
      const spec = await this.prepareSpecFromUrl(plainText);
      if (spec) {
        const targetInfo = this._resolvePasteTarget(nodesMgr);
        const pos = nodesMgr?.mouseBoardPos || canvas.screenToBoard(window.innerWidth / 2, window.innerHeight / 2);
        await this.applySpecsAtTarget([spec], targetInfo, pos);
      }
      return;
    }

    // If internal clipboard wasn't written to system clipboard (or clipboard empty), fall back to internal cards
    if (hasInternalClip && (!clip.markerWritten || !plainText)) {
      e.preventDefault();
      nodesMgr.pasteCards();
    }
  }

  _resolvePasteTarget(nodesMgr) {
    if (nodesMgr?.selectedCardIds?.size === 1) {
      const cid = [...nodesMgr.selectedCardIds][0];
      const card = store.state.cards.find(c => c.id === cid);
      const cardEl = document.getElementById(`card-dom-${cid}`);
      if (card && (card.kind === 'image' || card.kind === 'video' || card.kind === 'webpage')) {
        return { type: 'media-card', card, cardEl };
      }
    }
    return { type: 'canvas' };
  }

  _hasEditableTargetAfter(node) {
    let sib = node?.nextSibling || null;
    while (sib) {
      if (sib.nodeType === 3) {
        const cleaned = (sib.textContent || '').split(String.fromCharCode(0x200b)).join('');
        if (cleaned.length > 0) return { node: sib, offset: 0 };
        sib = sib.nextSibling;
        continue;
      }
      if (sib.nodeType === 1) {
        if (sib.classList?.contains('inline-media-block')) return null;
        if (sib.tagName === 'BR') {
          let afterBr = sib.nextSibling;
          while (afterBr && afterBr.nodeType === 3 && !afterBr.textContent) afterBr = afterBr.nextSibling;
          if (!afterBr) return null;
          if (afterBr.nodeType === 3) return { node: afterBr, offset: 0 };
          return { node: afterBr, offset: 0 };
        }
        return { node: sib, offset: 0 };
      }
      sib = sib.nextSibling;
    }
    return null;
  }

  _setCaret(containerEl, node, offset = 0) {
    if (!containerEl || !node) return;
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    try {
      range.setStart(node, offset);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
  }

  _insertInlineHtml(containerEl, htmlStr, explicitRange = null, { isBlockMedia = false } = {}) {
    if (!containerEl || !htmlStr) return;
    containerEl.focus();
    const sel = window.getSelection();
    let range = null;

    if (explicitRange && containerEl.contains(explicitRange.startContainer)) {
      range = explicitRange.cloneRange();
    } else if (sel && sel.rangeCount > 0 && containerEl.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0).cloneRange();
    } else {
      range = document.createRange();
      range.setStart(containerEl, containerEl.childNodes.length);
      range.collapse(true);
    }

    if (!range.collapsed) {
      range.deleteContents();
    }

    const frag = range.createContextualFragment(isBlockMedia ? htmlStr : `${htmlStr}&nbsp;`);
    const insertedBlocks = [...frag.querySelectorAll('.inline-media-block')];
    const lastFragChild = frag.lastChild;

    if (!isBlockMedia || insertedBlocks.length === 0) {
      range.insertNode(frag);
      if (lastFragChild) {
        range.setStartAfter(lastFragChild);
        range.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      return;
    }

    // Block media (.inline-media-block) insertion: keep block at top level of containerEl
    // so it doesn't trap a trailing <br> inside an enclosing <div>/<p>.
    const startEl = range.startContainer.nodeType === 1
      ? range.startContainer
      : range.startContainer.parentElement;
    let enclosingBlock = null;
    if (startEl && startEl !== containerEl) {
      let cur = startEl;
      while (cur && cur.parentElement && cur.parentElement !== containerEl) {
        cur = cur.parentElement;
      }
      if (cur && cur.parentElement === containerEl && (cur.tagName === 'DIV' || cur.tagName === 'P')) {
        enclosingBlock = cur;
      }
    }

    const lastInsertedBlock = insertedBlocks[insertedBlocks.length - 1];
    let explicitNextTarget = null;

    if (enclosingBlock) {
      const trailRange = document.createRange();
      trailRange.setStart(range.startContainer, range.startOffset);
      trailRange.setEnd(enclosingBlock, enclosingBlock.childNodes.length);
      const trailingFrag = trailRange.extractContents();

      // Remove solitary trailing <br> left in enclosingBlock if it has real content before it
      while (
        enclosingBlock.lastChild &&
        enclosingBlock.lastChild.nodeType === 1 &&
        enclosingBlock.lastChild.tagName === 'BR' &&
        enclosingBlock.childNodes.length > 1
      ) {
        enclosingBlock.lastChild.remove();
      }

      const hasBeforeContent = Boolean(
        enclosingBlock.textContent.trim() ||
        enclosingBlock.querySelector('.inline-media-block, .inline-link-chip, .text-capsule')
      );

      if (hasBeforeContent) {
        containerEl.insertBefore(frag, enclosingBlock.nextSibling);
      } else {
        containerEl.insertBefore(frag, enclosingBlock);
        enclosingBlock.remove();
      }

      const hasMeaningfulTrailing = Boolean(
        trailingFrag.textContent.trim() ||
        trailingFrag.querySelector?.('.inline-media-block, .inline-link-chip, .text-capsule')
      );
      if (hasMeaningfulTrailing) {
        const afterDiv = document.createElement('div');
        afterDiv.appendChild(trailingFrag);
        containerEl.insertBefore(afterDiv, lastInsertedBlock.nextSibling);
        explicitNextTarget = { node: afterDiv, offset: 0 };
      }
    } else {
      range.insertNode(frag);
    }

    if (explicitNextTarget) {
      this._setCaret(containerEl, explicitNextTarget.node, explicitNextTarget.offset);
      return;
    }

    const existingNext = this._hasEditableTargetAfter(lastInsertedBlock);
    if (existingNext) {
      this._setCaret(containerEl, existingNext.node, existingNext.offset);
      return;
    }

    // Remove a solitary empty <br> right after lastInsertedBlock and replace with a clickable <div><br></div>
    if (
      lastInsertedBlock.nextSibling &&
      lastInsertedBlock.nextSibling.nodeType === 1 &&
      lastInsertedBlock.nextSibling.tagName === 'BR'
    ) {
      lastInsertedBlock.nextSibling.remove();
    }
    const nextLine = document.createElement('div');
    nextLine.appendChild(document.createElement('br'));
    lastInsertedBlock.parentNode.insertBefore(nextLine, lastInsertedBlock.nextSibling);
    this._setCaret(containerEl, nextLine, 0);
  }

  _insertHtmlAtSelection(containerEl, htmlStr) {
    this._insertInlineHtml(containerEl, htmlStr, null, { isBlockMedia: false });
  }

  async popoutInlineMedia(parentCard, inlineEl) {
    if (!parentCard || !inlineEl) return;
    const kind = inlineEl.getAttribute('data-media-kind') || 'webpage';
    const src = inlineEl.getAttribute('data-src') || inlineEl.getAttribute('data-url') || '';
    const title = inlineEl.getAttribute('data-title') || '';
    const assetId = inlineEl.getAttribute('data-asset-id') || '';
    const originUrl = inlineEl.getAttribute('data-origin-url') || '';
    const sourceType = inlineEl.getAttribute('data-source-type') || (assetId ? 'html-file' : 'url');

    let spec = null;
    if (kind === 'image') {
      const natural = await probeImageSize(src);
      const dims = computeInitialCardSize('image', natural.width, natural.height);
      spec = {
        kind: 'image',
        title: title || '图片',
        width: dims.width,
        height: dims.height,
        media: {
          ...(assetId ? { assetId } : {}),
          src,
          ...(originUrl ? { originUrl } : {}),
          naturalWidth: natural.width,
          naturalHeight: natural.height,
          isExternal: !assetId
        }
      };
    } else if (kind === 'video') {
      const natural = await probeVideoSize(src);
      const dims = computeInitialCardSize('video', natural.width, natural.height);
      spec = {
        kind: 'video',
        title: title || '视频',
        width: dims.width,
        height: dims.height,
        media: {
          ...(assetId ? { assetId } : {}),
          src,
          ...(originUrl ? { originUrl } : {}),
          naturalWidth: natural.width,
          naturalHeight: natural.height,
          duration: natural.duration || 0,
          isExternal: !assetId
        }
      };
    } else {
      spec = await this.prepareSpecFromUrl(src, title);
      if (!spec) {
        const dims = computeInitialCardSize('webpage');
        spec = {
          kind: 'webpage',
          title: title || src,
          width: dims.width,
          height: dims.height,
          media: {
            sourceType,
            ...(assetId ? { assetId } : {}),
            url: src,
            src,
            title: title || src,
            embeddable: true,
            viewMode: 'iframe',
            isLocal: !!assetId
          }
        };
      }
    }

    const pos = this._snapPos({
      x: parentCard.x + (parentCard.width || 310) + 40,
      y: parentCard.y
    });
    const newCard = this._createCardObjectFromSpec(spec, pos);
    if (newCard.kind === 'webpage') {
      window.__nodes?.loadedWebpageIds?.add(newCard.id);
    }
    const bodyEl = inlineEl.closest('.note-body');
    inlineEl.remove();
    if (bodyEl) {
      parentCard.contentHtml = bodyEl.innerHTML;
    }
    store.state.cards.push(newCard);
    store.commit();
    window.__nodes?.render?.();
    window.__wires?.render?.();
    window.__nodes?.selectCard?.(newCard.id, false);
    store.scheduleAutoSave();
    store.emitToast('已拆出为独立画布卡片', 'success');
  }

  async convertExternalCardToLocal(card) {
    if (!card || !card.media?.src) return;
    const url = card.media.originUrl || card.media.src;
    if (!isValidHttpUrl(url)) return;
    store.emitToast('正在拉取并转存到本地资源...', 'info');
    const fetched = await this.fetchRemoteMedia(url, card.kind);
    if (fetched && !fetched.fallbackExternal && fetched.asset) {
      card.media = {
        ...card.media,
        assetId: fetched.asset.id,
        src: fetched.asset.url,
        originUrl: url,
        mimeType: fetched.asset.mimeType,
        fileName: fetched.asset.fileName,
        fileSize: fetched.asset.sizeBytes,
        isExternal: false
      };
      store.commit();
      window.__nodes?.render?.();
      store.scheduleAutoSave();
      store.emitToast('已成功转存到本地资源', 'success');
    } else {
      store.emitToast('转存失败：原站可能限制下载或请求超时', 'warning');
    }
  }

  async importZipAsSubcanvas(file, pos = null) {
    if (!this.isBackendConnected()) {
      store.emitToast('导入 .pinpoint.zip 资源包需要连接本地服务', 'warning');
      return null;
    }
    try {
      const res = await fetch(`${API_BASE}/assets/unpack-zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file
      });
      const json = await res.json();
      if (!res.ok || !json?.ok || !json.data) {
        throw new Error(json?.error?.message || '解压资源包失败');
      }
      const out = await store.importAsSubcanvas(json.data, file.name.replace(/\.zip$/i, ''), pos || {});
      window.__nodes?.render?.();
      window.__wires?.render?.();
      return out;
    } catch (err) {
      store.emitToast(err?.message || '导入 .pinpoint.zip 失败', 'warning');
      return { error: err };
    }
  }

  bindCanvasDropAndPaste(viewportEl) {
    if (viewportEl) {
      viewportEl.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types?.includes('application/x-pinpoint-library')) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        const targetInfo = this.detectDropTarget(e.clientX, e.clientY);
        this.showDropIndicator(targetInfo, e.clientX, e.clientY);
      });

      viewportEl.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && viewportEl.contains(e.relatedTarget)) return;
        this.clearDropIndicators();
      });

      viewportEl.addEventListener('drop', (e) => {
        this.handleDropEvent(e);
      });
    }

    window.addEventListener('paste', (e) => {
      this.handlePasteEvent(e);
    });
  }
}

export const media = new MediaManager();
