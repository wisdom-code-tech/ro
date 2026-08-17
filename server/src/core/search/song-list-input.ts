import type { Platform } from './index.js'

export interface ParsedSongListUrl {
  platform: Platform
  id: string
}

/**
 * 从各平台公开歌单链接中提取平台与歌单 ID。
 *
 * 这里只接受明确的官方域名和路径，避免把普通搜索词或不相关 URL
 * 误判为可直接读取的歌单。
 */
export function parseSongListUrl(input: string): ParsedSongListUrl | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const pathAndHash = `${url.pathname}${url.hash}`
  let match: RegExpExecArray | null

  if (host === 'music.163.com' || host.endsWith('.music.163.com')) {
    const hashQuery = url.hash.includes('?') ? new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1)) : null
    const id = url.searchParams.get('id') ?? hashQuery?.get('id')
    if (/playlist/i.test(pathAndHash) && id && /^\d+$/.test(id)) return { platform: 'wy', id }
  }

  if (host === 'y.qq.com' || host.endsWith('.y.qq.com')) {
    match = /\/(?:playlist|playsquare)\/(\d+)(?:\.html)?(?:\/|$)/i.exec(pathAndHash)
    if (match) return { platform: 'tx', id: match[1]! }
  }

  if (host === 'kuwo.cn' || host.endsWith('.kuwo.cn') || host === 'kwmusic.cn' || host.endsWith('.kwmusic.cn')) {
    match = /\/playlist_detail\/(\d+)(?:\/|$)/i.exec(pathAndHash)
    if (match) return { platform: 'kw', id: match[1]! }
  }

  if (host === 'kugou.com' || host.endsWith('.kugou.com')) {
    match = /\/special\/single\/(?:id_)?(\d+)(?:-\d+-\d+)?(?:\.html)?(?:\/|$)/i.exec(pathAndHash)
    if (match) return { platform: 'kg', id: `id_${match[1]!}` }
  }

  if (host === 'music.migu.cn' || host.endsWith('.music.migu.cn')) {
    match = /\/playlist\/(\d+)(?:\/|$)/i.exec(pathAndHash)
    if (match) return { platform: 'mg', id: match[1]! }
  }

  return null
}
