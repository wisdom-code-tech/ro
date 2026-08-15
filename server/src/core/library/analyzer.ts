import path from 'node:path'
import { parseFile } from 'music-metadata'
import type { LibraryFormat, QualityTier, UpgradeStatus } from '../db/library.js'

export interface AudioAnalysis {
  format: LibraryFormat
  codec: string | null
  title: string | null
  artist: string | null
  album: string | null
  duration: number | null
  bitrate: number | null
  sampleRate: number | null
  bitDepth: number | null
  qualityTier: QualityTier
  upgradeStatus: UpgradeStatus
  upgradeReason: string | null
}

export function classifyQuality(format: LibraryFormat, bitrate: number | null, sampleRate: number | null, bitDepth: number | null): Pick<AudioAnalysis, 'qualityTier' | 'upgradeStatus' | 'upgradeReason'> {
  if (format === 'mp3') {
    if (!bitrate) return { qualityTier: 'unknown', upgradeStatus: 'recommended', upgradeReason: '无法读取 MP3 码率，建议人工检查' }
    const kbps = Math.round(bitrate / 1000)
    if (kbps < 192) return { qualityTier: 'lossy_low', upgradeStatus: 'recommended', upgradeReason: `MP3 ${kbps}kbps，低于 192kbps` }
    if (kbps < 256) return { qualityTier: 'lossy_standard', upgradeStatus: 'recommended', upgradeReason: `MP3 ${kbps}kbps，建议升级为无损音源` }
    if (kbps < 320) return { qualityTier: 'lossy_high', upgradeStatus: 'recommended', upgradeReason: `MP3 ${kbps}kbps，可升级为无损音源` }
    return { qualityTier: 'lossy_high', upgradeStatus: 'none', upgradeReason: null }
  }
  if (!sampleRate && !bitDepth) return { qualityTier: 'unknown', upgradeStatus: 'none', upgradeReason: 'FLAC 参数不完整，建议人工检查' }
  if ((bitDepth ?? 0) >= 24 || (sampleRate ?? 0) > 48_000) return { qualityTier: 'lossless_hires', upgradeStatus: 'none', upgradeReason: null }
  return { qualityTier: 'lossless_cd', upgradeStatus: 'none', upgradeReason: null }
}

export async function analyzeAudio(filePath: string): Promise<AudioAnalysis> {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (ext !== 'mp3' && ext !== 'flac') throw new Error(`不支持的格式: ${ext}`)
  const format = ext as LibraryFormat
  const metadata = await parseFile(filePath, { duration: true, skipCovers: true })
  const bitrate = metadata.format.bitrate ? Math.round(metadata.format.bitrate) : null
  const sampleRate = metadata.format.sampleRate ?? null
  const bitDepth = metadata.format.bitsPerSample ?? null
  return {
    format,
    codec: metadata.format.codec ?? metadata.format.container ?? null,
    title: metadata.common.title?.trim() || null,
    artist: metadata.common.artist?.trim() || null,
    album: metadata.common.album?.trim() || null,
    duration: metadata.format.duration ?? null,
    bitrate,
    sampleRate,
    bitDepth,
    ...classifyQuality(format, bitrate, sampleRate, bitDepth),
  }
}

export const QUALITY_RANK: Record<QualityTier, number> = {
  unknown: 0, lossy_low: 1, lossy_standard: 2, lossy_high: 3, lossless_cd: 4, lossless_hires: 5,
}
