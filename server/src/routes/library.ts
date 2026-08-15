import type { FastifyInstance } from 'fastify'
import { libraryStore, type LibraryFormat, type LibraryTrackRow, type QualityTier, type UpgradeStatus } from '../core/db/library.js'
import { libraryScanner } from '../core/library/scanner.js'
import { findTrackMatches, saveTrackMatch } from '../core/library/matcher.js'
import { downloadQueue } from '../core/download/queue.js'
import { isPlatform, type Platform } from '../core/search/index.js'
import type { MusicInfo } from '../core/adapters/common.js'
import type { Quality } from '../core/source-engine/lx-env.js'

const FORMATS = ['mp3', 'flac']
const QUALITY_TIERS = ['lossy_low', 'lossy_standard', 'lossy_high', 'lossless_cd', 'lossless_hires', 'unknown']
const UPGRADE_STATUSES = ['none', 'recommended', 'matched', 'queued', 'upgraded', 'failed']
const TARGET_QUALITIES = ['flac', 'flac24bit']

function trackView(row: LibraryTrackRow) {
  return {
    id: row.id, filePath: row.file_path, fileName: row.file_name, format: row.format, codec: row.codec,
    title: row.title, artist: row.artist, album: row.album, duration: row.duration, bitrate: row.bitrate,
    sampleRate: row.sample_rate, bitDepth: row.bit_depth, fileSize: row.file_size, fileMtime: row.file_mtime,
    qualityTier: row.quality_tier, upgradeStatus: row.upgrade_status, upgradeReason: row.upgrade_reason,
    matchedPlatform: row.matched_platform,
    matchedMusicInfo: row.matched_music_info ? JSON.parse(row.matched_music_info) as MusicInfo : null,
    lastScannedAt: row.last_scanned_at, updatedAt: row.updated_at,
  }
}

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/library/scan', async (_req, reply) => {
    if (libraryScanner.isRunning()) return reply.code(409).send({ error: '音乐库扫描正在运行', scan: libraryStore.latestScan() })
    void libraryScanner.scan().catch(() => undefined)
    return reply.code(202).send({ status: 'running' })
  })

  app.get('/api/v1/library/scan/current', async () => ({ running: libraryScanner.isRunning(), scan: libraryStore.latestScan() ?? null }))
  app.get('/api/v1/library/stats', async () => libraryStore.stats())

  app.get<{ Querystring: { format?: string; qualityTier?: string; upgradeStatus?: string; keyword?: string; limit?: string; offset?: string } }>('/api/v1/library/tracks', async (req, reply) => {
    const { format, qualityTier, upgradeStatus, keyword, limit, offset } = req.query
    if (format && !FORMATS.includes(format)) return reply.code(400).send({ error: 'invalid format', valid: FORMATS })
    if (qualityTier && !QUALITY_TIERS.includes(qualityTier)) return reply.code(400).send({ error: 'invalid qualityTier', valid: QUALITY_TIERS })
    if (upgradeStatus && !UPGRADE_STATUSES.includes(upgradeStatus)) return reply.code(400).send({ error: 'invalid upgradeStatus', valid: UPGRADE_STATUSES })
    const result = libraryStore.list({
      format: format as LibraryFormat | undefined, qualityTier: qualityTier as QualityTier | undefined,
      upgradeStatus: upgradeStatus as UpgradeStatus | undefined, keyword,
      limit: limit ? parseInt(limit) : undefined, offset: offset ? parseInt(offset) : undefined,
    })
    return { total: result.total, tracks: result.tracks.map(trackView) }
  })

  app.get<{ Params: { id: string } }>('/api/v1/library/tracks/:id', async (req, reply) => {
    const track = libraryStore.get(req.params.id)
    if (!track) return reply.code(404).send({ error: 'track not found' })
    return trackView(track)
  })

  app.post<{ Params: { id: string }; Body: { platform?: string; musicInfo?: MusicInfo } }>('/api/v1/library/tracks/:id/match', async (req, reply) => {
    const track = libraryStore.get(req.params.id)
    if (!track) return reply.code(404).send({ error: 'track not found' })
    const { platform, musicInfo } = req.body ?? {}
    if (platform || musicInfo) {
      if (!platform || !isPlatform(platform) || !musicInfo?.songmid) return reply.code(400).send({ error: 'valid platform and musicInfo are required' })
      saveTrackMatch(track.id, platform, musicInfo)
      return { matched: true, track: trackView(libraryStore.get(track.id)!) }
    }
    const candidates = await findTrackMatches(track.id)
    const best = candidates[0]
    if (best && best.score >= 0.85) saveTrackMatch(track.id, best.platform, best.musicInfo)
    return { autoMatched: !!best && best.score >= 0.85, threshold: 0.85, candidates, track: trackView(libraryStore.get(track.id)!) }
  })

  app.post<{ Params: { id: string }; Body: { quality?: Quality } }>('/api/v1/library/tracks/:id/upgrade', async (req, reply) => {
    const track = libraryStore.get(req.params.id)
    if (!track) return reply.code(404).send({ error: 'track not found' })
    if (track.upgrade_status === 'queued') return reply.code(409).send({ error: '该歌曲已有升级任务在队列中' })
    if (!track.matched_platform || !track.matched_music_info) return reply.code(409).send({ error: '请先匹配在线歌曲' })
    const quality = req.body?.quality ?? 'flac'
    if (!TARGET_QUALITIES.includes(quality)) return reply.code(400).send({ error: '升级目标只允许 flac 或 flac24bit' })
    const platform = track.matched_platform
    if (!isPlatform(platform)) return reply.code(409).send({ error: '保存的平台无效，请重新匹配' })
    const musicInfo = JSON.parse(track.matched_music_info) as MusicInfo
    const id = downloadQueue.enqueue({ platform, musicInfo, quality, libraryUpgrade: { trackId: track.id } })
    libraryStore.update(track.id, { upgrade_status: 'queued', upgrade_reason: `升级任务 ${id} 已入队` })
    return reply.code(201).send({ id, status: 'pending', trackId: track.id })
  })
}
