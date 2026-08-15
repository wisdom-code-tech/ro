import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import PQueue from 'p-queue'
import { config } from '../config.js'
import { libraryStore, type ScanRow } from '../db/library.js'
import { analyzeAudio } from './analyzer.js'
import { logger } from '../logger.js'

async function collectAudioFiles(rootDir: string): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.ro-upgrades') continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(fullPath)
      else if (entry.isFile() && /\.(mp3|flac)$/i.test(entry.name)) files.push(fullPath)
    }
  }
  await fs.promises.mkdir(rootDir, { recursive: true })
  await walk(rootDir)
  return files
}

class LibraryScanner extends EventEmitter {
  private current: Promise<ScanRow> | null = null

  isRunning(): boolean { return this.current !== null }

  scan(): Promise<ScanRow> {
    if (this.current) return this.current
    this.current = this.run().finally(() => { this.current = null })
    return this.current
  }

  private async run(): Promise<ScanRow> {
    const rootDir = config.download.dir
    const scan = libraryStore.createScan(rootDir)
    const counters = { scanned_files: 0, added_files: 0, updated_files: 0, unchanged_files: 0, failed_files: 0 }
    this.emit('library:scan-started', scan)
    try {
      const files = await collectAudioFiles(rootDir)
      libraryStore.updateScan(scan.id, { total_files: files.length })
      const queue = new PQueue({ concurrency: 4 })
      for (const filePath of files) {
        void queue.add(async () => {
          try {
            const stat = await fs.promises.stat(filePath)
            const existing = libraryStore.getByPath(filePath)
            if (existing && existing.file_size === stat.size && existing.file_mtime === Math.trunc(stat.mtimeMs)) {
              libraryStore.touch(existing.id, scan.started_at)
              counters.unchanged_files++
            } else {
              const analysis = await analyzeAudio(filePath)
              const result = libraryStore.upsert({
                file_path: filePath, file_name: path.basename(filePath), format: analysis.format, codec: analysis.codec,
                title: analysis.title, artist: analysis.artist, album: analysis.album, duration: analysis.duration,
                bitrate: analysis.bitrate, sample_rate: analysis.sampleRate, bit_depth: analysis.bitDepth,
                file_size: stat.size, file_mtime: Math.trunc(stat.mtimeMs), quality_tier: analysis.qualityTier,
                upgrade_status: existing?.matched_music_info && analysis.upgradeStatus === 'recommended' ? 'matched' : analysis.upgradeStatus,
                upgrade_reason: existing?.matched_music_info && analysis.upgradeStatus === 'recommended' ? existing.upgrade_reason : analysis.upgradeReason,
                matched_platform: existing?.matched_platform ?? null, matched_music_info: existing?.matched_music_info ?? null,
                last_scanned_at: scan.started_at,
              })
              if (result.added) counters.added_files++
              else counters.updated_files++
            }
          } catch (err) {
            const existing = libraryStore.getByPath(filePath)
            if (existing) libraryStore.touch(existing.id, scan.started_at)
            counters.failed_files++
            logger.warn({ filePath, err: (err as Error).message }, '[library] scan file failed')
          } finally {
            counters.scanned_files++
            if (counters.scanned_files % 10 === 0 || counters.scanned_files === files.length) {
              libraryStore.updateScan(scan.id, counters)
              this.emit('library:scan-progress', { id: scan.id, totalFiles: files.length, ...counters })
            }
          }
        })
      }
      await queue.onIdle()
      const removed = libraryStore.removeMissing(rootDir, scan.started_at)
      const completedAt = Date.now()
      libraryStore.updateScan(scan.id, { ...counters, removed_files: removed, status: 'completed', completed_at: completedAt })
      const result = libraryStore.latestScan()!
      this.emit('library:scan-completed', result)
      return result
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      libraryStore.updateScan(scan.id, { ...counters, status: 'failed', error, completed_at: Date.now() })
      const result = libraryStore.latestScan()!
      this.emit('library:scan-failed', result)
      throw err
    }
  }
}

export const libraryScanner = new LibraryScanner()
