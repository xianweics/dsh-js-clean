/**
 * dsh-js-clean —— DSH（DeepSeek Harness）的 Cordis 插件。
 *
 * 它把一个 JavaScript 文件的「整洁度」变成可操作的建议：一条 finding 不只
 * 告诉你哪儿不舒服，还告诉你该用哪个重构手法（名录来自 xianweics/refator-code
 * 整理的《重构》中文笔记）。
 *
 * 为什么做成工具而不是规则引擎/Codereview 面板：agent 的工作方式是「拿到结论
 * 再动手」。工具返回结构化 findings + 一段 Markdown，模型可以直接决定改哪里、
 * 怎么改；不引入 UI，也就不会和宿主的前端生命周期纠缠。
 *
 * 插件只用 acorn 一个依赖，其余全是本包内的纯函数，方便测试、也方便被别的
 * 插件 import 复用。
 */

import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { analyzeSource, DEFAULT_THRESHOLDS, SEVERITY_RANK } from './analyzer.mjs'
import { computeFixes } from './fixes.mjs'
import { formatReport, formatFix } from './report.mjs'
import { loadCatalog, findTechnique, findSmell, listTechniques, listSmells, decorateFinding } from './knowledge.mjs'

/** 稳定的 Cordis 插件名；日志行以它开头。 */
export const name = 'js-clean'

/**
 * 没有硬依赖：tools 服务缺席时插件照常加载，只是不注册工具（降级而非启动失败）。
 */
export const inject = []

/** 暴露给模型的工具名。 */
const TOOL_NAME = 'js_clean'

/** 单文件上限 2 MiB —— 再大就不该用一次工具调用来读了。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * 生命周期：等 tools 服务就位再注册，并把它挂进 effect，插件卸载时工具一起回收。
 */
export function apply(ctx) {
  const logger = ctx.logger

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => {
      logger.info('%s: mounted (tool=%s)', name, TOOL_NAME)
      const disposal = registerTool(toolsCtx, logger)
      return () => {
        disposal?.()
        logger.info('%s: unloaded', name)
      }
    }, name + ': tool')
  })
}

/**
 * 注册 js_clean。
 *
 * `tools.register()` 吃的是**已规范化**的 JSON Schema（required 是字段名数组），
 * 不是 defineTool 的简写 DSL，所以这里直接写全。
 */
function registerTool(ctx, logger) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.register !== 'function') {
    logger.warn('%s: ctx.tools 不可用，%s 工具没有注册', name, TOOL_NAME)
    return undefined
  }

  const description = [
    'JavaScript 代码整洁度体检与重构建议（面向《重构》名录，来自 xianweics/refator-code）。',
    ' action="scan"：分析一份源码（给 path 或 code），返回整洁度评分、度量、逐条坏味道以及每条该用哪个重构手法。',
    ' action="fix"：只做机器能证明不改变行为的安全改写（var→const/let、let→const、删除无副作用的未使用声明；aggressive=true 时才把 == 改成 ===），默认只返回 diff，write=true 才落盘（同时写 .bak 备份）。',
    ' action="explain"：解释一个重构手法或坏味道（technique / smell 传 id 或名字，如 "6.1"、"提炼函数"、"duplicate-code"），带来源笔记里的实例。',
    ' action="catalog"：列出手法名录（可按 chapter / keyword 过滤）或坏味道清单（smellList=true）。',
    ' 分析是静态的：跨文件引用、动态求值、框架魔法它看不见，findings 是线索不是判决。',
  ].join('')

  const parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['scan', 'fix', 'explain', 'catalog'],
        description: 'scan = 体检；fix = 安全自动修复；explain = 查手法/坏味道；catalog = 列名录。',
      },
      path: {
        type: 'string',
        description: '要分析的 .js/.mjs/.cjs 文件路径（绝对路径最稳；相对路径按宿主进程 cwd 解析）。与 code 二选一。',
      },
      code: {
        type: 'string',
        description: '直接给源码文本（与 path 二选一）。适合还没落盘或临时片段。',
      },
      technique: {
        type: 'string',
        description: 'action=explain 时查哪个手法：id（"6.1"）或名字（"提炼函数"）。',
      },
      smell: {
        type: 'string',
        description: 'action=explain 时查哪个坏味道：id（"long-function"）或名字（"过长函数"）。',
      },
      smellList: {
        type: 'boolean',
        description: 'action=catalog 时改为列坏味道清单（默认列手法）。',
      },
      chapter: {
        type: 'string',
        description: 'action=catalog 时按章节前缀过滤，如 "6"、"7 封装"。',
      },
      keyword: {
        type: 'string',
        description: 'action=catalog 时按关键词过滤（匹配 id/名字/目的/场景）。',
      },
      minSeverity: {
        type: 'string',
        enum: ['info', 'warn', 'error'],
        description: 'scan 时只返回不低于该严重度的 findings（默认 info）。',
      },
      maxFindings: {
        type: 'integer',
        description: 'Markdown 摘要里最多列多少条（默认 15）；结构化 findings 不受影响。',
      },
      write: {
        type: 'boolean',
        description: 'action=fix 时是否真的写回文件（默认 false，只给 diff）。',
      },
      aggressive: {
        type: 'boolean',
        description: 'action=fix 时是否连同 == → === 一起改（可能影响隐式类型转换，默认 false）。',
      },
      removeUnused: {
        type: 'boolean',
        description: 'action=fix 时是否尝试删除无副作用的未使用声明（默认 true）。',
      },
      thresholds: {
        type: 'object',
        additionalProperties: true,
        description: `阈值覆盖，可选键：${Object.keys(DEFAULT_THRESHOLDS).join(', ')}。`,
      },
    },
  }

  const disposal = tools.register({
    name: TOOL_NAME,
    description,
    parameters,
    execute: async (args) => runTool(args, logger),
  })

  return disposal
}

