import assert from 'node:assert/strict';
import { createSearchMatcher } from '../frontend/js/searchMatch.mjs';

function expectMatch(query, title, expectedHighlights, content = '') {
  const match = createSearchMatcher(query)(title, content);
  assert.ok(match, `${query} should match ${title}`);
  assert.deepEqual(match.titleRanges.map(([start, end]) => title.slice(start, end)), expectedHighlights);
  for (const [start, end] of match.contentRanges) {
    assert.ok(start >= 0 && end <= content.length && end > start);
  }
  return match;
}

expectMatch('画辅组织', '画布辅助与组织', ['画', '辅', '组织']);
expectMatch('canvs', 'canvas', ['canv', 's']);
expectMatch('canvsa', 'canvas', ['canvas']);
expectMatch('canvax', 'canvas', ['canvas']);
expectMatch('sqllite', 'SQLite', ['SQLite']);
expectMatch('zuzhi', '组织', ['组织']);
expectMatch('zz', '组织', ['组织']);
expectMatch('zstp', '知识图谱', ['知识图谱']);
expectMatch('chongqing', '重庆', ['重庆']);
expectMatch('zhongqing', '重庆', ['重庆']);
expectMatch('lvse', '绿色', ['绿色']);
expectMatch('lüse', '绿色', ['绿色']);
expectMatch('画布 组织', '画布辅助与组织', ['画布', '组织']);
expectMatch('组织 画布', '画布辅助与组织', ['画布', '组织']);
expectMatch('CANVAS', 'canvas', ['canvas']);
expectMatch('café', 'CAFÉ', ['CAFÉ']);
expectMatch('组织', '😀组织', ['组织']);
expectMatch('foo.bar', 'foo.bar', ['foo.bar']);
expectMatch('a[', 'a[b', ['a[']);
expectMatch('画布', '画布与画布', ['画布', '画布']);
expectMatch('组织 组', '组织', ['组织']);
const mixed = expectMatch('画布 zuzhi', '画布', ['画布'], '用于组织知识');
assert.deepEqual(mixed.contentRanges, [[2, 4]]);
assert.ok(expectMatch('sxgl', '标题', [], '实现双向关联').contentRanges.length);
for (const [query, title] of [
  ['', 'canvas'], ['画布 不存在', '画布辅助与组织'], ['xy', 'canvas'],
  ['a.b', 'acb'], ['x', '组织'], ['cv', '组织'], ['qwertyuiop', 'canvas']
]) {
  assert.equal(createSearchMatcher(query)(title), null, `${query} should not match ${title}`);
}
const exact = createSearchMatcher('canvas')('canvas');
const contains = createSearchMatcher('canvas')('my canvas');
const phonetic = createSearchMatcher('zz')('组织');
const skipped = createSearchMatcher('canvs')('canvas');
const typo = createSearchMatcher('canvax')('canvas');
assert.ok(exact.score < contains.score);
assert.ok(contains.score < phonetic.score);
assert.ok(phonetic.score < skipped.score);
assert.ok(skipped.score < typo.score);
console.log('Fuzzy search matching and highlight regression cases passed');
