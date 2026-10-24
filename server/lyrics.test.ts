import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLines, parseLrc, splitUnits } from './lyrics.js'

test('LRC timestamps, offset and repeated tags retain every lyric occurrence', () => {
  const lines = parseLrc('[offset:+500]\n[00:01.25][00:11.5]世界が\n[00:04.00]続く')
  assert.deepEqual(lines, [
    { start: 1.75, text: '世界が' },
    { start: 4.5, text: '続く' },
    { start: 12, text: '世界が' },
  ])
})

test('line construction keeps optional romaji and bounded estimates', () => {
  const lines = createLines(parseLrc('[00:01.00]君が好き\n[00:04.00]またね'), parseLrc('[00:01.00]kimi ga suki'), 6)
  assert.equal(lines[0].romaji, 'kimi ga suki')
  assert.equal(lines[1].romaji, undefined)
  assert.equal(lines[0].end, 4)
  assert.equal(lines[1].end, 6)
  assert.equal(lines[0].units.map(unit => unit.text).join(''), '君が好き')
  assert.equal(lines[0].method, 'estimated')
})

test('English-only lyrics use their own text when the romaji LRC omits that line', () => {
  const japanese = parseLrc('[00:10.00]I know, right？\n[00:10.70]いつもふざけていても')
  const romaji = parseLrc('[00:10.65]i tsu mo fu za ke te i te mo')
  const lines = createLines(japanese, romaji, 15)
  assert.equal(lines[0].romaji, undefined)
  assert.equal(lines[0].romajiUnits, undefined)
  assert.equal(lines[1].romaji, 'i tsu mo fu za ke te i te mo')
})

test('grapheme splitter does not split combining marks', () => {
  const units = splitUnits('か\u3099な', 0, 2)
  assert.deepEqual(units.map(unit => unit.text), ['か\u3099', 'な'])
})