/* ───────────────────────────── 工具实现 ───────────────────────────── */

async function runTool(args, logger) {
  const input = args && typeof args === 'object' ? args : {}
  const action = typeof input.action === 'string' ? input.action : 'scan'

  try {
    switch (action) {
      case 'scan':
        return await runScan(input)
      case 'fix':
        return await runFix(input)
      case 'explain':
        return runExplain(input)
      case 'catalog':
        return runCatalog(input)
      default:
        return { action, ok: false, error: `未知 action：${action}（可用 scan / fix / explain / catalog）` }
    }
  } catch (error) {
    logger.warn('%s: %s 失败：%s', name, action, error && error.message ? error.message : String(error))
    return { action, ok: false, error: error && error.message ? error.message : String(error) }
  }
}

/** 读出要分析的源码：path 优先，其次 code。 */
async function readSource(input) {
  if (typeof input.path === 'string' && input.path.trim() !== '') {
    const raw = input.path.trim()
    const absolute = isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
    let text
    try {
      const buffer = await readFile(absolute)
      if (buffer.byteLength > MAX_FILE_BYTES) {
        throw new Error(`文件 ${buffer.byteLength} 字节，超过 ${MAX_FILE_BYTES} 字节上限`)
      }
      text = buffer.toString('utf8')
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`找不到文件：${absolute}`)
      if (error.code === 'EISDIR') throw new Error(`这是一个目录，不是文件：${absolute}`)
      throw error
    }
    return { code: text, path: absolute }
  }

  if (typeof input.code === 'string' && input.code !== '') {
    return { code: input.code, path: null }
  }

  throw new Error('要么给 path（文件路径），要么给 code（源码文本）')
}

function thresholdsOf(input) {
  return input.thresholds && typeof input.thresholds === 'object' ? input.thresholds : {}
}

async function runScan(input) {
  const { code, path } = await readSource(input)
  const report = analyzeSource(code, {
    filename: path,
    thresholds: thresholdsOf(input),
    minSeverity: input.minSeverity,
  })

  if (report.ok === false) {
    return {
      action: 'scan',
      ok: false,
      file: report.file,
      error: report.error,
      summary: formatReport(report),
    }
  }

  const findings = report.findings.map(decorateFinding)
  const summary = formatReport({ ...report, findings }, { maxFindings: input.maxFindings })

  return {
    action: 'scan',
    ok: true,
    file: report.file,
    score: report.score,
    grade: report.grade,
    metrics: report.metrics,
    counts: report.counts,
    findings,
    nextSteps: report.nextSteps.map((step) => {
      const technique = findTechnique(step.technique)
      return {
        technique: step.technique,
        name: technique ? technique.name : null,
        chapter: technique ? technique.chapter : null,
        count: step.count,
      }
    }),
    summary,
    note: '静态分析：跨文件引用与动态求值看不到，findings 当线索用。',
  }
}

