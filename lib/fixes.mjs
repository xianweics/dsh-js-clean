/**
 * dsh-js-clean / lib/fixes.mjs
 *
 * 安全自动修复：只做「机器能证明不改变行为」的改写。
 *
 *   var → const / let       变量的作用域收窄，未重新赋值就用 const
 *   let → const              同上，只是原本已经是 let
 *   删除未使用的声明         仅当初始化表达式没有副作用、且不是脚本全局 var
 *   == → ===                进阶项（aggressive），可能改变隐式类型转换的结果
 *
 * 每一处改写都记下规则与理由，并同时给出统一 diff，方便先看再落盘。
 */

import { parseSource, walkAst, collectPatternNames, lineOf } from './analyzer.mjs'

/** 这些表达式求值没有副作用，删掉未使用的声明不会丢行为。 */
function isSideEffectFree(node) {
  if (!node) return true
  switch (node.type) {
    case 'Literal':
    case 'Identifier':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return true
    case 'TemplateLiteral':
      return node.expressions.length === 0
    case 'ArrayExpression':
      return node.elements.every((element) => element === null || isSideEffectFree(element))
    case 'ObjectExpression':
      return node.properties.every((property) => {
        if (property.type === 'SpreadElement') return isSideEffectFree(property.argument)
        return isSideEffectFree(property.value)
      })
    case 'UnaryExpression':
      return ['-', '+', '!', 'void', 'typeof'].includes(node.operator) && isSideEffectFree(node.argument)
    case 'BinaryExpression':
    case 'LogicalExpression':
      return isSideEffectFree(node.left) && isSideEffectFree(node.right)
    case 'ConditionalExpression':
      return isSideEffectFree(node.test) && isSideEffectFree(node.consequent) && isSideEffectFree(node.alternate)
    case 'MemberExpression':
      return isSideEffectFree(node.object)
    default:
      return false
  }
}

/** 收集被重新赋值的名字、以及所有出现过的标识符位置。 */
function collectBindingFacts(ast) {
  const reassigned = new Set()
  const declarationsCount = new Map()
  const occurrences = new Map() // name -> [{ start }]
  const paramNames = new Set()

  walkAst(ast, (node, parent) => {
    if (node.type === 'Identifier') {
      const list = occurrences.get(node.name) || []
      list.push({ start: node.start })
      occurrences.set(node.name, list)
    }

    if (node.type === 'VariableDeclarator') {
      for (const id of collectPatternNames(node.id)) {
        declarationsCount.set(id.name, (declarationsCount.get(id.name) || 0) + 1)
      }
    }

    if (node.type === 'AssignmentExpression') {
      for (const id of collectPatternNames(node.left)) reassigned.add(id.name)
      if (node.left.type === 'MemberExpression' && node.left.object.type === 'Identifier') {
        /* obj.x = 1 不是重绑定，const 依然合法 */
      }
    }

    if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') {
      reassigned.add(node.argument.name)
    }

    if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && node.left.type === 'Identifier') {
      reassigned.add(node.left.name)
    }

    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      for (const param of node.params || []) {
        for (const id of collectPatternNames(param)) paramNames.add(id.name)
      }
      if (node.type === 'FunctionDeclaration' && node.id) {
        declarationsCount.set(node.id.name, (declarationsCount.get(node.id.name) || 0) + 1)
      }
    }

    if (parent === null) return true
    return true
  })

  return { reassigned, declarationsCount, occurrences, paramNames }
}

/**
 * 计算修复。
 *
 * @param {string} code 源码
 * @param {{ aggressive?: boolean, filename?: string, removeUnused?: boolean }} [options]
 * @returns {{ ok: boolean, edits: object[], fixedCode: string|null, diff: string|null, skipped: object[] }}
 */
