import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultMvStyle, estimateAudioOffset, generateAss, pcmEnergy, validMvStyle } from './mv.js'
import type { LyricLine } from './types.js'

test('ASS export keeps Japanese and romaji karaoke timing and placement', () => {
  const lines: LyricLine[] = [{
    id: 'line', start: 1, end: 2, text: 'あい', romaji: 'ai', confidence: 1, method: 'manual',
    units: [{ text: 'あ', start: 1, end: 1.5 }, { text: 'い', start: 1.5, end: 2 }],
    romajiUnits: [{ text: 'a', start: 1, end: 1.5 }, { text: 'i', start: 1.5, end: 2 }],
  }]
  const ass = generateAss(lines, 500, defaultMvStyle, 1920, 1080)
  assert.match(ass, /PlayResX: 1920/)
  assert.match(ass, /Style: Japanese,Noto Sans JP ExtraBold,/)
  assert.match(ass, /Style: Romaji,DM Sans 14pt,/)
  assert.match(ass, /Dialogue: 0,0:00:01\.50,0:00:02\.50,Japanese/)
  assert.match(ass, /,Japanese,,[^\n]*\\b800\}/)
  assert.match(ass, /\{\\kf50\}あ\{\\kf50\}い/)
  assert.match(ass, /Dialogue: 0,0:00:01\.50,0:00:02\.50,Romaji/)
  assert.match(ass, /,Romaji,,[^\n]*\\b700\}/)
  assert.match(ass, /\{\\kf50\}a\{\\kf50\}i/)
  const noRoman = generateAss(lines, 0, { ...defaultMvStyle, showRomaji: false }, 1920, 1080)
  assert.doesNotMatch(noRoman, /,Romaji,,/)
})

