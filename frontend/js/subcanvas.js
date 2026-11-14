const GRID_SIZE = 24;
const DEFAULT_CARD_WIDTH = 310;
const DEFAULT_CARD_HEIGHT = 140;
const DEFAULT_SUBCANVAS_HEIGHT = 180;

function drawRoundRect(ctx, x, y, w, h, r = 3) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawTopRoundedRect(ctx, x, y, w, h, r = 3) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, [r, r, 0, 0]);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function computeLocalThumbnail(canvasData) {
  if (!canvasData) {
    return {
      canvasId: '',
      title: '子画布',
      cardCount: 0,
      subcanvasCount: 0,
      groupCount: 0,
      connectionCount: 0,
      bounds: null,
      cards: [],
      groups: [],
      connections: [],
    };
  }

  const rawCards = Array.isArray(canvasData.cards) ? canvasData.cards : [];
  const rawGroups = Array.isArray(canvasData.groups) ? canvasData.groups : [];
  const rawConns = Array.isArray(canvasData.connections) ? canvasData.connections : [];

  const cardMap = new Map();
  const thumbCards = [];
  let cardCount = 0;
  let subcanvasCount = 0;

  for (const c of rawCards) {
    const kind = c.kind === 'subcanvas' ? 'subcanvas' : 'card';
    if (kind === 'subcanvas') subcanvasCount += 1;
    else cardCount += 1;
    const w = Number(c.width) || DEFAULT_CARD_WIDTH;
    const h = Number(c.height) || (kind === 'subcanvas' ? DEFAULT_SUBCANVAS_HEIGHT : DEFAULT_CARD_HEIGHT);
    const entry = {
      id: c.id,
      kind,
      x: Math.round(Number(c.x) || 0),
      y: Math.round(Number(c.y) || 0),
      width: w,
      height: h,
      headerColor: c.headerColor || null,
    };
    cardMap.set(c.id, { ...entry, contentHtml: c.contentHtml || '' });
    thumbCards.push(entry);
  }

  const thumbGroups = [];
  const groupBoundsMap = new Map();
  for (const g of rawGroups) {
    const members = (g.cardIds || []).map(id => cardMap.get(id)).filter(Boolean);
    if (members.length < 2) continue;
    const gx = Math.min(...members.map(m => m.x)) - GRID_SIZE;
    const gy = Math.min(...members.map(m => m.y)) - GRID_SIZE;
    const gx2 = Math.max(...members.map(m => m.x + m.width)) + GRID_SIZE;
    const gy2 = Math.max(...members.map(m => m.y + m.height)) + GRID_SIZE;
    const gb = {
      x: gx,
      y: gy,
      width: Math.max(288, gx2 - gx),
      height: gy2 - gy,
      headerColor: g.headerColor || null,
    };
    groupBoundsMap.set(g.id, gb);
    thumbGroups.push(gb);
  }

  const resolvePin = (pinId) => {
    if (!pinId) return null;
    for (const prefix of ['pin-group-left-', 'pin-group-right-', 'pin-group-']) {
      if (pinId.startsWith(prefix)) {
        const gid = pinId.slice(prefix.length);
        const gb = groupBoundsMap.get(gid);
        if (!gb) return null;
        return {
          x: gb.x + (prefix.includes('right') ? gb.width : 0),
          y: gb.y + gb.height / 2,
        };
      }
    }
    for (const prefix of ['pin-head-left-', 'pin-head-right-', 'pin-head-']) {
      if (pinId.startsWith(prefix)) {
        const cid = pinId.slice(prefix.length);
        const cm = cardMap.get(cid);
        if (!cm) return null;
        return {
          x: cm.x + (prefix.includes('right') ? cm.width : 0),
          y: cm.y + 20,
        };
      }
    }
    for (const cm of cardMap.values()) {
      if (cm.contentHtml && cm.contentHtml.includes(pinId)) {
        return { x: cm.x + cm.width * 0.5, y: cm.y + cm.height * 0.6 };
      }
    }
    return null;
  };

  const thumbConns = [];
  for (const conn of rawConns) {
    const p1 = resolvePin(conn.fromPinId);
    const p2 = resolvePin(conn.toPinId);
    if (p1 && p2) {
      thumbConns.push({
        x1: Math.round(p1.x * 10) / 10,
        y1: Math.round(p1.y * 10) / 10,
        x2: Math.round(p2.x * 10) / 10,
        y2: Math.round(p2.y * 10) / 10,
        color: conn.color || '#98989d',
      });
    }
  }

  let bounds = null;
  if (thumbCards.length > 0 || thumbGroups.length > 0) {
    const xs = [...thumbCards.map(c => c.x), ...thumbGroups.map(g => g.x)];
    const ys = [...thumbCards.map(c => c.y), ...thumbGroups.map(g => g.y)];
    const x2s = [...thumbCards.map(c => c.x + c.width), ...thumbGroups.map(g => g.x + g.width)];
    const y2s = [...thumbCards.map(c => c.y + c.height), ...thumbGroups.map(g => g.y + g.height)];
    bounds = {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...x2s),
      maxY: Math.max(...y2s),
    };
  }

  return {
    canvasId: canvasData.id || '',
    title: canvasData.title || '子画布',
    cardCount,
    subcanvasCount,
    groupCount: thumbGroups.length,
    connectionCount: rawConns.length,
    bounds,
    cards: thumbCards,
    groups: thumbGroups,
    connections: thumbConns,
  };
}

