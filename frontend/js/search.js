import { store } from './state.js';
import { canvas } from './canvas.js';
import { createSearchMatcher } from './searchMatch.mjs';

const INCLUDE_CONTENT_KEY = 'pinpoint.search.includeContent';
const BLOCK_TAGS = 'address, article, blockquote, dd, div, dt, h1, h2, h3, h4, h5, h6, li, p, pre, section, td, th, tr';
const SEARCH_UPDATE_EVENTS = new Set([
  'CARD_ADDED', 'CARD_UPDATED', 'CARD_REMOVED', 'GROUP_ADDED', 'GROUP_UPDATED', 'GROUP_REMOVED',
  'STATE_RESTORED', 'STATE_RESET', 'CANVAS_SWITCHED', 'CANVAS_TREE_UPDATED',
  'FOCUS_MODE_ENTERED', 'FOCUS_MODE_EXITED', 'FOCUS_MODE_CANCELLED'
]);

function readContentText(html, template) {
  template.innerHTML = html || '';
  const content = template.content;
  content.querySelectorAll('script, style, [hidden]').forEach(el => el.remove());
  content.querySelectorAll('br, hr').forEach(el => el.replaceWith(' '));
  content.querySelectorAll(BLOCK_TAGS).forEach(el => {
    el.before(' ');
    el.after(' ');
  });
  return content.textContent.replace(/\s+/g, ' ').trim();
}

function appendHighlightedText(parent, text, ranges) {
  let cursor = 0;
  for (const [start, end] of ranges) {
    parent.append(text.slice(cursor, start));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(start, end);
    parent.append(mark);
    cursor = end;
  }
  parent.append(text.slice(cursor));
}