export function computeFixes(code, options = {}) {
  const aggressive = options.aggressive === true
  const removeUnused = options.removeUnused !== false
  const filename = options.filename || 'code.js'

  let parsed
  try {
    parsed = parseSource(code)
  } catch (error) {
    return { ok: false, error: { code: error.code || 'PARSE_ERROR', message: error.message }, edits: [], skipped: [] }
  }

  const { ast } = parsed
  const { reassigned, declarationsCount, occurrences, paramNames } = collectBindingFacts(ast)
  /* 是不是 ES 模块：脚本里的顶层 var 会挂到全局对象上，语义与模块不同，改写要更保守 */
  const isModule = /^\s*(import|export)\s/m.test(code)

  const edits = []
  const skipped = []

  /** 该名字能否安全地按「从未重新赋值」处理。 */
  const canRebindKind = (name, idNode) => {
    if (reassigned.has(name)) return { ok: true, kind: 'let' }
    if ((declarationsCount.get(name) || 0) > 1 || paramNames.has(name)) {
      return { ok: false, reason: '同名在多处声明或与参数同名，跳过以保守起见' }
    }
    const seen = occurrences.get(name) || []
    if (seen.some((item) => item.start < idNode.start)) {
      return { ok: false, reason: '声明之前就引用了它（var 提升），改成块级作用域会触发 TDZ' }
    }
    return { ok: true, kind: 'const' }
  }

  /* ── 1. var / let → const/let ─────────────────────────────────── */
  const referencedNames = new Set()
  for (const [name, list] of occurrences) if (list.length > 1) referencedNames.add(name)

  walkAst(ast, (node, parent) => {
    if (node.type !== 'VariableDeclaration') return
    if (node.kind === 'const') return
    const keyword = code.slice(node.start, node.start + node.kind.length)
    if (keyword !== node.kind) return // 语法上不该发生，兜底

    /* 脚本顶层的 var 是全局属性（window.x），改成 const 会变成词法绑定——不动 */
    if (node.kind === 'var' && !isModule && parent && parent.type === 'Program') {
      skipped.push({ rule: 'var-usage', line: lineOf(node), reason: '脚本顶层 var 挂在全局对象上，改写会改变可见性' })
      return
    }

    let target = 'const'
    const reasons = []
    for (const declarator of node.declarations) {
      if (declarator.id.type !== 'Identifier') {
        skipped.push({ rule: 'var-usage', line: lineOf(node), reason: '解构声明暂不自动改写' })
        return
      }
      const decision = canRebindKind(declarator.id.name, declarator.id)
      if (!decision.ok) {
        skipped.push({ rule: 'var-usage', line: lineOf(node), reason: decision.reason })
        return
      }
      if (decision.kind === 'let') {
        target = 'let'
        reasons.push(`${declarator.id.name} 之后有重新赋值`)
      }
    }

    if (target === node.kind) return
    edits.push({
      rule: node.kind === 'var' ? 'var-usage' : 'let-to-const',
      line: lineOf(node),
      start: node.start,
      end: node.start + node.kind.length,
      from: node.kind,
      to: target,
      reason: target === 'const'
        ? '声明后从未重新赋值'
        : reasons.join('；') || '存在重新赋值',
    })
  })

  /* ── 2. 删除未使用的声明 ─────────────────────────────────────── */
  if (removeUnused) {
    walkAst(ast, (node, parent) => {
      if (node.type !== 'VariableDeclaration') return
      if (node.declarations.length !== 1) return
      const declarator = node.declarations[0]
      if (declarator.id.type !== 'Identifier') return
      const name = declarator.id.name
      if (name.startsWith('_')) return
      if (referencedNames.has(name)) return
      if (declarationsCount.get(name) !== 1) return
      /* 脚本顶层的 var 可能被别的脚本/全局消费者看到，不动它；const/let 是词法绑定，风险小得多 */
      const atTopLevel = Boolean(parent && parent.type === 'Program')
      if (atTopLevel && !isModule && node.kind === 'var') {
        skipped.push({ rule: 'unused-variable', line: lineOf(node), reason: '脚本顶层 var 可能被外部引用，保留' })
        return
      }
      if (!isSideEffectFree(declarator.init)) {
        skipped.push({ rule: 'unused-variable', line: lineOf(node), reason: '初始化表达式可能有副作用，保留' })
        return
      }
      const removal = statementRemovalRange(code, node)
      edits.push({
        rule: 'unused-variable',
        line: lineOf(node),
        start: removal.start,
        end: removal.end,
        from: code.slice(removal.start, removal.end),
        to: '',
        reason: `${name} 声明后没有引用`,
      })
    })
  }

  /* ── 3. == → ===（进阶） ─────────────────────────────────────── */
  if (aggressive) {
    walkAst(ast, (node) => {
      if (node.type !== 'BinaryExpression') return
      if (node.operator !== '==' && node.operator !== '!=') return
      if (hasNullishOperand(node)) {
        skipped.push({
          rule: 'loose-equality',
          line: lineOf(node),
          reason: '与 null / undefined 比较通常是有意的判空，保留 ==',
        })
        return
      }
      const between = code.slice(node.left.end, node.right.start)
      const offset = between.indexOf(node.operator)
      if (offset < 0) return
      const start = node.left.end + offset
      edits.push({
        rule: 'loose-equality',
        line: lineOf(node),
        start,
        end: start + node.operator.length,
        from: node.operator,
        to: `${node.operator}=`,
        reason: '严格相等',
      })
    })
  }

  /* ── 应用编辑（从后往前，保持偏移有效） ──────────────────────── */
  const applicable = dedupeEdits(edits, skipped)
  applicable.sort((a, b) => b.start - a.start)
  let fixedCode = code
  for (const edit of applicable) {
    fixedCode = fixedCode.slice(0, edit.start) + edit.to + fixedCode.slice(edit.end)
  }
  applicable.sort((a, b) => a.start - b.start)

  return {
    ok: true,
    edits: applicable.map((edit) => ({
      rule: edit.rule,
      line: edit.line,
      from: clip(edit.from),
      to: clip(edit.to),
      reason: edit.reason,
    })),
    fixedCode,
    diff: formatUnifiedDiff(code, fixedCode, filename),
    skipped,
  }
}

