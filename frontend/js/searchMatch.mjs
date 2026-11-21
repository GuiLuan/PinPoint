import pinyinReadings from './vendor/pinyin-data.mjs';

function normalize(text) {
  return text.toLowerCase().replace(/ü/g, 'v').normalize('NFKD').replace(/\p{M}/gu, '');
}

function prepareText(text) {
  const positions = [];
  const characters = [];
  let normalized = '';
  let offset = 0;
  for (const character of text) {
    const value = normalize(character);
    const range = [offset, offset + character.length];
    if (!value && /\p{M}/u.test(character) && positions.length) {
      positions[positions.length - 1][1] = range[1];
    }
    characters.push({ value, range, readings: pinyinReadings[character] });
    normalized += value;
    for (let i = 0; i < value.length; i++) positions.push(range);
    offset += character.length;
  }
  return { normalized, positions, characters };
}

export function mergeRanges(ranges) {
  const merged = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function directMatch(text, term) {
  const ranges = [];
  let index = text.normalized.indexOf(term);
  while (index !== -1) {
    ranges.push([text.positions[index][0], text.positions[index + term.length - 1][1]]);
    index = text.normalized.indexOf(term, index + term.length);
  }
  if (!ranges.length) return null;
  return { score: text.normalized === term ? 0 : 5, ranges };
}

function pinyinMatch(text, term, initials) {
  // Track query offsets instead of enumerating combinations of polyphonic readings.
  let states = new Map();
  for (const character of text.characters) {
    states.set(0, character.range[0]);
    const next = new Map();
    const readings = character.readings || [character.value];
    for (const [offset, start] of states) {
      for (const reading of readings) {
        const value = initials && character.readings ? reading[0] : reading;
        if (!value || !term.startsWith(value, offset)) continue;
        const end = offset + value.length;
        if (end === term.length) {
          return { score: initials ? 20 : 15, ranges: [[start, character.range[1]]] };
        }
        next.set(end, start);
      }
    }
    states = next;
  }
  return null;
}

function subsequenceMatch(text, term) {
  if ([...term].length < 2) return null;
  const ranges = [];
  let cursor = 0;
  let first = -1;
  for (const character of term) {
    const index = text.normalized.indexOf(character, cursor);
    if (index === -1) return null;
    if (first === -1) first = index;
    ranges.push([text.positions[index][0], text.positions[index + character.length - 1][1]]);
    cursor = index + character.length;
  }
  const gaps = cursor - first - term.length;
  return { score: 30 + Math.min(9, gaps / term.length), ranges };
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let beforePrevious;
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + Number(left[i - 1] !== right[j - 1])
      );
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        current[j] = Math.min(current[j], beforePrevious[j - 2] + 1);
      }
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[right.length];
}

function typoMatch(text, term) {
  if (!/^[a-z0-9]{3,64}$/.test(term)) return null;
  const maxErrors = term.length >= 7 ? 2 : 1;
  let best = null;
  for (const word of text.normalized.matchAll(/[a-z0-9]+/g)) {
    if (word[0].length < 3 || Math.abs(word[0].length - term.length) > maxErrors) continue;
    const errors = editDistance(term, word[0]);
    if (errors > maxErrors || (best && best.score <= 40 + errors)) continue;
    best = {
      score: 40 + errors,
      ranges: [[text.positions[word.index][0], text.positions[word.index + word[0].length - 1][1]]]
    };
  }
  return best;
}

function matchTerm(text, term) {
  const exact = directMatch(text, term);
  if (exact) return exact;
  if (/^[a-z]+$/.test(term)) {
    const phonetic = pinyinMatch(text, term, false) || pinyinMatch(text, term, true);
    if (phonetic) return phonetic;
  }
  return subsequenceMatch(text, term) || typoMatch(text, term);
}

export function createSearchMatcher(query) {
  const terms = normalize(query).trim().split(/\s+/u).filter(Boolean);
  return (title, content = '') => {
    if (!terms.length) return null;
    const fields = [prepareText(title), prepareText(content)];
    const ranges = [[], []];
    let score = 0;
    for (const term of terms) {
      const titleMatch = matchTerm(fields[0], term);
      const contentMatch = matchTerm(fields[1], term);
      if (!titleMatch && !contentMatch) return null;
      if (titleMatch) ranges[0].push(...titleMatch.ranges);
      if (contentMatch) ranges[1].push(...contentMatch.ranges);
      score += Math.min(titleMatch?.score ?? Infinity, (contentMatch?.score ?? Infinity) + 10);
    }
    return { score, titleRanges: mergeRanges(ranges[0]), contentRanges: mergeRanges(ranges[1]) };
  };
}