function makeSnippet(text, ranges) {
  if (!ranges.length) return { text: '', ranges: [] };
  const start = Math.max(0, ranges[0][0] - 48);
  const end = Math.min(text.length, Math.max(start + 180, ranges[0][1] + 48));
  const prefix = start > 0 ? '…' : '';
  return {
    text: `${prefix}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
    ranges: ranges.filter(range => range[0] < end && range[1] > start).map(range => [
      Math.max(start, range[0]) - start + prefix.length,
      Math.min(end, range[1]) - start + prefix.length
    ])
  };
}

class SearchManager {
  scope = 'current';
  results = [];
  activeIndex = -1;
  searchSequence = 0;
  includeContent = false;
  remoteSnapshot = null;
  openingResult = false;

  init(panelEl) {
    this.panelEl = panelEl;
    this.inputEl = panelEl.querySelector('#search-input');
    this.scopeEl = panelEl.querySelector('#search-scope');
    this.includeContentEl = panelEl.querySelector('#search-include-content');
    this.resultsEl = panelEl.querySelector('#search-results');
    this.statusEl = panelEl.querySelector('#search-empty');
    this.statusEl.hidden = false;

    try {
      this.includeContent = localStorage.getItem(INCLUDE_CONTENT_KEY) === 'true';
    } catch {}
    this.includeContentEl.checked = this.includeContent;
    this.updatePlaceholder();

    this.inputEl.addEventListener('input', e => {
      if (!e.isComposing) this.refresh();
    });
    this.inputEl.addEventListener('compositionend', () => this.refresh());
    this.includeContentEl.addEventListener('change', () => {
      this.includeContent = this.includeContentEl.checked;
      try {
        localStorage.setItem(INCLUDE_CONTENT_KEY, String(this.includeContent));
      } catch {}
      this.updatePlaceholder();
      this.refresh();
    });
    panelEl.querySelector('#search-close').addEventListener('click', () => this.close());
    this.resultsEl.addEventListener('click', e => {
      const item = e.target.closest('[data-search-result-index]');
      if (item) this.openResult(Number(item.dataset.searchResultIndex));
    });
    store.subscribe(event => {
      if (!this.isOpen() || this.openingResult) return;
      const remoteChange = event.type === 'REMOTE_SYNCED' && event.sourceEvent !== 'VIEWPORT_CHANGED';
      if (remoteChange || event.type === 'CANVAS_TREE_UPDATED') this.remoteSnapshot = null;
      if ((remoteChange || SEARCH_UPDATE_EVENTS.has(event.type)) && !this.refreshQueued) {
        this.refreshQueued = true;
        queueMicrotask(() => {
          this.refreshQueued = false;
          if (this.isOpen()) this.refresh();
        });
      }
    });
  }

  updatePlaceholder() {
    this.inputEl.placeholder = this.includeContent ? '搜索节点标题、组名或正文' : '搜索节点标题或组名';
  }

  isOpen() {
    return this.panelEl?.classList.contains('is-open') || false;
  }

  open(scope = 'current') {
    if (!this.isOpen()) this.previousFocus = document.activeElement;
    this.scope = scope;
    this.panelEl.classList.add('is-open');
    this.panelEl.setAttribute('aria-hidden', 'false');
    this.scopeEl.textContent = scope === 'all' ? '全部画布' : '当前画布';
    this.inputEl.focus();
    this.inputEl.select();
    this.refresh();
  }

  close({ restoreFocus = true } = {}) {
    this.searchSequence += 1;
    this.remoteSnapshot = null;
    if (this.panelEl.contains(document.activeElement)) {
      document.activeElement.blur();
      if (restoreFocus && this.previousFocus?.isConnected) {
        this.previousFocus.focus({ preventScroll: true });
      }
    }
    this.previousFocus = null;
    this.panelEl.classList.remove('is-open');
    this.panelEl.setAttribute('aria-hidden', 'true');
  }

  handleKeydown(e) {
    if (!this.isOpen() || e.isComposing || e.keyCode === 229) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return true;
    }
    if (e.target !== this.inputEl || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!this.results.length) return false;
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const count = this.results.length;
      const index = this.activeIndex < 0 ? (delta > 0 ? 0 : count - 1) : (this.activeIndex + delta + count) % count;
      this.setActiveResult(index);
      return true;
    }
    if (e.key === 'Enter' && this.results.length) {
      e.preventDefault();
      this.openResult(Math.max(0, this.activeIndex));
      return true;
    }
    return false;
  }

  async refresh() {
    const query = this.inputEl.value.trim();
    const sequence = ++this.searchSequence;
    this.results = [];
    this.resultsEl.replaceChildren();
    this.setActiveResult(-1);
    if (!query) {
      this.statusEl.textContent = '输入关键词开始搜索';
      return;
    }

    const isGlobal = this.scope === 'all';
    let remote = null;
    if (isGlobal) {
      this.statusEl.textContent = '正在搜索…';
      this.remoteSnapshot ??= this.loadRemoteSnapshot();
      remote = await this.remoteSnapshot;
      if (sequence !== this.searchSequence) return;
      if (!remote) this.remoteSnapshot = null;
    }

    const matchText = createSearchMatcher(query);
    const template = this.includeContent ? document.createElement('template') : null;
    const { entries, incomplete } = this.collectCanvases(isGlobal, remote);
    for (const entry of entries) {
      for (const card of entry.cards) {
        const title = card.title || (card.kind === 'subcanvas' ? '未命名子画布' : '未命名节点');
        const content = template ? readContentText(card.contentHtml, template) : '';
        const match = matchText(title, content);
        if (!match) continue;
        const snippet = makeSnippet(content, match.contentRanges);
        this.results.push({
          canvasId: entry.id,
          canvasTitle: entry.title,
          cardId: card.id,
          title,
          titleRanges: match.titleRanges,
          snippet: snippet.text,
          snippetRanges: snippet.ranges,
          score: match.score
        });
      }
      for (const group of entry.groups || []) {
        const title = group.title || '未命名组';
        const match = matchText(title);
        if (!match) continue;
        this.results.push({
          canvasId: entry.id,
          canvasTitle: entry.title,
          groupId: group.id,
          title,
          titleRanges: match.titleRanges,
          snippet: '',
          score: match.score
        });
      }
    }
    this.results.sort((a, b) => a.score - b.score);
    this.renderResults(incomplete);
  }

  async loadRemoteSnapshot() {
    try {
      const response = await fetch('/api/v1/canvases/root/export?includeSubcanvases=true', { cache: 'no-store' });
      if (!response.ok) return null;
      const { data } = await response.json();
      if (!Array.isArray(data?.cards)) return null;
      return new Map([['root', data], ...Object.entries(data.subcanvases || {})]);
    } catch {
      return null;
    }
  }

  collectCanvases(isGlobal, remote) {
    const activeId = store.activeCanvasId;
    const active = {
      id: activeId,
      title: store.activeCanvasTitle,
      cards: store.focusSession
        ? [...store.state.cards, ...store.focusSession.outsideCards]
        : store.state.cards,
      groups: store.focusSession
        ? [...store.state.groups, ...store.focusSession.outsideGroups, ...store.focusSession.partialGroups]
        : store.state.groups || []
    };
    if (!isGlobal) return { entries: [active], incomplete: false };

    const entries = [active];
    const visited = new Set();
    const fallbackChildren = new Map();
    for (const row of store.canvasTree) {
      if (!fallbackChildren.has(row.parentCanvasId)) fallbackChildren.set(row.parentCanvasId, []);
      fallbackChildren.get(row.parentCanvasId).push({ id: row.id, title: row.title });
    }
    let incomplete = false;
    const visit = (id, title) => {
      if (visited.has(id) || store.pendingDeletedCanvasIds.has(id)) return;
      visited.add(id);
      const cached = store.canvasesCache.get(id);
      const local = cached && (cached.dirty || store.dirtyCanvasIds.has(id));
      const data = id === activeId ? active : (local ? cached : remote?.get(id) || cached);
      if (data) {
        if (id !== activeId) entries.push({
          id,
          title: title || data.title,
          cards: data.cards,
          groups: data.groups || []
        });
        for (const card of data.cards) {
          if (card.kind === 'subcanvas' && card.subcanvasId) visit(card.subcanvasId, card.title);
        }
      } else {
        incomplete = true;
        for (const child of fallbackChildren.get(id) || []) visit(child.id, child.title);
      }
    };
    visit('root');
    visit(activeId);
    return { entries, incomplete };
  }

  setActiveResult(index) {
    this.resultsEl.children[this.activeIndex]?.classList.remove('is-active');
    this.activeIndex = index;
    const item = this.resultsEl.children[index];
    if (item) {
      this.inputEl.setAttribute('aria-activedescendant', item.id);
      item.classList.add('is-active');
      item.scrollIntoView({ block: 'nearest' });
    } else {
      this.inputEl.removeAttribute('aria-activedescendant');
    }
  }

  renderResults(incomplete) {
    const results = document.createDocumentFragment();
    for (const [index, result] of this.results.entries()) {
      const item = document.createElement('button');
      item.type = 'button';
      item.id = `search-result-${index}`;
      item.className = 'search-result';
      item.dataset.searchResultIndex = String(index);

      const title = document.createElement('span');
      title.className = 'search-result-title';
      title.title = result.title;
      appendHighlightedText(title, result.title, result.titleRanges);
      item.append(title);

      const meta = document.createElement('span');
      meta.className = 'search-result-meta';
      meta.textContent = result.canvasTitle || '未命名画布';
      meta.title = meta.textContent;
      item.append(meta);

      if (result.snippet) {
        const content = document.createElement('span');
        content.className = 'search-result-content';
        appendHighlightedText(content, result.snippet, result.snippetRanges);
        item.append(content);
      }
      results.append(item);
    }
    this.resultsEl.replaceChildren(results);
    this.statusEl.textContent = incomplete
      ? '部分画布未加载，搜索结果可能不完整'
      : (this.results.length ? '' : '没有找到匹配节点或组');
  }

  async openResult(index) {
    const result = this.results[index];
    if (!result || this.openingResult) return;
    const sequence = this.searchSequence;
    this.openingResult = true;
    try {
      if (result.canvasId !== store.activeCanvasId && !await store.navigateToCanvas(result.canvasId)) return;
      if (sequence !== this.searchSequence || result.canvasId !== store.activeCanvasId) {
        if (this.isOpen()) this.refresh();
        return;
      }
      if (result.groupId) {
        const group = store.state.groups?.find(item => item.id === result.groupId);
        if (!group) {
          store.emitToast(store.isFocusMode ? '请先退出专注模式，再定位此组' : '该组已不存在', 'warning');
          if (!store.isFocusMode) {
            this.remoteSnapshot = null;
            this.refresh();
          }
          return;
        }

        const nodes = window.__nodes;
        const bounds = nodes?.calcGroupBounds(group);
        if (!bounds) return;
        if (nodes) {
          nodes.selectedCardIds.clear();
          nodes.selectedGroupIds = new Set([group.id]);
          nodes.updateSelectionVisuals();
          nodes.updateAlignmentBar();
        }
        const zoom = store.state.viewport.zoom || 1;
        canvas.animateToViewport({
          x: canvas.viewportEl.clientWidth / 2 - (bounds.x + bounds.width / 2) * zoom,
          y: canvas.viewportEl.clientHeight / 2 - (bounds.y + bounds.height / 2) * zoom,
          zoom
        });
        this.close({ restoreFocus: false });
        return;
      }

      const card = store.state.cards.find(item => item.id === result.cardId);
      if (!card) {
        store.emitToast(store.isFocusMode ? '请先退出专注模式，再定位此节点' : '该节点已不存在', 'warning');
        if (!store.isFocusMode) {
          this.remoteSnapshot = null;
          this.refresh();
        }
        return;
      }

      window.__nodes?.selectCard(card.id, false);
      const el = document.getElementById(`card-dom-${card.id}`);
      const width = el?.offsetWidth || card.width || 310;
      const height = el?.offsetHeight || card.height || 140;
      const zoom = store.state.viewport.zoom || 1;
      canvas.animateToViewport({
        x: canvas.viewportEl.clientWidth / 2 - (card.x + width / 2) * zoom,
        y: canvas.viewportEl.clientHeight / 2 - (card.y + height / 2) * zoom,
        zoom
      });
      this.close({ restoreFocus: false });
    } finally {
      this.openingResult = false;
    }
  }
}

export const search = new SearchManager();
