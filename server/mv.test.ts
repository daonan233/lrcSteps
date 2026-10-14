import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultMvStyle, estimateAudioOffset, generateAss, pcmEnergy } from './mv.js'
import type { LyricLine } from './types.js'

test('ASS export keeps Japanese and romaji karaoke timing and placement', () => {
  const lines: LyricLine[] = [{
    id: 'line', start: 1, end: 2, text: 'あい', romaji: 'ai', confidence: 1, method: 'manual',
    units: [{ text: 'あ', start: 1, end: 1.5 }, { text: 'い', start: 1.5, end: 2 }],
    romajiUnits: [{ text: 'a', start: 1, end: 1.5 }, { text: 'i', start: 1.5, end: 2 }],
  }]
  const ass = generateAss(lines, 500, defaultMvStyle, 1920, 1080)
  assert.match(ass, /PlayResX: 1920/)
  assert.match(ass, /Dialogue: 0,0:00:01\.50,0:00:02\.50,Japanese/)
  assert.match(ass, /\{\\kf50\}あ\{\\kf50\}い/)
  assert.match(ass, /Dialogue: 0,0:00:01\.50,0:00:02\.50,Romaji/)
  assert.match(ass, /\{\\kf50\}a\{\\kf50\}i/)
  const noRoman = generateAss(lines, 0, { ...defaultMvStyle, showRomaji: false }, 1920, 1080)
  assert.doesNotMatch(noRoman, /,Romaji,,/)
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
