import type { LyricLine, TimedUnit } from './types.js'

export interface MvStyle {
  vertical: number
  scale: number
  leftX: number
  leftY: number
  leftScale: number
  rightX: number
  rightY: number
  rightScale: number
  beforeColor: string
  afterColor: string
  outlineColor: string
  showRomaji: boolean
}

export type MvLayout = 'single' | 'double'

export interface MvOutput {
  previewFile?: string
  fullFile?: string
  previewVersion?: number
  fullVersion?: number
  previewRendererVersion?: number
  fullRendererVersion?: number
}

export interface MvProject {
  id: string
  songId: string
  title: string
  videoFile: string
  originalVideoName: string
  createdAt: string
  duration: number
  width: number
  height: number
  offsetMs: number
  style: MvStyle
  settingsVersion?: number
  previewVersion?: number
  fullVersion?: number
  previewFile?: string
  fullFile?: string
  outputs?: Partial<Record<MvLayout, MvOutput>>
  render?: { kind: 'preview' | 'full'; layout?: MvLayout; status: 'queued' | 'running' | 'failed' | 'complete'; progress: number; error?: string }
}

export const defaultMvStyle: MvStyle = {
  vertical: 0.76,
  scale: 1,
  leftX: 0.07,
  leftY: 0.69,
  leftScale: 1,
  rightX: 0.93,
  rightY: 0.82,
  rightScale: 1,
  beforeColor: '#d8d1e8',
  afterColor: '#ffe69a',
  outlineColor: '#17101f',
  showRomaji: true,
}

export function validMvStyle(value: unknown): value is MvStyle {
  if (!value || typeof value !== 'object') return false
  const style = value as Record<string, unknown>
  return typeof style.vertical === 'number' && style.vertical >= 0.15 && style.vertical <= 0.85
    && typeof style.scale === 'number' && style.scale >= 0.6 && style.scale <= 1.6
    && typeof style.leftX === 'number' && style.leftX >= 0.02 && style.leftX <= 0.48
    && typeof style.rightX === 'number' && style.rightX >= 0.52 && style.rightX <= 0.98
    && ['leftY', 'rightY'].every(key => typeof style[key] === 'number' && (style[key] as number) >= 0.08 && (style[key] as number) <= 0.88)
    && ['leftScale', 'rightScale'].every(key => typeof style[key] === 'number' && (style[key] as number) >= 0.6 && (style[key] as number) <= 1.6)
    && ['beforeColor', 'afterColor', 'outlineColor'].every(key => typeof style[key] === 'string' && /^#[0-9a-fA-F]{6}$/.test(style[key] as string))
    && typeof style.showRomaji === 'boolean'
}

function assColor(hex: string): string {
  return `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase()
}
function assTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100))
  const hours = Math.floor(centiseconds / 360000)
  const minutes = Math.floor(centiseconds / 6000) % 60
  const remaining = Math.floor(centiseconds / 100) % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`
}
function assText(value: string): string {
  return value.replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\r?\n/g, ' ')
}
function karaokeText(units: TimedUnit[], offset: number, visibleStart: number): string {
  let cursor = visibleStart
  let result = ''
  for (const unit of units) {
    const start = Math.max(visibleStart, unit.start + offset)
    const end = Math.max(start + 0.01, unit.end + offset)
    if (end <= visibleStart + 0.01 && unit.end + offset < visibleStart) {
      result += `{\\kf1}${assText(unit.text)}`
      continue
    }
    const gap = Math.round((start - cursor) * 100)
    if (gap > 0) result += `{\\k${gap}}\u200b`
    const duration = Math.max(1, Math.round((end - start) * 100))
    result += `{\\kf${duration}}${assText(unit.text)}`
    cursor = Math.max(cursor, start + duration / 100)
  }
  return result
}

const countdownPreviewSeconds = 4
const preloadSeconds = 3.5
const minBreakSeconds = 8
function lineOnset(line: LyricLine): number { return Math.min(...line.units.map(unit => unit.start)) }
function lineFinish(line: LyricLine): number { return Math.max(line.end, ...line.units.map(unit => unit.end), ...line.romajiUnits?.map(unit => unit.end) ?? []) }
function hasBreakBefore(lines: LyricLine[], index: number): boolean {
  return index === 0 || lineOnset(lines[index]) - lineFinish(lines[index - 1]) >= minBreakSeconds
}
function doubleRowStart(lines: LyricLine[], index: number, offset: number): number {
  const firstStart = Math.max(0, lineOnset(lines[0]) + offset - 2)
  const ordinaryStart = index < 2 ? firstStart : Math.max(0, lineOnset(lines[index - 1]) + offset)
  if (index === 0) return Math.max(0, lineOnset(lines[index]) + offset - preloadSeconds)
  return hasBreakBefore(lines, index)
    ? Math.max(ordinaryStart, lineOnset(lines[index]) + offset - preloadSeconds)
    : ordinaryStart
}
function doubleRowEnd(lines: LyricLine[], index: number, offset: number, finalEnd: number): number {
  let end = index + 2 < lines.length ? doubleRowStart(lines, index + 2, offset) : finalEnd
  for (let next = index + 1; next < lines.length; next++) {
    if (hasBreakBefore(lines, next)) {
      end = Math.min(end, lineFinish(lines[next - 1]) + offset + 1.2)
      break
    }
  }
  return end
}

