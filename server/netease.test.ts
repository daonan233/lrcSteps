import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getNeteaseLyrics, parseNeteaseSongId } from './netease.js'

test('extracts the song ID from a copied share message or a bare ID', () => {
  assert.equal(parseNeteaseSongId('分享歌曲：https://music.163.com/#/song?id=1815533595&userid=123'), '1815533595')
  assert.equal(parseNeteaseSongId('https://music.163.com/song?id=1815533595'), '1815533595')
  assert.equal(parseNeteaseSongId('1815533595'), '1815533595')
  assert.throws(() => parseNeteaseSongId('https://music.163.com.evil.test/#/song?id=1815533595'))
  assert.throws(() => parseNeteaseSongId('https://music.163.com/#/playlist?id=1815533595'))
})

test('returns standard Japanese and optional romanized LRC from the lyric API', async () => {
  const fetcher: typeof fetch = async input => {
    const endpoint = new URL(String(input))
    assert.equal(endpoint.hostname, 'music.163.com')
    assert.equal(endpoint.searchParams.get('id'), '1815533595')
    assert.equal(endpoint.searchParams.get('rv'), '1')
    return Response.json({
      code: 200,
      lrc: { lyric: '[00:01.090]君が好き' },
      romalrc: { lyric: '[00:01.090]kimi ga suki' },
    })
  }
  assert.deepEqual(await getNeteaseLyrics('1815533595', fetcher), {
    id: '1815533595', japanese: '[00:01.090]君が好き\n', romaji: '[00:01.090]kimi ga suki\n',
  })

  const withoutRomaji: typeof fetch = async () => Response.json({ code: 200, lrc: { lyric: '[00:01.090]君が好き' } })
  assert.equal((await getNeteaseLyrics('1815533595', withoutRomaji)).romaji, null)
})
