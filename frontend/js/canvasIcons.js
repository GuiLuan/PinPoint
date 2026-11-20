// Shared by the canvas tree and its picker. Only these local paths are rendered as SVG.
export const CANVAS_ICONS = new Map([
  ['folder', { label: '文件夹', path: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' }],
  ['file-text', { label: '文档', path: 'M6 3h8l4 4v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2Z M14 3v5h4 M9 12h6 M9 16h6' }],
  ['book-open', { label: '书本', path: 'M12 6v15 M3 4h4a5 5 0 0 1 5 3 5 5 0 0 1 5-3h4v14h-4a6 6 0 0 0-5 3 6 6 0 0 0-5-3H3Z' }],
  ['clipboard', { label: '清单', path: 'M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3 M9 3h6v4H9Z M8 14l2 2 5-5' }],
  ['layers', { label: '图层', path: 'm12 3 9 5-9 5-9-5Z M3 12l9 5 9-5 M3 16l9 5 9-5' }],
  ['grid', { label: '网格', path: 'M4 4h6v6H4Z M14 4h6v6h-6Z M4 14h6v6H4Z M14 14h6v6h-6Z' }],
  ['star', { label: '星标', path: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z' }],
  ['flag', { label: '旗帜', path: 'M5 21V4 M5 5c4-4 10 4 14 0v10c-4 4-10-4-14 0' }],
  ['bookmark', { label: '书签', path: 'M6 5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16l-6-4-6 4Z' }],
  ['lightbulb', { label: '灵感', path: 'M9 18h6 M10 21h4 M9 15v-1a6 6 0 1 1 6 0v1Z' }],
  ['target', { label: '目标', path: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z M12 12h.01' }],
  ['calendar', { label: '日历', path: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z M7 3v4 M17 3v4 M3 10h18 M8 15h2 M14 15h2' }],
  ['briefcase', { label: '工作', path: 'M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z M8 7V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2 M3 12l9 3 9-3 M12 13v3' }],
  ['code', { label: '代码', path: 'm8 6-6 6 6 6 M16 6l6 6-6 6 M14 4l-4 16' }],
  ['image', { label: '图像', path: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z M3 16l5-5 4 4 3-3 6 6 M16 8h.01' }],
  ['music', { label: '音乐', path: 'M8 18V5l12-2v13 M8 9l12-2 M8 18c0 3-6 4-6 1s6-4 6-1Z M20 16c0 3-6 4-6 1s6-4 6-1Z' }],
  ['globe', { label: '网页', path: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M3 12h18 M12 3c5 4 5 14 0 18-5-4-5-14 0-18Z' }],
  ['compass', { label: '探索', path: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z m-5-4-2 6-6 2 2-6Z' }],
]);

export function defaultCanvasIcon(row) {
  return !row.parentCanvasId || (row.subcanvasCount ?? 0) > 0 ? 'folder' : 'file-text';
}

export function renderCanvasIcon(key) {
  const icon = CANVAS_ICONS.get(key);
  if (!icon) return '';
  return `<svg class="canvas-tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icon.path}"></path></svg>`;
}
