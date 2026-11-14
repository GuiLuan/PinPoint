/**
 * Spatial relative layout recalculation for Focus Mode exit.
 *
 * Treats the pre-focus selected nodes as a conceptual group (beforeBox) and
 * the post-focus edited nodes as the evolved conceptual group (afterBox),
 * then recalculates target positions for all hidden outside nodes & groups
 * while preserving relative clearances and preventing new overlaps.
 */

export function computeRectsBoundingBox(rects) {
  if (!rects || rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    if (r.left < left) left = r.left;
    if (r.top < top) top = r.top;
    if (r.right > right) right = r.right;
    if (r.bottom > bottom) bottom = r.bottom;
  }
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return {
    left,
    top,
    right,
    bottom,
    width,
    height,
    cx: left + width / 2,
    cy: top + height / 2
  };
}

function makeRect(x, y, width, height) {
  return {
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    cx: x + width / 2,
    cy: y + height / 2
  };
}

function rectsOverlap(a, b, margin = 0) {
  return !(
    a.right + margin <= b.left ||
    a.left >= b.right + margin ||
    a.bottom + margin <= b.top ||
    a.top >= b.bottom + margin
  );
}

function moveUnitTo(unit, newLeft, newTop) {
  unit.R1 = makeRect(newLeft, newTop, unit.R0.width, unit.R0.height);
}

function shiftUnitBy(unit, dx, dy) {
  moveUnitTo(unit, unit.R1.left + dx, unit.R1.top + dy);
}

/**
 * Push a unit out of any overlapping focus cards using minimum displacement.
 */
function resolveFocusCardCollisions(unit, focusCardRects, afterBox, margin = 24) {
  if (!focusCardRects || focusCardRects.length === 0) return;

  const overlapsAny = (rect) => focusCardRects.some(fc => rectsOverlap(rect, fc, margin));
  if (!overlapsAny(unit.R1)) return;

  const overlapping = focusCardRects.filter(fc => rectsOverlap(unit.R1, fc, margin));
  const unionBox = computeRectsBoundingBox(overlapping) || afterBox;

  const candidates = [
    { x: unionBox.left - margin - unit.R1.width, y: unit.R1.top },
    { x: unionBox.right + margin, y: unit.R1.top },
    { x: unit.R1.left, y: unionBox.top - margin - unit.R1.height },
    { x: unit.R1.left, y: unionBox.bottom + margin }
  ];

  let best = null;
  let bestDist = Infinity;

  for (const cand of candidates) {
    const testRect = makeRect(cand.x, cand.y, unit.R1.width, unit.R1.height);
    if (!overlapsAny(testRect)) {
      const dist = Math.hypot(cand.x - unit.R1.left, cand.y - unit.R1.top);
      if (dist < bestDist) {
        bestDist = dist;
        best = cand;
      }
    }
  }

  if (!best && afterBox) {
    const fallbackCandidates = [
      { x: afterBox.left - margin - unit.R1.width, y: unit.R1.top },
      { x: afterBox.right + margin, y: unit.R1.top },
      { x: unit.R1.left, y: afterBox.top - margin - unit.R1.height },
      { x: unit.R1.left, y: afterBox.bottom + margin }
    ];
    for (const cand of fallbackCandidates) {
      const testRect = makeRect(cand.x, cand.y, unit.R1.width, unit.R1.height);
      if (!overlapsAny(testRect)) {
        const dist = Math.hypot(cand.x - unit.R1.left, cand.y - unit.R1.top);
        if (dist < bestDist) {
          bestDist = dist;
          best = cand;
        }
      }
    }
  }

  if (best) {
    moveUnitTo(unit, best.x, best.y);
  }
}

/**
 * Compute target coordinates for all outside cards upon confirming Focus Mode.
 *
 * @param {Object} params
 * @param {Object|null} params.beforeBox - Bounding box of pre-focus selected cards
 * @param {Object|null} params.afterBox - Bounding box of post-focus cards
 * @param {Array} params.preFocusCardRects - Rects of original focus cards (for pre-existing overlap check)
 * @param {Array} params.focusCardRects - Rects of post-focus cards at exit
 * @param {Array} params.outsideCards - [{ id, x, y, width, height }]
 * @param {Array} params.outsideGroups - [{ id, cardIds }]
 * @returns {{ cardTargets: Map<string, { x: number, y: number, origX: number, origY: number, dx: number, dy: number }> }}
 */
