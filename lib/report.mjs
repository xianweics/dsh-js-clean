/**
 * dsh-js-clean / lib/report.mjs
 *
 * 把分析结果压成一段给人读的 Markdown。工具返回的结构化字段是给模型看的，
 * 这一段是给它转述给用户时省事的——结论在前，证据在后。
 */

import { findTechnique } from './knowledge.mjs'

const ICON = { error: '❌', warn: '⚠️', info: 'ℹ️' }

/** 生成 Markdown 报告。 */
export function formatReport(report, options = {}) {
  const maxFindings = Number.isInteger(options.maxFindings) ? options.maxFindings : 15

  if (!report || report.ok === false) {
    const message = report && report.error ? report.error.message : '分析失败'
    return `## 未能分析\n\n${message}`
  }

  const lines = []
  const fileLabel = report.file && report.file.path ? report.file.path : '<内联代码>'
  lines.push(`## 整洁度 ${report.grade} · ${report.score}/100`)
  lines.push('')
  lines.push(`文件：\`${fileLabel}\` · ${report.metrics.lines} 行 · ${report.metrics.functions} 个函数 · 最长函数 ${report.metrics.longestFunction} 行`)
  lines.push('')

  const { bySeverity, total } = report.counts
  if (total === 0) {
    lines.push('没有发现明显坏味道。')
  } else {
    lines.push(`问题合计 ${total} 处：❌ ${bySeverity.error} · ⚠️ ${bySeverity.warn} · ℹ️ ${bySeverity.info}`)
    lines.push('')

    const shown = report.findings.slice(0, maxFindings)
    for (const finding of shown) {
      const technique = finding.technique ? findTechnique(finding.technique) : undefined
      const target = technique
        ? ` → \`${technique.id} ${technique.name}\``
        : ''
      lines.push(`- **L${finding.line}** ${ICON[finding.severity] || ''} ${finding.message}${target}`)
      if (finding.snippet) lines.push(`  \`${finding.snippet}\``)
    }
    if (report.findings.length > shown.length) {
      lines.push(`- ……还有 ${report.findings.length - shown.length} 处，见结构化字段 findings`)
    }
  }

  if (report.nextSteps && report.nextSteps.length > 0) {
    lines.push('')
    lines.push('**先动这几个手法**（按出现次数排）')
    for (const step of report.nextSteps) {
      const technique = findTechnique(step.technique)
      const name = technique ? `${technique.id} ${technique.name}` : step.technique
      lines.push(`- ${name} ×${step.count}`)
    }
  }

  lines.push('')
  lines.push('_评分只是相对指标：同一份代码反复跑分数稳定，跨项目比分数没有意义。_')
  return lines.join('\n')
}

/** 生成修复结果的 Markdown。 */
export function formatFix(result, options = {}) {
  if (!result || result.ok === false) {
    return `## 未能修复\n\n${result && result.error ? result.error.message : '修复失败'}`
  }
  const lines = []
  if (result.edits.length === 0) {
    lines.push('## 没有可自动修复的地方')
  } else {
    lines.push(`## 可自动修复 ${result.edits.length} 处`)
    lines.push('')
    for (const edit of result.edits) {
      lines.push(`- **L${edit.line}** \`${edit.from}\` → \`${edit.to}\`：${edit.reason}`)
    }
  }
  if (result.skipped && result.skipped.length > 0) {
    lines.push('')
    lines.push(`**跳过 ${result.skipped.length} 处**（不敢替你改，原因如下）`)
    for (const item of result.skipped.slice(0, 8)) {
      lines.push(`- L${item.line} ${item.rule}：${item.reason}`)
    }
  }
  if (options.wrote) {
    lines.push('')
    lines.push(`已写入 \`${options.wrote}\`${options.backup ? `，原文件备份在 \`${options.backup}\`` : ''}。`)
  }
  return lines.join('\n')
}
