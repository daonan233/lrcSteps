import { parseLrc } from './lyrics.js'

export interface NeteaseLyrics {
  id: string
  japanese: string
  romaji: string | null
}

export function parseNeteaseSongId(input: string): string {
  const value = input.trim()
  if (/^[1-9]\d{0,19}$/.test(value)) return value

  const match = value.match(/https?:\/\/[^\s<>]+/i)
  if (!match) throw new Error('请粘贴网易云音乐歌曲分享链接或歌曲 ID')
  let url: URL
  try { url = new URL(match[0].replace(/[)\]）。，,]+$/, '')) }
  catch { throw new Error('歌曲分享链接格式不正确') }

  if (!['music.163.com', 'y.music.163.com'].includes(url.hostname.toLowerCase())) {
    throw new Error('只支持网易云音乐的歌曲分享链接')
  }
  const songPath = /\/song(?:\/|$)/i.test(url.pathname) || /\/song(?:\?|$)/i.test(url.hash)
  if (!songPath) throw new Error('请提供歌曲分享链接，而非专辑或歌单链接')

  const fragmentQuery = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : ''
  const id = url.searchParams.get('id') ?? new URLSearchParams(fragmentQuery).get('id')
  if (!id || !/^[1-9]\d{0,19}$/.test(id)) throw new Error('歌曲链接中没有有效的歌曲 ID')
  return id
}

export async function getNeteaseLyrics(id: string, fetcher: typeof fetch = fetch): Promise<NeteaseLyrics> {
  const endpoint = new URL('https://music.163.com/api/song/lyric')
  for (const key of ['lv', 'kv', 'tv', 'yv', 'rv']) endpoint.searchParams.set(key, '1')
  endpoint.searchParams.set('id', id)

  let response: Response
  try {
    response = await fetcher(endpoint, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('连接网易云歌词接口失败，请稍后重试')
  }
  if (!response.ok) throw new Error(`网易云歌词接口返回 HTTP ${response.status}`)

  let payload: unknown
  try { payload = await response.json() }
  catch { throw new Error('网易云歌词接口返回了无效数据') }
  const data = payload as { code?: number; lrc?: { lyric?: unknown }; romalrc?: { lyric?: unknown } } | null
  if (!data || data.code !== 200) throw new Error('网易云歌词接口未返回有效结果')

  const japanese = typeof data.lrc?.lyric === 'string' ? data.lrc.lyric.trim() : ''
  if (!japanese || !parseLrc(japanese).length) throw new Error('这首歌没有可用的日文 LRC')
  const romanized = typeof data.romalrc?.lyric === 'string' ? data.romalrc.lyric.trim() : ''
  const romaji = romanized && parseLrc(romanized).length ? `${romanized}\n` : null
  return { id, japanese: `${japanese}\n`, romaji }
}