test('double row ASS preloads the next lyric and alternates rows while both scripts sweep', () => {
  const lines: LyricLine[] = [10, 12, 14].map((start, index) => ({
    id: String(index), start, end: start + 1, text: `歌${index}`, romaji: `uta${index}`,
    confidence: 1, method: 'manual',
    units: [{ text: `歌${index}`, start, end: start + 1 }],
    romajiUnits: [{ text: `uta${index}`, start, end: start + 1 }],
  }))
  const ass = generateAss(lines, 0, defaultMvStyle, 1920, 1080, 0, undefined, 'double')
  const japanese = ass.split('\n').filter(line => line.includes(',Japanese,,'))
  const roman = ass.split('\n').filter(line => line.includes(',Romaji,,'))
  assert.equal(japanese.length, 3)
  assert.equal(roman.length, 3)
  assert.match(japanese[0], /^Dialogue: 0,0:00:06\.50,0:00:12\.00,Japanese/)
  assert.match(japanese[1], /^Dialogue: 0,0:00:08\.00,0:00:17\.00,Japanese/)
  assert.match(japanese[2], /^Dialogue: 0,0:00:12\.00,0:00:17\.00,Japanese/)
  const y = japanese.map(line => Number(/\\pos\(\d+,(\d+)\)/.exec(line)?.[1]))
  assert.ok(y[0] < y[1])
  assert.equal(y[0], y[2])
  assert.match(japanese[0], /\{\\an4\\pos\(134,745\)/)
  assert.match(japanese[1], /\{\\an6\\pos\(1786,886\)/)
  assert.match(roman[0], /\{\\an4\\pos\(134,/)
  assert.match(roman[1], /\{\\an6\\pos\(1786,/)
  assert.match(roman[1], /\{\\kf100\}uta1/)
  assert.equal(ass.split('\n').filter(line => line.includes(',Countdown,,')).length, 4)
  const clipped = generateAss(lines, 0, defaultMvStyle, 1920, 1080, 13, 2, 'double')
  assert.doesNotMatch(clipped, /歌0/)
  assert.match(clipped, /Dialogue: 0,0:00:00\.00,0:00:02\.00,Japanese/)
  assert.match(clipped, /歌1/)
  assert.match(clipped, /歌2/)
  const adjusted = { ...defaultMvStyle, leftX: 0.12, leftY: 0.55, leftScale: 0.8, rightX: 0.87, rightY: 0.86, rightScale: 1.3 }
  assert.equal(validMvStyle(adjusted), true)
  const adjustedAss = generateAss(lines, 0, adjusted, 1920, 1080, 0, undefined, 'double')
  const adjustedJapanese = adjustedAss.split('\n').filter(line => line.includes(',Japanese,,'))
  assert.match(adjustedJapanese[0], /\{\\an4\\pos\(230,594\)\\fs40\\b800\}/)
  assert.match(adjustedJapanese[1], /\{\\an6\\pos\(1670,929\)\\fs65\\b800\}/)
  assert.equal(validMvStyle({ ...adjusted, rightX: 0.2 }), false)
})

test('double row preloads after an instrumental break and removes gray dots from right to left', () => {
  const lines: LyricLine[] = [10, 12, 30].map((start, index) => ({
    id: String(index), start, end: start + 1, text: `歌${index}`, romaji: `uta${index}`,
    confidence: 1, method: 'manual',
    units: [{ text: `歌${index}`, start, end: start + 1 }],
    romajiUnits: [{ text: `uta${index}`, start, end: start + 1 }],
  }))
  const ass = generateAss(lines, 500, defaultMvStyle, 1920, 1080, 0, undefined, 'double')
  const japanese = ass.split('\n').filter(line => line.includes(',Japanese,,'))
  const dots = ass.split('\n').filter(line => line.includes(',Countdown,,'))
  assert.match(japanese[0], /^Dialogue: 0,0:00:07\.00,0:00:14\.70,Japanese/)
  assert.match(japanese[1], /^Dialogue: 0,0:00:08\.50,0:00:14\.70,Japanese/)
  assert.match(japanese[2], /^Dialogue: 0,0:00:27\.00,0:00:33\.50,Japanese/)
  assert.equal(dots.length, 8)
  assert.match(dots[4], /^Dialogue: 1,0:00:27\.00,0:00:27\.50,Countdown/)
  assert.match(dots[5], /^Dialogue: 1,0:00:27\.50,0:00:28\.50,Countdown/)
  assert.match(dots[7], /^Dialogue: 1,0:00:29\.50,0:00:30\.50,Countdown/)
  assert.match(dots[4], /\{\\alpha&H00&\}●\\h\{\\alpha&H00&\}●\\h\{\\alpha&H00&\}●/)
  assert.match(dots[6], /\{\\alpha&H00&\}●\\h\{\\alpha&H00&\}●\\h\{\\alpha&HFF&\}●/)
  assert.match(dots[7], /\{\\alpha&H00&\}●\\h\{\\alpha&HFF&\}●\\h\{\\alpha&HFF&\}●/)
  const clipped = generateAss(lines, 500, defaultMvStyle, 1920, 1080, 28, 2, 'double')
  assert.match(clipped, /Dialogue: 1,0:00:00\.00,0:00:00\.50,Countdown/)
  assert.doesNotMatch(generateAss(lines, 500, defaultMvStyle, 1920, 1080), /,Countdown,,/)
})

test('countdown appears at the opening and only after gaps of at least eight seconds', () => {
  const lines: LyricLine[] = [4, 6, 15].map((start, index) => ({
    id: String(index), start, end: start + 1, text: '歌' + index,
    confidence: 1, method: 'manual',
    units: [{ text: '歌' + index, start, end: start + 1 }],
  }))
  const count = (source: LyricLine[], offsetMs: number) =>
    generateAss(source, offsetMs, defaultMvStyle, 1920, 1080, 0, undefined, 'double')
      .split('\n').filter(line => line.includes(',Countdown,,')).length
  assert.equal(count(lines.slice(0, 2), 0), 4)
  assert.equal(count(lines, 0), 8)
  assert.equal(count([lines[0], lines[1], { ...lines[2], start: 14.99, end: 15.99, units: [{ text: '歌2', start: 14.99, end: 15.99 }] }], 0), 4)
})

test('audio envelope correlation finds MV intro delay', () => {
  const song = Array.from({ length: 800 }, (_, i) => Math.sin(i * 0.17) + Math.sin(i * i * 0.0007))
  const video = [...Array(75).fill(0), ...song]
  const result = estimateAudioOffset(song, video, 10, 20)
  assert.equal(result.offsetSeconds, 7.5)
  assert.ok(result.confidence > 0.99)
  const pcm = Buffer.alloc(1600)
  pcm.writeInt16LE(16000, 0)
  assert.equal(pcmEnergy(pcm).length, 1)
})