export function renderThumbnailCanvas(canvasEl, thumbnail, palette = ['#30d158']) {
  if (!canvasEl) return;
  // Use board-space layout dimensions (clientWidth/clientHeight) rather than
  // getBoundingClientRect(), which is scaled by #board's CSS zoom transform.
  const W = Math.max(120, Math.round(canvasEl.clientWidth || canvasEl.offsetWidth || 300));
  const H = Math.max(80, Math.round(canvasEl.clientHeight || canvasEl.offsetHeight || 180));
  const dpr = window.devicePixelRatio || 1;

  if (canvasEl.width !== Math.round(W * dpr) || canvasEl.height !== Math.round(H * dpr)) {
    canvasEl.width = Math.round(W * dpr);
    canvasEl.height = Math.round(H * dpr);
  }

  const ctx = canvasEl.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // Subtle background grid dots (echoing infinite canvas)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  const step = 16;
  for (let gx = 10; gx < W; gx += step) {
    for (let gy = 10; gy < H; gy += step) {
      ctx.fillRect(gx, gy, 1, 1);
    }
  }

  const cards = thumbnail?.cards || [];
  const groups = thumbnail?.groups || [];
  const connections = thumbnail?.connections || [];

  if (cards.length === 0 && groups.length === 0) {
    return;
  }

  const b = thumbnail.bounds || { minX: 0, minY: 0, maxX: 600, maxY: 400 };
  const pad = Math.max((b.maxX - b.minX) * 0.08, (b.maxY - b.minY) * 0.08, 60);
  const minX = b.minX - pad;
  const minY = b.minY - pad;
  const maxX = b.maxX + pad;
  const maxY = b.maxY + pad;

  const worldW = Math.max(maxX - minX, 200);
  const worldH = Math.max(maxY - minY, 140);
  const innerPad = 10;
  const scale = Math.min((W - innerPad * 2) / worldW, (H - innerPad * 2 - 14) / worldH);
  const offsetX = (W - worldW * scale) / 2;
  const offsetY = (H - 12 - worldH * scale) / 2;

  // 1. Groups
  if (groups.length > 0) {
    ctx.save();
    for (const g of groups) {
      const gx = offsetX + (g.x - minX) * scale;
      const gy = offsetY + (g.y - minY) * scale;
      const gw = Math.max(g.width * scale, 10);
      const gh = Math.max(g.height * scale, 8);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
      ctx.strokeStyle = g.headerColor ? g.headerColor : 'rgba(255, 255, 255, 0.22)';
      ctx.globalAlpha = g.headerColor ? 0.45 : 1;
      ctx.lineWidth = 1;
      ctx.setLineDash([2.5, 2.5]);
      drawRoundRect(ctx, gx, gy, gw, gh, 3);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // 2. Connections
  if (connections.length > 0) {
    ctx.save();
    ctx.lineWidth = 1.1;
    for (const conn of connections) {
      const m1x = offsetX + (conn.x1 - minX) * scale;
      const m1y = offsetY + (conn.y1 - minY) * scale;
      const m2x = offsetX + (conn.x2 - minX) * scale;
      const m2y = offsetY + (conn.y2 - minY) * scale;
      ctx.strokeStyle = conn.color || '#30d158';
      ctx.beginPath();
      ctx.moveTo(m1x, m1y);
      const dx = (m2x - m1x) * 0.5;
      ctx.bezierCurveTo(m1x + dx, m1y, m2x - dx, m2y, m2x, m2y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 3. Cards & Nested Subcanvases
  ctx.save();
  const neutralHeaderColor = 'rgba(152, 152, 157, 0.55)';
  for (const card of cards) {
    const cx = offsetX + (card.x - minX) * scale;
    const cy = offsetY + (card.y - minY) * scale;
    const mw = Math.max((card.width || 310) * scale, 7);
    const mh = Math.max((card.height || 140) * scale, 5);
    const radius = Math.min(2.5, mw / 2);

    if (card.kind === 'subcanvas') {
      ctx.fillStyle = card.headerColor ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.05)';
      drawRoundRect(ctx, cx, cy, mw, mh, radius);
      ctx.fill();

      ctx.strokeStyle = card.headerColor || 'rgba(180, 180, 190, 0.55)';
      ctx.lineWidth = 1;
      drawRoundRect(ctx, cx, cy, mw, mh, radius);
      ctx.stroke();

      // Tiny inner subcanvas frame hint
      if (mw >= 12 && mh >= 10) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.lineWidth = 0.75;
        ctx.strokeRect(cx + 2.5, cy + 2.5, Math.max(4, mw - 5), Math.max(3, mh - 5));
      }
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      drawRoundRect(ctx, cx, cy, mw, mh, radius);
      ctx.fill();

      const headerH = Math.max(mh * 0.28, 2.5);
      ctx.fillStyle = card.headerColor || neutralHeaderColor;
      drawTopRoundedRect(ctx, cx, cy, mw, headerH, radius);
      ctx.fill();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 0.75;
      drawRoundRect(ctx, cx, cy, mw, mh, radius);
      ctx.stroke();
    }
  }
  ctx.restore();
}
