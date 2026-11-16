import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeSource, RULES, DEFAULT_THRESHOLDS } from '../lib/analyzer.mjs'
import { computeFixes } from '../lib/fixes.mjs'
import { formatReport, formatFix } from '../lib/report.mjs'

/** 一段故意写坏的代码：几乎每条规则都能命中。 */
const MESSY = `import { readFile } from 'node:fs'

var cacheSize = 0
let useless = 42

function handleUser(user, options, callback, legacyFlag, verbose) {
  var greeting = 'hello'
  if (user) {
    if (user.profile) {
      if (user.profile.settings) {
        if (user.profile.settings.theme) {
          greeting = user.profile.settings.theme === 'dark' ? 'night' : (verbose ? 'hi' : 'hey')
        }
      }
    }
  }
  if (verbose) console.log(greeting)
  const price = user.order.total * 1.13
  const timeout = 30000
  return { greeting, price, timeout, accent: user.profile.settings.theme.colors.primary }
}

function handleAdmin(admin, options, callback, legacyFlag, verbose) {
  let greeting = 'hello'
  if (admin) {
    if (admin.profile) {
      if (admin.profile.settings) {
        if (admin.profile.settings.theme) {
          greeting = admin.profile.settings.theme === 'dark' ? 'night' : (verbose ? 'hi' : 'hey')
        }
      }
    }
  }
  if (verbose) console.log(greeting)
  const price = admin.order.total * 1.13
  const timeout = 30000
  return { greeting, price, timeout, accent: admin.profile.settings.theme.colors.primary }
}

function normalizeA(rows) {
  const out = []
  for (const row of rows) {
    out.push({ name: String(row.name).trim(), price: Number(row.price) || 0 })
  }
  return out
}

function normalizeB(rows) {
  const out = []
  for (const row of rows) {
    out.push({ name: String(row.name).trim(), price: Number(row.price) || 0 })
  }
  return out
}

function collect(items) {
  const out = []
  for (const item of items) {
    out.push(item.name)
  }
  return out
}

export { handleUser, handleAdmin, normalizeA, normalizeB, collect, cacheSize }
`

const CLEAN = `const TIMEOUT_MS = 30000

export function formatName(user) {
  if (!user || !user.name) return ''
  return user.name.trim().toUpperCase()
}

export function totalOf(items) {
  return items.reduce((sum, item) => sum + item.price, 0)
}

export const TIMEOUT = TIMEOUT_MS
`

test('分析坏味道：命中预期的规则', () => {
  const report = analyzeSource(MESSY, { filename: 'messy.js' })
  assert.equal(report.ok, true)
  const rules = new Set(report.findings.map((finding) => finding.rule))

  for (const rule of [
    'long-param-list',
    'deep-nesting',
    'nested-ternary',
    'magic-number',
    'duplicate-code',
    'var-usage',
    'console-call',
    'unused-variable',
    'loop-push',
    'mutable-global',
    'long-call-chain',
  ]) {
    assert.ok(rules.has(rule), `应该报出 ${rule}，实际：${[...rules].join(',')}`)
  }

  assert.ok(report.score < 70, `分数应该偏低，实际 ${report.score}`)
  assert.ok(['C', 'D', 'E'].includes(report.grade))
})

test('每条 finding 都带行号与改法', () => {
  const report = analyzeSource(MESSY)
  for (const finding of report.findings) {
    assert.ok(Number.isInteger(finding.line) && finding.line > 0, 'finding 需要行号')
    assert.ok(typeof finding.message === 'string' && finding.message.length > 0)
    assert.ok(typeof finding.advice === 'string' && finding.advice.length > 0)
    assert.ok(RULES[finding.rule], `finding 的规则必须在规则表里：${finding.rule}`)
  }
})

test('干净的代码不误报', () => {
  const report = analyzeSource(CLEAN, { filename: 'clean.js' })
  assert.equal(report.ok, true)
  const noisy = report.findings.filter((finding) => finding.rule !== 'let-to-const')
  assert.deepEqual(noisy, [], `不该有 findings，实际：${JSON.stringify(noisy, null, 2)}`)
  assert.ok(report.score >= 95, `分数应该很高，实际 ${report.score}`)
})

test('阈值可以覆盖', () => {
  const strict = analyzeSource(CLEAN, { thresholds: { maxFileLines: 3 } })
  assert.ok(strict.findings.some((finding) => finding.rule === 'long-file'))
  const loose = analyzeSource(MESSY, {
    thresholds: { ...DEFAULT_THRESHOLDS, maxParams: 10, maxNesting: 10, duplicateMinChars: 100000 },
  })
  assert.ok(!loose.findings.some((finding) => finding.rule === 'long-param-list'))
})

test('语法错误给出 PARSE_ERROR 而不是抛异常', () => {
  const report = analyzeSource('function broken( {')
  assert.equal(report.ok, false)
  assert.equal(report.error.code, 'PARSE_ERROR')
  assert.ok(report.error.message.length > 0)
})

test('fix：var/let → const，并删除无副作用的未使用声明', () => {
  const code = `function demo() {
  var a = 1
  let b = 2
  b = b + 1
  let neverUsed = 42
  console.log(a, b)
}
demo()
`
  const fix = computeFixes(code)
  assert.equal(fix.ok, true)
  assert.match(fix.fixedCode, /const a = 1/)
  assert.match(fix.fixedCode, /let b = 2/)
  assert.doesNotMatch(fix.fixedCode, /neverUsed/)
  assert.match(fix.fixedCode, /console\.log/)
  assert.ok(fix.diff.includes('-  var a = 1'))
  /* 同一处声明只该被改一次：删掉之后不该再冒出 const neverUsed */
  assert.doesNotMatch(fix.fixedCode, /const neverUsed/)
})

test('fix：默认不改 ==，aggressive 才改，且保留判空', () => {
  const code = `const a = 1
if (a == 1) console.log('one')
if (a == null) console.log('none')
`
  const safe = computeFixes(code)
  assert.match(safe.fixedCode, /a == 1/)
  assert.ok(safe.skipped.length === 0)

  const aggressive = computeFixes(code, { aggressive: true })
  assert.match(aggressive.fixedCode, /a === 1/)
  assert.match(aggressive.fixedCode, /a == null/)
  assert.ok(aggressive.skipped.some((item) => item.rule === 'loose-equality'))
})

test('fix：不改进内联代码里的脚本级全局 var', () => {
  const code = `var globalThing = { x: 1 }
function useIt() { return 1 }
useIt()
`
  const fix = computeFixes(code)
  assert.match(fix.fixedCode, /var globalThing/)
  assert.ok(fix.skipped.some((item) => item.reason.includes('脚本顶层')))
})

test('报告排版包含结论与手法指引', () => {
  const report = analyzeSource(MESSY, { filename: 'messy.js' })
  const markdown = formatReport(report)
  assert.match(markdown, /整洁度/)
  assert.match(markdown, /先动这几个手法/)

  const fix = computeFixes('var a = 1\nconsole.log(a)\n')
  const fixMarkdown = formatFix(fix)
  assert.match(fixMarkdown, /可自动修复|没有可自动修复/)
})
