import type { LyricLine, TimedUnit } from './types.js'

export interface MvStyle {
  vertical: number
  scale: number
  beforeColor: string
  afterColor: string
  outlineColor: string
  showRomaji: boolean
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
  render?: { kind: 'preview' | 'full'; status: 'queued' | 'running' | 'failed' | 'complete'; progress: number; error?: string }
}

export const defaultMvStyle: MvStyle = {
  vertical: 0.76,
  scale: 1,
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

export function generateAss(lines: LyricLine[], offsetMs: number, style: MvStyle, width: number, height: number, clipStart = 0, clipDuration?: number): string {
  const offset = offsetMs / 1000
  const jpSize = Math.max(22, Math.round(height * 0.055 * style.scale))
  const romanSize = Math.max(14, Math.round(jpSize * 0.46))
  const jpY = Math.round(height * style.vertical)
  const romanY = Math.min(height - 18, jpY + Math.round(jpSize * 0.95))
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Japanese,Yu Gothic,${jpSize},${assColor(style.afterColor)},${assColor(style.beforeColor)},${assColor(style.outlineColor)},&H80000000&,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(jpSize * 0.07))},1,5,40,40,0,1\nStyle: Romaji,Yu Gothic,${romanSize},${assColor(style.afterColor)},${assColor(style.beforeColor)},${assColor(style.outlineColor)},&H80000000&,0,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(romanSize * 0.08))},1,5,40,40,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`
  const events: string[] = []
  for (const line of lines) {
    const tracks: Array<{ units: TimedUnit[] | undefined; name: 'Japanese' | 'Romaji'; y: number }> = [
      { units: line.units, name: 'Japanese', y: jpY },
      ...(style.showRomaji ? [{ units: line.romajiUnits, name: 'Romaji' as const, y: romanY }] : []),
    ]
    for (const track of tracks) {
      if (!track.units?.length) continue
      const first = track.units[0].start + offset
      const last = Math.max(...track.units.map(unit => unit.end)) + offset
      if (last <= clipStart || (clipDuration !== undefined && first >= clipStart + clipDuration)) continue
      const start = Math.max(clipStart, first)
      const end = clipDuration === undefined ? last : Math.min(last, clipStart + clipDuration)
      if (end <= start) continue
      const characters = track.units.map(unit => unit.text).join('').length
      const fontSize = track.name === 'Japanese'
        ? Math.max(14, Math.min(jpSize, Math.floor(width * 0.88 / Math.max(1, characters))))
        : Math.max(10, Math.min(romanSize, Math.floor(width * 0.88 / Math.max(1, characters * 0.55))))
      const text = `{\\an5\\pos(${Math.round(width / 2)},${track.y})\\fs${fontSize}}` + karaokeText(track.units, offset, start)
      events.push(`Dialogue: 0,${assTime(start - clipStart)},${assTime(end - clipStart)},${track.name},,0,0,0,,${text}`)
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
