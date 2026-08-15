import { searchService, type Platform } from '../search/index.js'
import { libraryStore } from '../db/library.js'
import type { MusicInfo } from '../adapters/common.js'

export interface MatchCandidate {
  platform: Platform
  musicInfo: MusicInfo
  score: number
  reasons: string[]
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function parseInterval(value: MusicInfo['interval']): number | null {
  if (typeof value !== 'string') return null
  const parts = value.split(':').map(Number)
  if (parts.some(Number.isNaN)) return null
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
  return null
}

function scoreCandidate(title: string, artist: string, duration: number | null, item: MusicInfo): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0
  const expectedTitle = normalize(title)
  const actualTitle = normalize(item.name)
  if (expectedTitle && actualTitle === expectedTitle) { score += 0.55; reasons.push('标题完全一致') }
  else if (expectedTitle && (actualTitle.includes(expectedTitle) || expectedTitle.includes(actualTitle))) { score += 0.35; reasons.push('标题部分一致') }

  const expectedArtist = normalize(artist)
  const actualArtist = normalize(item.singer)
  if (expectedArtist && actualArtist === expectedArtist) { score += 0.3; reasons.push('歌手完全一致') }
  else if (expectedArtist && (actualArtist.includes(expectedArtist) || expectedArtist.includes(actualArtist))) { score += 0.2; reasons.push('歌手部分一致') }

  const candidateDuration = parseInterval(item.interval)
  if (duration && candidateDuration) {
    const diff = Math.abs(duration - candidateDuration)
    if (diff <= 3 || diff / duration <= 0.03) { score += 0.15; reasons.push('时长一致') }
    else if (diff <= 8) { score += 0.05; reasons.push('时长接近') }
  }
  return { score: Math.round(score * 100) / 100, reasons }
}

export async function findTrackMatches(trackId: string): Promise<MatchCandidate[]> {
  const track = libraryStore.get(trackId)
  if (!track) throw new Error('track not found')
  const title = track.title || track.file_name.replace(/\.(mp3|flac)$/i, '').split(' - ')[0] || track.file_name
  const artist = track.artist || track.file_name.replace(/\.(mp3|flac)$/i, '').split(' - ').slice(1).join(' - ')
  const keyword = [title, artist].filter(Boolean).join(' ')
  const result = await searchService.searchAggregate(keyword, 1, undefined, 10)
  return result.results
    .filter((entry) => entry.ok)
    .flatMap((entry) => entry.list.map((musicInfo) => ({ platform: entry.platform, musicInfo, ...scoreCandidate(title, artist, track.duration, musicInfo) })))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
}

export function saveTrackMatch(trackId: string, platform: Platform, musicInfo: MusicInfo): void {
  const track = libraryStore.get(trackId)
  if (!track) throw new Error('track not found')
  libraryStore.update(trackId, {
    matched_platform: platform,
    matched_music_info: JSON.stringify(musicInfo),
    upgrade_status: 'matched',
  })
}