export function generateAss(lines: LyricLine[], offsetMs: number, style: MvStyle, width: number, height: number, clipStart = 0, clipDuration?: number, layout: MvLayout = 'single'): string {
  const offset = offsetMs / 1000
  const isDouble = layout === 'double'
  const jpSize = Math.max(22, Math.round(height * (isDouble ? 0.046 * Math.max(style.leftScale, style.rightScale) : 0.055 * style.scale)))
  const romanSize = Math.max(14, Math.round(jpSize * (isDouble ? 0.45 : 0.46)))
  const jpY = Math.round(height * style.vertical)
  const romanY = Math.min(height - 18, jpY + Math.round(jpSize * 0.95))
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Japanese,Noto Sans JP ExtraBold,${jpSize},${assColor(style.afterColor)},${assColor(style.beforeColor)},${assColor(style.outlineColor)},&H80000000&,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(jpSize * 0.07))},1,5,40,40,0,1\nStyle: Romaji,DM Sans 14pt,${romanSize},${assColor(style.afterColor)},${assColor(style.beforeColor)},${assColor(style.outlineColor)},&H80000000&,0,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(romanSize * 0.08))},1,5,40,40,0,1\nStyle: Countdown,Noto Sans JP ExtraBold,${Math.max(14, Math.round(jpSize * 0.7))},${assColor('#bdbdc4')},${assColor('#bdbdc4')},${assColor(style.outlineColor)},&H80000000&,-1,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(jpSize * 0.04))},1,4,40,40,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`
  const events: string[] = []
  const visibleLines = lines.filter(line => line.units.length)
  const rowStart = (index: number) => doubleRowStart(visibleLines, index, offset)
  const finalEnd = visibleLines.length ? Math.max(...visibleLines.map(lineFinish)) + offset + 2 : 0
  for (const [index, line] of visibleLines.entries()) {
    const left = index % 2 === 0
    const rowX = isDouble ? Math.round(width * (left ? style.leftX : style.rightX)) : Math.round(width / 2)
    const rowY = isDouble ? Math.round(height * (left ? style.leftY : style.rightY)) : jpY
    const sideScale = left ? style.leftScale : style.rightScale
    const baseJpSize = isDouble ? Math.max(22, Math.round(height * 0.046 * sideScale)) : jpSize
    const baseRomanSize = isDouble ? Math.max(14, Math.round(baseJpSize * 0.45)) : romanSize
    const maxTextWidth = isDouble ? width * (left ? 0.96 - style.leftX : style.rightX - 0.04) : width * 0.88
    const jpFontSize = Math.max(14, Math.min(baseJpSize, Math.floor(maxTextWidth / Math.max(1, line.units.map(unit => unit.text).join('').length))))
    const romanFontSize = Math.max(10, Math.min(baseRomanSize, Math.floor(maxTextWidth / Math.max(1, (line.romajiUnits ?? []).map(unit => unit.text).join('').length * 0.55))))
    const tracks: Array<{ units: TimedUnit[] | undefined; name: 'Japanese' | 'Romaji'; y: number }> = [
      { units: line.units, name: 'Japanese', y: rowY },
      ...(style.showRomaji ? [{ units: line.romajiUnits, name: 'Romaji' as const, y: isDouble ? Math.round(rowY + jpFontSize * 0.58 + romanFontSize * 0.58 + 2) : romanY }] : []),
    ]
    for (const track of tracks) {
      if (!track.units?.length) continue
      const first = track.units[0].start + offset
      const last = Math.max(...track.units.map(unit => unit.end)) + offset
      const visibleStart = isDouble ? rowStart(index) : first
      const cutoff = visibleLines[index + 1] ? lineOnset(visibleLines[index + 1]) + offset : Infinity
      const rowEnd = isDouble ? doubleRowEnd(visibleLines, index, offset, finalEnd) : last
      const visibleEnd = isDouble ? rowEnd : Math.min(rowEnd, cutoff)
      const sweepCutoff = last > cutoff ? cutoff : Infinity
      if (visibleEnd <= clipStart || (clipDuration !== undefined && visibleStart >= clipStart + clipDuration)) continue
      const start = Math.max(clipStart, visibleStart)
      const end = Math.min(visibleEnd, sweepCutoff, clipDuration === undefined ? Infinity : clipStart + clipDuration)
      const fontSize = track.name === 'Japanese' ? jpFontSize : romanFontSize
      const weight = track.name === 'Japanese' ? 800 : 700
      const text = `{\\an${isDouble ? left ? 4 : 6 : 5}\\pos(${rowX},${track.y})\\fs${fontSize}\\b${weight}}` + karaokeText(track.units, offset, start)
      if (end > start) events.push(`Dialogue: 0,${assTime(start - clipStart)},${assTime(end - clipStart)},${track.name},,0,0,0,,${text}`)
      // After the next line starts, keep this row visible without sweeping it.
      if (isDouble && last > cutoff && cutoff < rowEnd) {
        const staticStart = Math.max(clipStart, visibleStart, cutoff)
        const staticEnd = Math.min(rowEnd, clipDuration === undefined ? Infinity : clipStart + clipDuration)
        if (staticEnd > staticStart) {
          const placement = text.slice(0, text.indexOf('}') + 1)
          const staticText = placement + assText(track.units.map(unit => unit.text).join(''))
          events.push(`Dialogue: 0,${assTime(staticStart - clipStart)},${assTime(staticEnd - clipStart)},${track.name},,0,0,0,,${staticText}`)
        }
      }
    }
    if (isDouble && hasBreakBefore(visibleLines, index)) {
      const onset = lineOnset(line) + offset
      const dotSize = Math.max(14, Math.round(jpFontSize * 0.7))
      const dotY = Math.max(0, Math.round(rowY - jpFontSize * 0.85))
      for (let phase = 0; phase < countdownPreviewSeconds; phase++) {
        const phaseStart = Math.max(rowStart(index), onset - countdownPreviewSeconds + phase)
        const phaseEnd = onset - countdownPreviewSeconds + phase + 1
        const start = Math.max(clipStart, phaseStart)
        const end = clipDuration === undefined ? phaseEnd : Math.min(phaseEnd, clipStart + clipDuration)
        if (end <= start) continue
        const visibleDots = Math.min(3, countdownPreviewSeconds - phase)
        const dots = [0, 1, 2].map(dot => '{\\alpha&H' + (dot < visibleDots ? '00' : 'FF') + '&}●').join('\\h')
        const text = `{\\an${left ? 4 : 6}\\pos(${rowX},${dotY})\\fs${dotSize}}${dots}`
        events.push(`Dialogue: 1,${assTime(start - clipStart)},${assTime(end - clipStart)},Countdown,,0,0,0,,${text}`)
      }
    }
  }
  return header + events.join('\n') + '\n'
}

/** Positive offset means a lyric at song time t occurs later in the MV. */
export function estimateAudioOffset(songEnergy: number[], videoEnergy: number[], hz = 10, maxLagSeconds = 120): { offsetSeconds: number; confidence: number } {
  let bestLag = 0
  let best = -Infinity
  const maxLag = Math.min(Math.round(maxLagSeconds * hz), videoEnergy.length - 1)
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const start = Math.max(0, -lag)
    const end = Math.min(songEnergy.length, videoEnergy.length - lag)
    if (end - start < hz * 25) continue
    let sumA = 0; let sumB = 0; let sumAA = 0; let sumBB = 0; let sumAB = 0
    for (let index = start; index < end; index++) {
      const a = songEnergy[index]
      const b = videoEnergy[index + lag]
      sumA += a; sumB += b; sumAA += a * a; sumBB += b * b; sumAB += a * b
    }
    const count = end - start
    const numerator = sumAB - sumA * sumB / count
    const denominator = Math.sqrt((sumAA - sumA * sumA / count) * (sumBB - sumB * sumB / count))
    const score = denominator > 0 ? numerator / denominator : -1
    if (score > best) { best = score; bestLag = lag }
  }
  return { offsetSeconds: bestLag / hz, confidence: Math.max(0, Math.min(1, best)) }
}

export function pcmEnergy(pcm: Buffer, sampleRate = 8000, hz = 10): number[] {
  const samplesPerBlock = Math.round(sampleRate / hz)
  const blocks = Math.floor(pcm.length / 2 / samplesPerBlock)
  const energy: number[] = []
  for (let block = 0; block < blocks; block++) {
    let sum = 0
    for (let sample = 0; sample < samplesPerBlock; sample++) {
      const amplitude = pcm.readInt16LE((block * samplesPerBlock + sample) * 2)
      sum += amplitude * amplitude
    }
    energy.push(Math.log1p(Math.sqrt(sum / samplesPerBlock)))
  }
  return energy
}
