import { randomUUID } from 'node:crypto'
import { getDb } from './index.js'

export type LibraryFormat = 'mp3' | 'flac'
export type QualityTier = 'lossy_low' | 'lossy_standard' | 'lossy_high' | 'lossless_cd' | 'lossless_hires' | 'unknown'
export type UpgradeStatus = 'none' | 'recommended' | 'matched' | 'queued' | 'upgraded' | 'failed'

export interface LibraryTrackRow {
  id: string
  file_path: string
  file_name: string
  format: LibraryFormat
  codec: string | null
  title: string | null
  artist: string | null
  album: string | null
  duration: number | null
  bitrate: number | null
  sample_rate: number | null
  bit_depth: number | null
  file_size: number
  file_mtime: number
  quality_tier: QualityTier
  upgrade_status: UpgradeStatus
  upgrade_reason: string | null
  matched_platform: string | null
  matched_music_info: string | null
  last_scanned_at: number
  created_at: number
  updated_at: number
}

export interface ScanRow {
  id: string
  status: 'running' | 'completed' | 'failed'
  root_dir: string
  total_files: number
  scanned_files: number
  added_files: number
  updated_files: number
  unchanged_files: number
  removed_files: number
  failed_files: number
  error: string | null
  started_at: number
  completed_at: number | null
}

export interface TrackListOptions {
  format?: LibraryFormat
  qualityTier?: QualityTier
  upgradeStatus?: UpgradeStatus
  keyword?: string
  limit?: number
  offset?: number
}

export const libraryStore = {
  getByPath(filePath: string): LibraryTrackRow | undefined {
    return getDb().prepare('SELECT * FROM library_tracks WHERE file_path = ?').get(filePath) as LibraryTrackRow | undefined
  },

  get(id: string): LibraryTrackRow | undefined {
    return getDb().prepare('SELECT * FROM library_tracks WHERE id = ?').get(id) as LibraryTrackRow | undefined
  },

  upsert(input: Omit<LibraryTrackRow, 'id' | 'created_at' | 'updated_at'>): { row: LibraryTrackRow; added: boolean } {
    const existing = this.getByPath(input.file_path)
    const now = Date.now()
    if (existing) {
      getDb().prepare(`UPDATE library_tracks SET
        file_name=@file_name, format=@format, codec=@codec, title=@title, artist=@artist, album=@album,
        duration=@duration, bitrate=@bitrate, sample_rate=@sample_rate, bit_depth=@bit_depth,
        file_size=@file_size, file_mtime=@file_mtime, quality_tier=@quality_tier,
        upgrade_status=@upgrade_status, upgrade_reason=@upgrade_reason,
        last_scanned_at=@last_scanned_at, updated_at=@updated_at
        WHERE id=@id`).run({ ...input, id: existing.id, updated_at: now })
      return { row: this.get(existing.id)!, added: false }
    }
    const row: LibraryTrackRow = { ...input, id: randomUUID(), created_at: now, updated_at: now }
    getDb().prepare(`INSERT INTO library_tracks (
      id,file_path,file_name,format,codec,title,artist,album,duration,bitrate,sample_rate,bit_depth,
      file_size,file_mtime,quality_tier,upgrade_status,upgrade_reason,matched_platform,matched_music_info,
      last_scanned_at,created_at,updated_at
    ) VALUES (
      @id,@file_path,@file_name,@format,@codec,@title,@artist,@album,@duration,@bitrate,@sample_rate,@bit_depth,
      @file_size,@file_mtime,@quality_tier,@upgrade_status,@upgrade_reason,@matched_platform,@matched_music_info,
      @last_scanned_at,@created_at,@updated_at
    )`).run(row)
    return { row, added: true }
  },

  touch(id: string, scannedAt: number): void {
    getDb().prepare('UPDATE library_tracks SET last_scanned_at = ?, updated_at = ? WHERE id = ?').run(scannedAt, Date.now(), id)
  },

  update(id: string, patch: Partial<LibraryTrackRow>): void {
    const keys = Object.keys(patch).filter((key) => !['id', 'created_at'].includes(key))
    if (!keys.length) return
    const set = keys.map((key) => `${key}=@${key}`).join(', ')
    getDb().prepare(`UPDATE library_tracks SET ${set}, updated_at=@updated_at WHERE id=@id`)
      .run({ ...patch, id, updated_at: Date.now() })
  },

  removeMissing(rootDir: string, scannedAt: number): number {
    const prefix = rootDir.endsWith('/') ? rootDir : `${rootDir}/`
    return getDb().prepare('DELETE FROM library_tracks WHERE file_path LIKE ? AND last_scanned_at < ?')
      .run(`${prefix}%`, scannedAt).changes
  },

  list(opts: TrackListOptions = {}): { tracks: LibraryTrackRow[]; total: number } {
    const where: string[] = []
    const params: Record<string, unknown> = {}
    if (opts.format) { where.push('format=@format'); params.format = opts.format }
    if (opts.qualityTier) { where.push('quality_tier=@qualityTier'); params.qualityTier = opts.qualityTier }
    if (opts.upgradeStatus) { where.push('upgrade_status=@upgradeStatus'); params.upgradeStatus = opts.upgradeStatus }
    if (opts.keyword) {
      where.push('(title LIKE @keyword OR artist LIKE @keyword OR album LIKE @keyword OR file_name LIKE @keyword)')
      params.keyword = `%${opts.keyword}%`
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    params.limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
    params.offset = Math.max(opts.offset ?? 0, 0)
    const total = (getDb().prepare(`SELECT COUNT(*) AS count FROM library_tracks ${clause}`).get(params) as { count: number }).count
    const tracks = getDb().prepare(`SELECT * FROM library_tracks ${clause} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`).all(params) as LibraryTrackRow[]
    return { tracks, total }
  },

  stats(): Record<string, number> {
    const row = getDb().prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN format='mp3' THEN 1 ELSE 0 END) AS mp3,
      SUM(CASE WHEN format='flac' THEN 1 ELSE 0 END) AS flac,
      SUM(CASE WHEN upgrade_status='recommended' THEN 1 ELSE 0 END) AS recommended,
      SUM(CASE WHEN quality_tier='unknown' THEN 1 ELSE 0 END) AS unknown,
      SUM(CASE WHEN quality_tier='lossless_hires' THEN 1 ELSE 0 END) AS hires
      FROM library_tracks`).get() as Record<string, number | null>
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value ?? 0]))
  },

  createScan(rootDir: string): ScanRow {
    const row: ScanRow = {
      id: randomUUID(), status: 'running', root_dir: rootDir, total_files: 0, scanned_files: 0,
      added_files: 0, updated_files: 0, unchanged_files: 0, removed_files: 0, failed_files: 0,
      error: null, started_at: Date.now(), completed_at: null,
    }
    getDb().prepare(`INSERT INTO library_scans VALUES (
      @id,@status,@root_dir,@total_files,@scanned_files,@added_files,@updated_files,@unchanged_files,
      @removed_files,@failed_files,@error,@started_at,@completed_at
    )`).run(row)
    return row
  },

  updateScan(id: string, patch: Partial<ScanRow>): void {
    const keys = Object.keys(patch).filter((key) => key !== 'id')
    if (!keys.length) return
    getDb().prepare(`UPDATE library_scans SET ${keys.map((key) => `${key}=@${key}`).join(', ')} WHERE id=@id`).run({ ...patch, id })
  },

  latestScan(): ScanRow | undefined {
    return getDb().prepare('SELECT * FROM library_scans ORDER BY started_at DESC LIMIT 1').get() as ScanRow | undefined
  },
}
