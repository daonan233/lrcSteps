export interface TimedUnit { text: string; start: number; end: number }
export interface LyricLine {
  id: string
  start: number
  end: number
  text: string
  romaji?: string
  units: TimedUnit[]
  romajiUnits?: TimedUnit[]
  confidence: number | null
  method: 'aligned' | 'estimated' | 'manual'
}
export interface Song {
  id: string
  title: string
  artist: string
  originalAudioName: string
  createdAt: string
  status: 'queued' | 'processing' | 'ready' | 'needs-review' | 'failed'
  error?: string
  audioUrl: string
  lines: LyricLine[]
  lineCount?: number
}
