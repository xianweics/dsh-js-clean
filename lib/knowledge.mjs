/**
 * dsh-js-clean / lib/knowledge.mjs
 *
 * 名录知识库：把 catalog.json（从 xianweics/refator-code 的《重构》笔记里
 * 抽出来的手法与坏味道）读进内存，提供按 id / 名字 / 章节查询。
 *
 * 没装 catalog.json 时不能让整个插件崩掉——分析器本来就不依赖它，
 * 只是每条 finding 会少一个「该用哪个手法」的指引。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

let cache = null

/** 读取并缓存名录；文件缺失或损坏时返回空名录并带上 error。 */
export function loadCatalog() {
  if (cache) return cache
  const file = join(HERE, 'catalog.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    cache = {
      available: true,
      source: parsed.source || 'https://github.com/xianweics/refator-code',
      title: parsed.title || '重构：改善既有代码的设计（中文笔记）',
      techniques: Array.isArray(parsed.techniques) ? parsed.techniques : [],
      smells: Array.isArray(parsed.smells) ? parsed.smells : [],
    }
  } catch (error) {
    cache = {
      available: false,
      error: error.code === 'ENOENT' ? 'catalog.json 还没生成' : `catalog.json 读取失败：${error.message}`,
      source: 'https://github.com/xianweics/refator-code',
      techniques: [],
      smells: [],
    }
  }
  return cache
}

/** 按手法 id（如 "6.1"）或名字（含中文/英文子串）找一条。 */
export function findTechnique(query) {
  const catalog = loadCatalog()
  if (!query) return undefined
  const text = String(query).trim()
  return catalog.techniques.find((item) => item.id === text)
    || catalog.techniques.find((item) => item.name === text)
    || catalog.techniques.find((item) => item.name && item.name.includes(text))
    || catalog.techniques.find((item) => `${item.id} ${item.name}`.includes(text))
}

/** 按坏味道 id 或名字找一条。 */
export function findSmell(query) {
  const catalog = loadCatalog()
  if (!query) return undefined
  const text = String(query).trim()
  return catalog.smells.find((item) => item.id === text)
    || catalog.smells.find((item) => item.name === text)
    || catalog.smells.find((item) => item.name && item.name.includes(text))
}

/** 列出名录里的手法，可按章节/关键词过滤。 */
export function listTechniques({ chapter, keyword, limit = 200 } = {}) {
  const catalog = loadCatalog()
  const text = keyword ? String(keyword).trim() : ''
  const rows = catalog.techniques.filter((item) => {
    if (chapter && !String(item.chapter || '').startsWith(String(chapter).trim())) return false
    if (!text) return true
    return `${item.id} ${item.name} ${item.intent || ''} ${item.when || ''}`.includes(text)
  })
  return rows.slice(0, Math.max(1, Math.min(Number(limit) || 200, 500)))
}

/** 列出坏味道。 */
export function listSmells({ keyword, limit = 100 } = {}) {
  const catalog = loadCatalog()
  const text = keyword ? String(keyword).trim() : ''
  const rows = catalog.smells.filter((item) => !text
    || `${item.id} ${item.name} ${item.signs || ''}`.includes(text))
  return rows.slice(0, Math.max(1, Math.min(Number(limit) || 100, 300)))
}

/** 把一条 finding 补上手法名与章节，报告里就能直接读。 */
export function decorateFinding(finding) {
  if (!finding.technique) return finding
  const technique = findTechnique(finding.technique)
  if (!technique) return finding
  return {
    ...finding,
    techniqueName: technique.name,
    techniqueChapter: technique.chapter,
  }
}
