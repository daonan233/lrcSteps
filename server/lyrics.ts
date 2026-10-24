import type { LyricLine, TimedUnit } from './types.js'

export interface RawLine { start: number; text: string }

export function parseLrc(source: string): RawLine[] {
  const offset = Number(source.match(/\[offset:([+-]?\d+)\]/i)?.[1] ?? 0) / 1000
  const lines: RawLine[] = []
  for (const row of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const timestamps = [...row.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    if (!timestamps.length) continue
    const text = row.replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim()
    if (!text) continue
    for (const time of timestamps) {
      const fraction = time[3] ? Number(time[3]) / 10 ** time[3].length : 0
      const start = Math.max(0, Number(time[1]) * 60 + Number(time[2]) + fraction + offset)
      lines.push({ start: round(start), text })
    }
  }
  return lines.sort((a, b) => a.start - b.start)
}

export function splitUnits(text: string, start: number, end: number): TimedUnit[] {
  const parts = [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)].map(x => x.segment)
  if (!parts.length) return []
  const duration = Math.max(0.05, end - start)
  return parts.map((part, index) => ({
    text: part,
    start: round(start + duration * index / parts.length),
    end: round(start + duration * (index + 1) / parts.length),
  }))
}

function isEnglishOnly(text: string): boolean {
  const letters = text.normalize('NFKD').match(/\p{L}/gu) ?? []
  return letters.length > 0 && letters.every(letter => /[a-z]/i.test(letter))
}

export function createLines(japanese: RawLine[], romanized: RawLine[], duration?: number): LyricLine[] {
  return japanese.map((line, index) => {
    const next = japanese[index + 1]
    const audioEnd = duration && duration > line.start ? duration : Number.POSITIVE_INFINITY
    const end = Math.max(line.start + 0.05, Math.min(audioEnd, next ? Math.min(next.start, line.start + 15) : line.start + 8))
    // English lyrics already provide the Latin reading. A nearby romaji LRC
    // entry may belong to the following Japanese line when the file omits it.
    const romajiLine = isEnglishOnly(line.text) ? undefined
      : romanized.find(x => Math.abs(x.start - line.start) < 0.75)
        ?? (romanized.length === japanese.length ? romanized[index] : undefined)
    return {
      id: `line-${index}`,
      start: line.start,
      end: round(end),
      text: line.text,
      romaji: romajiLine?.text,
      units: splitUnits(line.text, line.start, end),
      romajiUnits: romajiLine ? splitUnits(romajiLine.text, line.start, end) : undefined,
      confidence: null,
      method: 'estimated',
    }
  })
}

export function decodeLyrics(buffer: Buffer): string {
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  try { return utf8.decode(buffer) } catch { return new TextDecoder('shift_jis').decode(buffer) }
}

export function round(value: number): number { return Math.round(value * 1000) / 1000 }