export function computeFocusExitLayout({
  beforeBox,
  afterBox,
  preFocusCardRects = [],
  focusCardRects = [],
  outsideCards = [],
  outsideGroups = []
}) {
  const cardTargets = new Map();

  if (!outsideCards || outsideCards.length === 0) {
    return { cardTargets };
  }

  // If no conceptual boxes or all focus cards were deleted, keep outside cards in place
  if (!beforeBox || !afterBox || focusCardRects.length === 0) {
    for (const c of outsideCards) {
      cardTargets.set(c.id, {
        x: Math.round(c.x),
        y: Math.round(c.y),
        origX: c.x,
        origY: c.y,
        dx: 0,
        dy: 0
      });
    }
    return { cardTargets };
  }

  const cardById = new Map(outsideCards.map(c => [c.id, c]));
  const assignedCardIds = new Set();
  const units = [];

  // 1. Group wholly-outside groups into rigid units so internal spacing is preserved
  for (const group of outsideGroups) {
    if (!group || !Array.isArray(group.cardIds) || group.cardIds.length === 0) continue;
    const members = group.cardIds
      .map(id => cardById.get(id))
      .filter(c => c && !assignedCardIds.has(c.id));
    if (members.length === 0) continue;

    const memberRects = members.map(c => makeRect(c.x, c.y, c.width, c.height));
    const R0 = computeRectsBoundingBox(memberRects);
    members.forEach(c => assignedCardIds.add(c.id));

    units.push({
      type: 'group',
      groupId: group.id,
      R0,
      R1: { ...R0 },
      members: members.map(c => ({
        card: c,
        relX: c.x - R0.left,
        relY: c.y - R0.top
      }))
    });
  }

  // 2. Remaining outside cards become individual units
  for (const c of outsideCards) {
    if (assignedCardIds.has(c.id)) continue;
    const R0 = makeRect(c.x, c.y, c.width, c.height);
    units.push({
      type: 'card',
      cardId: c.id,
      R0,
      R1: { ...R0 },
      members: [{ card: c, relX: 0, relY: 0 }]
    });
  }

  // 3. Compute edge deltas and common translation for overlapping axes
  const dLeft = afterBox.left - beforeBox.left;
  const dRight = afterBox.right - beforeBox.right;
  const dTop = afterBox.top - beforeBox.top;
  const dBottom = afterBox.bottom - beforeBox.bottom;

  const tx = (dLeft > 0 && dRight > 0)
    ? Math.min(dLeft, dRight)
    : (dLeft < 0 && dRight < 0)
      ? Math.max(dLeft, dRight)
      : 0;

  const ty = (dTop > 0 && dBottom > 0)
    ? Math.min(dTop, dBottom)
    : (dTop < 0 && dBottom < 0)
      ? Math.max(dTop, dBottom)
      : 0;

  const EPS = 1;

  for (const unit of units) {
    const R0 = unit.R0;

    let dx = tx;
    if (R0.right <= beforeBox.left + EPS) {
      dx = dLeft;
    } else if (R0.left >= beforeBox.right - EPS) {
      dx = dRight;
    }

    let dy = ty;
    if (R0.bottom <= beforeBox.top + EPS) {
      dy = dTop;
    } else if (R0.top >= beforeBox.bottom - EPS) {
      dy = dBottom;
    }

    moveUnitTo(unit, R0.left + dx, R0.top + dy);

    // Check if this unit had pre-existing overlap with any original focus card
    const hadPreFocusCardOverlap = unit.members.some(({ card }) => {
      const cr = makeRect(card.x, card.y, card.width, card.height);
      return preFocusCardRects.some(pfc => rectsOverlap(cr, pfc, 0));
    });

    if (!hadPreFocusCardOverlap) {
      resolveFocusCardCollisions(unit, focusCardRects, afterBox, 24);
    }
  }

  // 4. Pairwise non-overlap preservation among outside units
  const MAX_ITERATIONS = 16;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let anyAdjusted = false;

    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        const uA = units[i];
        const uB = units[j];

        // If they already overlapped before Focus Mode, leave their relationship alone
        if (rectsOverlap(uA.R0, uB.R0, 0)) continue;

        const sepX0 = Math.max(uB.R0.left - uA.R0.right, uA.R0.left - uB.R0.right);
        const sepY0 = Math.max(uB.R0.top - uA.R0.bottom, uA.R0.top - uB.R0.bottom);
        const origGap = Math.max(0, sepX0, sepY0);
        const minGap = Math.min(24, origGap);

        if (!rectsOverlap(uA.R1, uB.R1, minGap - 0.5)) continue;

        anyAdjusted = true;

        if (sepX0 >= sepY0) {
          // Separated horizontally originally
          const leftUnit = uA.R0.cx <= uB.R0.cx ? uA : uB;
          const rightUnit = uA.R0.cx <= uB.R0.cx ? uB : uA;
          const reqGap = Math.min(24, Math.max(0, sepX0));
          const push = (leftUnit.R1.right + reqGap) - rightUnit.R1.left;
          if (push > 0) {
            const distLeft = Math.abs(leftUnit.R1.cx - afterBox.cx);
            const distRight = Math.abs(rightUnit.R1.cx - afterBox.cx);
            if (distLeft > distRight) {
              shiftUnitBy(leftUnit, -push, 0);
            } else {
              shiftUnitBy(rightUnit, push, 0);
            }
          }
        } else {
          // Separated vertically originally
          const topUnit = uA.R0.cy <= uB.R0.cy ? uA : uB;
          const bottomUnit = uA.R0.cy <= uB.R0.cy ? uB : uA;
          const reqGap = Math.min(24, Math.max(0, sepY0));
          const push = (topUnit.R1.bottom + reqGap) - bottomUnit.R1.top;
          if (push > 0) {
            const distTop = Math.abs(topUnit.R1.cy - afterBox.cy);
            const distBottom = Math.abs(bottomUnit.R1.cy - afterBox.cy);
            if (distTop > distBottom) {
              shiftUnitBy(topUnit, 0, -push);
            } else {
              shiftUnitBy(bottomUnit, 0, push);
            }
          }
        }
      }
    }

    if (!anyAdjusted) break;
  }

  // Final safety check against focus cards after pairwise relaxation
  for (const unit of units) {
    const hadPreFocusCardOverlap = unit.members.some(({ card }) => {
      const cr = makeRect(card.x, card.y, card.width, card.height);
      return preFocusCardRects.some(pfc => rectsOverlap(cr, pfc, 0));
    });
    if (!hadPreFocusCardOverlap) {
      resolveFocusCardCollisions(unit, focusCardRects, afterBox, 24);
    }
  }

  // 5. Materialize per-card targets
  for (const unit of units) {
    for (const { card, relX, relY } of unit.members) {
      const targetX = Math.round(unit.R1.left + relX);
      const targetY = Math.round(unit.R1.top + relY);
      cardTargets.set(card.id, {
        x: targetX,
        y: targetY,
        origX: card.x,
        origY: card.y,
        dx: targetX - card.x,
        dy: targetY - card.y
      });
    }
  }

  return { cardTargets };
}