async function runFix(input) {
  const { code, path } = await readSource(input)
  const fix = computeFixes(code, {
    aggressive: input.aggressive === true,
    removeUnused: input.removeUnused !== false,
    filename: path || 'code.js',
  })

  if (fix.ok === false) {
    return {
      action: 'fix',
      ok: false,
      error: fix.error,
      summary: formatFix(fix),
    }
  }

  const before = analyzeSource(code, { filename: path, thresholds: thresholdsOf(input) })
  const after = analyzeSource(fix.fixedCode, { filename: path, thresholds: thresholdsOf(input) })

  let wrote = null
  let backup = null
  if (input.write === true && fix.edits.length > 0) {
    if (!path) throw new Error('内联代码没法写回文件：write=true 需要同时给 path')
    backup = path + '.bak'
    await writeFile(backup, code, 'utf8')
    await writeFile(path, fix.fixedCode, 'utf8')
    wrote = path
  }

  const payload = {
    action: 'fix',
    ok: true,
    file: { path },
    edits: fix.edits,
    skipped: fix.skipped,
    diff: fix.diff,
    wrote,
    backup,
    scoreBefore: before.ok ? before.score : null,
    scoreAfter: after.ok ? after.score : null,
    summary: formatFix(fix, { wrote, backup }),
  }

  if (!wrote && fix.edits.length > 0) {
    payload.fixedCode = fix.fixedCode
    payload.note = '没有落盘：确认 diff 后带 write=true 再跑一次，或直接把 fixedCode 写回去。'
  }
  return payload
}

function runExplain(input) {
  const techniqueQuery = typeof input.technique === 'string' ? input.technique : ''
  const smellQuery = typeof input.smell === 'string' ? input.smell : ''

  if (!techniqueQuery && !smellQuery) {
    throw new Error('explain 需要 technique 或 smell（id 或名字）')
  }

  if (techniqueQuery) {
    const technique = findTechnique(techniqueQuery)
    if (!technique) {
      return {
        action: 'explain',
        ok: false,
        error: `名录里没有手法「${techniqueQuery}」。用 action="catalog" 看全部手法。`,
      }
    }
    return { action: 'explain', ok: true, kind: 'technique', technique }
  }

  const smell = findSmell(smellQuery)
  if (!smell) {
    return {
      action: 'explain',
      ok: false,
      error: `名录里没有坏味道「${smellQuery}」。用 action="catalog" smellList=true 看全部坏味道。`,
    }
  }
  return { action: 'explain', ok: true, kind: 'smell', smell }
}

function runCatalog(input) {
  const catalog = loadCatalog()
  const limit = Number.isInteger(input.limit) ? input.limit : 200

  if (!catalog.available) {
    return {
      action: 'catalog',
      ok: false,
      error: `${catalog.error || '名录不可用'}。分析（scan/fix）不依赖名录，仍可正常使用。`,
      source: catalog.source,
    }
  }

  if (input.smellList === true) {
    const smells = listSmells({ keyword: input.keyword, limit })
    return {
      action: 'catalog',
      ok: true,
      kind: 'smell',
      source: catalog.source,
      total: catalog.smells.length,
      returned: smells.length,
      smells,
    }
  }

  const techniques = listTechniques({ chapter: input.chapter, keyword: input.keyword, limit })
  return {
    action: 'catalog',
    ok: true,
    kind: 'technique',
    source: catalog.source,
    title: catalog.title,
    total: catalog.techniques.length,
    returned: techniques.length,
    techniques: techniques.map((item) => ({
      id: item.id,
      name: item.name,
      chapter: item.chapter,
    })),
  }
}

/** 供测试与别的插件复用。 */
export const internals = {
  analyzeSource,
  computeFixes,
  formatReport,
  formatFix,
  SEVERITY_RANK,
  loadCatalog,
}
