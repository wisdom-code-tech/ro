import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { libraryStore } from '../db/library.js'
import { analyzeAudio, QUALITY_RANK } from './analyzer.js'

export interface UpgradeFinalizeResult {
  filePath: string
  fileSize: number
  warnings: string[]
}

function safeRelative(root: string, filePath: string): string {
  const relative = path.relative(root, filePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('原文件不在音乐库目录内')
  return relative
}

export async function finalizeLibraryUpgrade(trackId: string, stagedPath: string): Promise<UpgradeFinalizeResult> {
  const track = libraryStore.get(trackId)
  if (!track) throw new Error('升级目标已不存在')
  let backupPath: string | null = null
  let movedOriginal = false
  try {
    const [oldAnalysis, newAnalysis] = await Promise.all([analyzeAudio(track.file_path), analyzeAudio(stagedPath)])
    if (QUALITY_RANK[newAnalysis.qualityTier] <= QUALITY_RANK[oldAnalysis.qualityTier]) {
      throw new Error(`新文件品质未提升（${oldAnalysis.qualityTier} → ${newAnalysis.qualityTier}）`)
    }
    if (track.duration && newAnalysis.duration) {
      const diff = Math.abs(track.duration - newAnalysis.duration)
      if (diff > 3 && diff / track.duration > 0.03) throw new Error(`时长不匹配（相差 ${diff.toFixed(1)} 秒）`)
    }

    const root = config.download.dir
    const relative = safeRelative(root, track.file_path)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backupPath = path.join(root, '.ro-upgrades', 'backup', stamp, relative)
    await fs.promises.mkdir(path.dirname(backupPath), { recursive: true })

    const targetExt = `.${newAnalysis.format}`
    const targetPath = track.file_path.replace(/\.(mp3|flac)$/i, targetExt)
    if (targetPath !== track.file_path && fs.existsSync(targetPath)) throw new Error(`目标文件已存在: ${path.basename(targetPath)}`)

    await fs.promises.rename(track.file_path, backupPath)
    movedOriginal = true
    try {
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.promises.rename(stagedPath, targetPath)
    } catch (err) {
      await fs.promises.rename(backupPath, track.file_path)
      movedOriginal = false
      throw err
    }

    const stat = await fs.promises.stat(targetPath)
    libraryStore.update(trackId, {
      file_path: targetPath,
      file_name: path.basename(targetPath),
      format: newAnalysis.format,
      codec: newAnalysis.codec,
      title: newAnalysis.title,
      artist: newAnalysis.artist,
      album: newAnalysis.album,
      duration: newAnalysis.duration,
      bitrate: newAnalysis.bitrate,
      sample_rate: newAnalysis.sampleRate,
      bit_depth: newAnalysis.bitDepth,
      file_size: stat.size,
      file_mtime: Math.trunc(stat.mtimeMs),
      quality_tier: newAnalysis.qualityTier,
      upgrade_status: 'upgraded',
      upgrade_reason: `已从 ${oldAnalysis.qualityTier} 升级为 ${newAnalysis.qualityTier}；原文件备份至 ${backupPath}`,
      last_scanned_at: Date.now(),
    })
    return { filePath: targetPath, fileSize: stat.size, warnings: [] }
  } catch (err) {
    if (movedOriginal && backupPath && !fs.existsSync(track.file_path)) {
      await fs.promises.rename(backupPath, track.file_path).catch(() => undefined)
    }
    await fs.promises.rm(stagedPath, { force: true }).catch(() => undefined)
    libraryStore.update(trackId, { upgrade_status: 'failed', upgrade_reason: err instanceof Error ? err.message : String(err) })
    throw err
  }
}