/** 判空比较：任一侧是 null 字面量、undefined 标识符或 typeof。 */
function hasNullishOperand(node) {
  const isNullish = (side) => {
    if (side.type === 'Literal' && side.value === null) return true
    if (side.type === 'Identifier' && side.name === 'undefined') return true
    if (side.type === 'UnaryExpression' && side.operator === 'typeof') return true
    return false
  }
  return isNullish(node.left) || isNullish(node.right)
}

/**
 * 去掉互相重叠的编辑。范围越大越优先（删整条声明 > 换关键字），
 * 被覆盖的小编辑记进 skipped，避免同一段源码被改两次。
 */
function dedupeEdits(edits, skipped) {
  const bySize = edits
    .slice()
    .sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)
  const kept = []
  for (const edit of bySize) {
    const clash = kept.find((other) => edit.start < other.end && other.start < edit.end)
    if (clash) {
      skipped.push({
        rule: edit.rule,
        line: edit.line,
        reason: `与第 ${clash.line} 行的「${clash.rule}」改动范围重叠，已合并为一次修改`,
      })
      continue
    }
    kept.push(edit)
  }
  return kept
}

/** 删除整条语句时，把行尾的空白与换行一起带走。 */
function statementRemovalRange(code, node) {
  let end = node.end
  while (end < code.length && (code[end] === ' ' || code[end] === '\t' || code[end] === ';')) end += 1
  if (code[end] === '\r') end += 1
  if (code[end] === '\n') end += 1
  let start = node.start
  while (start > 0 && (code[start - 1] === ' ' || code[start - 1] === '\t')) start -= 1
  return { start, end }
}

const clip = (text) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > 90 ? flat.slice(0, 89) + '…' : flat
}

/** 裸文本的统一 diff：够读即可，不追求 git 级别的格式。 */
export function formatUnifiedDiff(before, after, filename = 'code.js') {
  if (before === after) return ''
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix
    && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix += 1

  const oldLines = a.slice(prefix, a.length - suffix)
  const newLines = b.slice(prefix, b.length - suffix)
  const context = 2
  const from = Math.max(0, prefix - context)
  const toOld = Math.min(a.length, a.length - suffix + context)

  const header = [
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -${from + 1},${toOld - from} +${from + 1},${newLines.length + (from - prefix) + (toOld - (a.length - suffix))} @@`,
  ]
  const body = []
  for (let index = from; index < prefix; index += 1) body.push(' ' + a[index])
  for (const line of oldLines) body.push('-' + line)
  for (const line of newLines) body.push('+' + line)
  for (let index = a.length - suffix; index < toOld; index += 1) body.push(' ' + a[index])

  return header.concat(body).join('\n')
}
