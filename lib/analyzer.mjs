/**
 * dsh-js-clean / lib/analyzer.mjs
 *
 * 纯函数分析器：喂一段 JavaScript 源码，吐一份「整洁度体检报告」。
 * 规则的选择与命名对着 xianweics/refator-code 里的《重构》名录：每一条
 * finding 都挂上它指向的重构手法（catalog.json 里的 technique id），
 * 这样模型看到的不是一条 lint 报错，而是「坏味道 → 该用哪个手法」。
 *
 * 这里刻意不依赖任何 lint 框架：acorn 只负责把源码变成 AST，剩下的
 * 度量与坏味道识别都是本文件自己算的，输出稳定、可测、无网络。
 */

import { parse } from 'acorn'

/** 严重度排序，用于 --minSeverity 过滤。 */
export const SEVERITY_RANK = { info: 0, warn: 1, error: 2 }

/** 评分扣分权重：越严重扣得越多。 */
const SEVERITY_WEIGHT = { error: 8, warn: 5, info: 2 }

/** 每条规则最多报几条，避免一条规则刷屏把报告淹掉。 */
export const MAX_PER_RULE = 20

/**
 * 规则表。severity 是默认严重度；technique 指向 catalog.json 的 technique id；
 * smell 指向坏味道 id；advice 是给人看的一句話改法。
 */
export const RULES = {
  'long-function': {
    severity: 'warn',
    title: '函数过长',
    technique: '6.1',
    smell: 'long-function',
    advice: '把其中一段有独立意图的语句提炼成新函数，用名字代替注释。',
  },
  'long-param-list': {
    severity: 'warn',
    title: '参数列表过长',
    technique: '6.8',
    smell: 'long-parameter-list',
    advice: '把常一起出现的参数收进一个参数对象，调用方也更好读。',
  },
  'deep-nesting': {
    severity: 'warn',
    title: '嵌套过深',
    technique: '10.3',
    smell: 'long-function',
    advice: '用卫语句提前 return，把主流程拉回第一层缩进。',
  },
  'nested-ternary': {
    severity: 'warn',
    title: '三元表达式套娃',
    technique: '10.1',
    smell: 'long-function',
    advice: '拆成 if / 提前 return，或把每个分支提炼成独立函数。',
  },
  'complex-condition': {
    severity: 'info',
    title: '条件表达式过于复杂',
    technique: '10.1',
    smell: 'long-function',
    advice: '把条件拆成命名的布尔变量或提炼成 isXxx() 查询函数。',
  },
  'high-complexity': {
    severity: 'warn',
    title: '圈复杂度过高',
    technique: '6.1',
    smell: 'long-function',
    advice: '按决策点切分，一个函数只留一条主线。',
  },
  'magic-number': {
    severity: 'info',
    title: '魔法数字',
    technique: '6.3',
    smell: null,
    advice: '提成具名常量（const TIMEOUT_MS = 30000），名字说明它的含义。',
  },
  'long-call-chain': {
    severity: 'info',
    title: '过长的消息链',
    technique: '7.7',
    smell: 'message-chains',
    advice: '在链的起点加一个委托方法，把 a.b().c().d() 收成 a.d()。',
  },
  'duplicate-code': {
    severity: 'warn',
    title: '重复代码',
    technique: '6.1',
    smell: 'duplicate-code',
    advice: '把重复的语句块提炼成一个函数，两处都改成调用它。',
  },
  'loop-push': {
    severity: 'info',
    title: '循环里手动 push',
    technique: '8.8',
    smell: 'loops',
    advice: '换成 map / filter / reduce 管道，循环变量与 push 一起消失。',
  },
  'flag-param': {
    severity: 'info',
    title: '标记参数',
    technique: '11.3',
    smell: null,
    advice: '把布尔开关拆成两个语义明确的函数，调用方不用记住 true 的含义。',
  },
  'unused-variable': {
    severity: 'warn',
    title: '未使用的变量',
    technique: '8.9',
    smell: null,
    advice: '删掉它；如果是以后要用的，先删，需要时再写回来。',
  },
  'unused-function': {
    severity: 'info',
    title: '未使用的函数',
    technique: '8.9',
    smell: null,
    advice: '确认没有外部引用后删除，死代码会随时间长成陷阱。',
  },
  'unused-param': {
    severity: 'info',
    title: '未使用的参数',
    technique: '6.5',
    smell: null,
    advice: '从签名里去掉；调用方传的多余实参也一并清掉。',
  },
  'mutable-global': {
    severity: 'warn',
    title: '可变的模块级变量',
    technique: '6.6',
    smell: 'global-data',
    advice: '收进一个对象或模块，只暴露读函数与受控的写函数。',
  },
  'var-usage': {
    severity: 'info',
    title: '使用 var 声明',
    technique: null,
    smell: 'mutable-data',
    advice: '换成 const（不再重新赋值）或 let，块级作用域更不容易出错。',
  },
  'let-to-const': {
    severity: 'info',
    title: 'let 可以改成 const',
    technique: null,
    smell: 'mutable-data',
    advice: '声明后没再重新赋值，用 const 表达「这个绑定不会变」。',
  },
  'loose-equality': {
    severity: 'warn',
    title: '松散相等 ==',
    technique: null,
    smell: null,
    advice: '改用 === / !==；确实要判空时写成 x == null 并加注释说明。',
  },
  'console-call': {
    severity: 'info',
    title: '遗留的 console 调用',
    technique: null,
    smell: null,
    advice: '换成项目里的 logger，或删掉调试输出。',
  },
  'long-file': {
    severity: 'info',
    title: '文件过大',
    technique: '7.5',
    smell: 'large-class',
    advice: '按职责拆成多个模块，一个文件只讲一件事。',
  },
  'big-class': {
    severity: 'warn',
    title: '类过大',
    technique: '7.5',
    smell: 'large-class',
    advice: '把一组总是一起变化的方法与字段提取成新类。',
  },
  'commented-out-code': {
    severity: 'info',
    title: '注释掉的代码',
    technique: '8.9',
    smell: null,
    advice: '直接删除；版本控制记得住，注释记不住。',
  },
}

/** 阈值默认值，可通过 tools 参数 thresholds 覆盖。 */
export const DEFAULT_THRESHOLDS = {
  longFunctionLines: 40,
  longFunctionStatements: 20,
  maxParams: 3,
  maxNesting: 3,
  maxConditionTerms: 3,
  maxChainDepth: 4,
  maxComplexity: 10,
  maxFileLines: 400,
  maxClassMethods: 10,
  duplicateMinStatements: 3,
  duplicateMinChars: 120,
  magicAllow: [0, 1, 2, 10, 100, 1000],
}

/* ────────────────────────────── AST 基础设施 ────────────────────────────── */

const NON_CHILD_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'raw', 'regex'])

/** 遍历一个节点的直接子节点（只认带 type 的对象）。 */
export function eachChild(node, visit) {
  for (const key of Object.keys(node)) {
    if (NON_CHILD_KEYS.has(key)) continue
    const value = node[key]
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && typeof item.type === 'string') visit(item, key)
      }
    } else if (typeof value === 'object' && typeof value.type === 'string') {
      visit(value, key)
    }
  }
}

/** 深度优先遍历；visit 返回 false 时不再深入该子树。 */
export function walkAst(node, visit, parent = null, key = null, ancestors = []) {
  if (!node || typeof node.type !== 'string') return
  if (visit(node, parent, key, ancestors) === false) return
  const next = ancestors.length === 0 ? [node] : ancestors.concat(node)
  eachChild(node, (child, childKey) => walkAst(child, visit, node, childKey, next))
}

/** 把解构模式里的所有绑定名收进 out。 */
export function collectPatternNames(pattern, out = []) {
  if (!pattern) return out
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern)
      break
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') collectPatternNames(prop.argument, out)
        else collectPatternNames(prop.value, out)
      }
      break
    case 'ArrayPattern':
      for (const element of pattern.elements) collectPatternNames(element, out)
      break
    case 'RestElement':
      collectPatternNames(pattern.argument, out)
      break
    case 'AssignmentPattern':
      collectPatternNames(pattern.left, out)
      break
    default:
      break
  }
  return out
}

export const lineOf = (node) => (node.loc ? node.loc.start.line : 0)
export const columnOf = (node) => (node.loc ? node.loc.start.column + 1 : 0)

/** 单行摘要：把片段压成一行，供报告里定位用。 */
export function snippetOf(code, node, max = 110) {
  const raw = code.slice(node.start, node.end).replace(/\s+/g, ' ').trim()
  return raw.length > max ? raw.slice(0, max - 1) + '…' : raw
}

/* ─────────────────────────────── 语法解析 ─────────────────────────────── */

/**
 * 解析源码。先按 module 试，再按 script 试（供 CommonJS 与带 return 的文件用）。
 * 失败时抛出带 line/column 的 PARSE_ERROR，让上层把它当成一条 error finding 报出去。
 */
export function parseSource(code) {
  const attempts = []
  for (const sourceType of ['module', 'script']) {
    const comments = []
    try {
      const ast = parse(code, {
        ecmaVersion: 'latest',
        sourceType,
        locations: true,
        allowHashBang: true,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: sourceType === 'script',
        onComment: comments,
      })
      return { ast, comments, sourceType }
    } catch (error) {
      attempts.push(`${sourceType}: ${error.message}`)
    }
  }
  const error = new Error(`无法解析这段 JavaScript（${attempts.join('；')}）`)
  error.code = 'PARSE_ERROR'
  throw error
}

/* ──────────────────────────── 函数体内部度量 ──────────────────────────── */

const FUNC_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/**
 * 在函数体内部统计圈复杂度与最大嵌套深度；遇到内层函数就停，
 * 因为内层函数的复杂度是它自己那条 finding 的事。
 */
function scanBody(bodyNode) {
  let complexity = 0
  let maxDepth = 0

  const visit = (node, depth) => {
    let inner = depth
    switch (node.type) {
      case 'IfStatement':
        complexity += 1
        inner = depth + 1
        break
      case 'ConditionalExpression':
      case 'LogicalExpression':
        complexity += 1
        break
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
      case 'WhileStatement':
      case 'DoWhileStatement':
        complexity += 1
        inner = depth + 1
        break
      case 'SwitchCase':
        if (node.test) complexity += 1
        break
      case 'CatchClause':
      case 'TryStatement':
        inner = depth + 1
        break
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return // 内层函数：交给它自己的度量
      default:
        break
    }
    if (inner > maxDepth) maxDepth = inner
    eachChild(node, (child) => visit(child, inner))
  }

  visit(bodyNode, 0)
  return { complexity, maxDepth }
}

/** 数条件表达式里参与判断的项数（&& / || 的数量 + 1）。 */
function conditionTerms(node) {
  let terms = 1
  walkAst(node, (child) => {
    if (child.type === 'LogicalExpression') terms += 1
    if (FUNC_TYPES.has(child.type)) return false
    return true
  })
  return terms
}

/** 取函数名：声明看 id，方法看 key，匿名箭头看它绑给了谁。 */
function functionName(node, parent, code) {
  if (node.id && node.id.name) return node.id.name
  if (parent) {
    if ((parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key) {
      return parent.key.name || parent.key.value || '<method>'
    }
    if (parent.type === 'Property' && parent.key && parent.key.type === 'Identifier') {
      return parent.key.name
    }
    if (parent.type === 'VariableDeclarator' && parent.id && parent.id.type === 'Identifier') {
      return parent.id.name
    }
    if (parent.type === 'AssignmentExpression' && parent.left.type === 'Identifier') {
      return parent.left.name
    }
  }
  const head = code.slice(node.start, Math.min(node.start + 40, node.end)).replace(/\s+/g, ' ')
  return head ? head.slice(0, 24) : '<anonymous>'
}

/** 取函数体里的语句数组；箭头函数的表达式体算 1 条。 */
function statementList(body) {
  if (!body) return []
  if (body.type === 'BlockStatement') return body.body
  return [body]
}

/* ────────────────────────────── 主分析入口 ────────────────────────────── */

/**
 * 分析一段 JavaScript 源码。
 *
 * @param {string} code 源码
 * @param {{ thresholds?: object, minSeverity?: 'info'|'warn'|'error', filename?: string }} [options]
 * @returns 结构化报告（可直接 JSON 化，作为工具输出）
 */
export function analyzeSource(code, options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) }
  const minSeverity = options.minSeverity || 'info'
  const filename = options.filename || null

  const lines = code.split(/\r?\n/)
  const lineCount = lines.length
  const blankLines = lines.filter((line) => line.trim() === '').length

  let parsed
  try {
    parsed = parseSource(code)
  } catch (error) {
    return {
      ok: false,
      file: { path: filename, lines: lineCount },
      error: { code: error.code || 'PARSE_ERROR', message: error.message },
      findings: [],
      score: 0,
      grade: 'F',
    }
  }

  const { ast, comments, sourceType } = parsed

  /* 注释行统计 + 注释掉的代码 */
  const commentLines = new Set()
  for (const comment of comments) {
    if (!comment.loc) continue
    for (let line = comment.loc.start.line; line <= comment.loc.end.line; line += 1) commentLines.add(line)
  }

  /* ── 第一遍：结构事实 ───────────────────────────────────────────── */
  const declared = new Map() // name -> [{ node, kind, line }]
  const functionFacts = []
  const classFacts = []
  const looseEqualNodes = []
  const consoleNodes = []
  const magicNumberNodes = []
  const complexConditionNodes = []
  const chainNodes = []
  const loopPushNodes = []
  const ternaryNodes = []
  const exportedNames = new Set()
  const declarationNodes = new Map() // Identifier node -> { kind, name }

  const declare = (pattern, kind) => {
    for (const id of collectPatternNames(pattern)) {
      declarationNodes.set(id, { kind, name: id.name })
      const list = declared.get(id.name) || []
      list.push({ node: id, kind, line: lineOf(id) })
      declared.set(id.name, list)
    }
  }

  walkAst(ast, (node, parent) => {
    switch (node.type) {
      case 'VariableDeclaration':
        for (const declarator of node.declarations) declare(declarator.id, node.kind)
        break
      case 'FunctionDeclaration':
        if (node.id) declare(node.id, 'function')
        break
      case 'ClassDeclaration':
        if (node.id) declare(node.id, 'class')
        break
      case 'ImportSpecifier':
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
        declare(node.local, 'import')
        break
      case 'CatchClause':
        if (node.param) declare(node.param, 'catch')
        break
      case 'ExportSpecifier':
        if (node.local && node.local.type === 'Identifier') exportedNames.add(node.local.name)
        break
      case 'ExportDefaultDeclaration':
        if (node.declaration) {
          if (node.declaration.type === 'Identifier') exportedNames.add(node.declaration.name)
          else if (node.declaration.id) exportedNames.add(node.declaration.id.name)
        }
        break
      case 'ExportNamedDeclaration':
        if (node.declaration && node.declaration.type === 'VariableDeclaration') {
          for (const declarator of node.declaration.declarations) {
            for (const id of collectPatternNames(declarator.id)) exportedNames.add(id.name)
          }
        }
        if (node.declaration && (node.declaration.type === 'FunctionDeclaration'
          || node.declaration.type === 'ClassDeclaration') && node.declaration.id) {
          exportedNames.add(node.declaration.id.name)
        }
        break
      default:
        break
    }

    if (FUNC_TYPES.has(node.type)) {
      const params = node.params || []
      for (const param of params) declare(param, 'param')
      functionFacts.push({ node, parent, name: functionName(node, parent, code), params })
      return
    }

    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      classFacts.push({ node, methods: (node.body.body || []).length })
      return
    }

    if (node.type === 'BinaryExpression' && (node.operator === '==' || node.operator === '!=')) {
      looseEqualNodes.push({ node, parent })
      return
    }

    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const object = node.callee.object
      if (object.type === 'Identifier' && object.name === 'console' && !node.callee.computed) {
        consoleNodes.push(node)
      }
    }

    if ((node.type === 'IfStatement' || node.type === 'WhileStatement' || node.type === 'ConditionalExpression')
      && node.test) {
      if (conditionTerms(node.test) > thresholds.maxConditionTerms) complexConditionNodes.push(node)
    }

    if (node.type === 'ConditionalExpression') {
      const hasNested = (branch) => branch && branch.type === 'ConditionalExpression'
      if (hasNested(node.consequent) || hasNested(node.alternate)) ternaryNodes.push(node)
    }

    if (node.type === 'MemberExpression' && (!parent || parent.type !== 'MemberExpression')) {
      let depth = 0
      let cursor = node
      while (cursor && cursor.type === 'MemberExpression') {
        depth += 1
        cursor = cursor.object
      }
      if (depth >= thresholds.maxChainDepth) chainNodes.push({ node, depth })
    }

    if (node.type === 'ForStatement' || node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
      const statements = node.body && node.body.type === 'BlockStatement' ? node.body.body : [node.body]
      const pushOnly = statements.length > 0 && statements.every((statement) => {
        if (!statement || statement.type !== 'ExpressionStatement') return false
        const expr = statement.expression
        return expr && expr.type === 'CallExpression' && expr.callee.type === 'MemberExpression'
          && !expr.callee.computed && expr.callee.property.name === 'push'
      })
      if (pushOnly) loopPushNodes.push(node)
    }

    if (node.type === 'Literal' && typeof node.value === 'number') {
      const isNamedConst = parent && parent.type === 'VariableDeclarator' && parent.init === node
        && parent.id && parent.id.type === 'Identifier'
      const isKey = parent && (parent.type === 'Property' || parent.type === 'MethodDefinition') && parent.key === node
      const isComputedIndex = parent && parent.type === 'MemberExpression' && parent.property === node
      if (!isNamedConst && !isKey && !isComputedIndex) magicNumberNodes.push({ node, parent })
    }
  })

  /* ── 第二遍：引用计数（保守口径：同名出现即算用过） ──────────────── */
  const referenced = new Set()
  walkAst(ast, (node, parent, key) => {
    if (node.type !== 'Identifier') return
    if (declarationNodes.has(node)) return
    if (parent) {
      if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return
      /* 对象字面量的 `{ x }` 简写里，key 与 value 是同一个节点——那是一次引用，不是属性名 */
      if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition')
        && key === 'key' && !parent.computed && !parent.shorthand) return
      if ((parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement')
        && key === 'label') return
      if (parent.type === 'ExportSpecifier' && key === 'exported') return
      if (parent.type === 'ImportSpecifier' && key === 'imported') return
    }
    referenced.add(node.name)
  })

  /* ── 生成 findings ────────────────────────────────────────────── */
  const findings = []
  const add = (rule, node, extra = {}) => {
    const spec = RULES[rule]
    if (!spec) return
    findings.push({
      rule,
      severity: extra.severity || spec.severity,
      title: spec.title,
      line: lineOf(node),
      column: columnOf(node),
      message: extra.message || spec.advice,
      advice: spec.advice,
      technique: spec.technique,
      smell: spec.smell,
      snippet: snippetOf(code, node),
      ...(extra.detail ? { detail: extra.detail } : {}),
    })
  }

  for (const fact of functionFacts) {
    const { node, params, name } = fact
    const bodyLineSpan = node.loc ? node.loc.end.line - node.loc.start.line + 1 : 0
    const statements = statementList(node.body)
    const bodyMetrics = node.body ? scanBody(node.body) : { complexity: 0, maxDepth: 0 }

    fact.lineSpan = bodyLineSpan
    fact.statements = statements.length
    fact.complexity = bodyMetrics.complexity
    fact.maxDepth = bodyMetrics.maxDepth

    if (bodyLineSpan > thresholds.longFunctionLines || statements.length > thresholds.longFunctionStatements) {
      add('long-function', node, {
        message: `函数 ${name} 有 ${bodyLineSpan} 行 / ${statements.length} 条语句，超过 ${thresholds.longFunctionLines} 行或 ${thresholds.longFunctionStatements} 条：挑出其中一段独立意图提炼成新函数。`,
      })
    }
    if (params.length > thresholds.maxParams) {
      add('long-param-list', node, {
        message: `函数 ${name} 有 ${params.length} 个参数（阈值 ${thresholds.maxParams}）：把常一起出现的参数收进一个参数对象。`,
      })
    }
    if (bodyMetrics.maxDepth > thresholds.maxNesting) {
      add('deep-nesting', node, {
        message: `函数 ${name} 最深层嵌套 ${bodyMetrics.maxDepth} 层（阈值 ${thresholds.maxNesting}）：用卫语句提前 return。`,
      })
    }
    if (bodyMetrics.complexity > thresholds.maxComplexity) {
      add('high-complexity', node, {
        message: `函数 ${name} 圈复杂度约 ${bodyMetrics.complexity}（阈值 ${thresholds.maxComplexity}）：按决策点切分。`,
      })
    }

    /* 参数用没用、是不是标记参数 */
    const paramNames = new Set()
    for (const param of params) for (const id of collectPatternNames(param)) paramNames.add(id.name)
    const usedParams = new Set()
    const flagCandidates = new Map()
    if (node.body) {
      walkAst(node.body, (child, parent) => {
        if (child.type !== 'Identifier' || !paramNames.has(child.name)) return
        usedParams.add(child.name)
        const isTest = parent && (parent.type === 'IfStatement' || parent.type === 'WhileStatement'
          || parent.type === 'ConditionalExpression' || parent.type === 'LogicalExpression')
          && parent.test === child
        const negatedWrapper = parent && parent.type === 'UnaryExpression' && parent.operator === '!'
        if (isTest || negatedWrapper) {
          const list = flagCandidates.get(child.name) || []
          list.push(child)
          flagCandidates.set(child.name, list)
        }
      })
    }
    for (const paramName of paramNames) {
      if (paramName.startsWith('_')) continue
      if (!usedParams.has(paramName)) {
        add('unused-param', node, { message: `函数 ${name} 的参数 ${paramName} 没有用到。` })
        continue
      }
      const tests = flagCandidates.get(paramName)
      const onlyAsFlag = tests && tests.length === 1 && !referencedFlagAsValue(node.body, paramName)
      if (onlyAsFlag) {
        add('flag-param', node, {
          severity: 'info',
          message: `函数 ${name} 的布尔参数 ${paramName} 只用来分支：考虑拆成两个函数。`,
        })
      }
    }
  }

  /* 变量/函数未使用 */
  for (const [name, records] of declared) {
    if (name === 'arguments' || name.startsWith('_')) continue
    if (exportedNames.has(name) || referenced.has(name)) continue
    const record = records[0]
    if (records.some((item) => item.kind === 'import')) continue
    if (records.some((item) => item.kind === 'param')) continue
    if (record.kind === 'function') {
      add('unused-function', record.node, { message: `函数 ${name} 在本文件内没有被引用。` })
    } else if (record.kind === 'class') {
      add('unused-function', record.node, { message: `类 ${name} 在本文件内没有被引用。` })
    } else {
      add('unused-variable', record.node, {
        message: `变量 ${name} 声明后没有被引用（同名的引用也没有），确认后删除。`,
      })
    }
  }

  /* var / 松散相等 / console / 魔法数字 等 */
  walkAst(ast, (node) => {
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
      add('var-usage', node)
    }
  })
  for (const { node } of looseEqualNodes) {
    add('loose-equality', node, {
      message: `这里用了松散相等 ${node.operator}：改成 ${node.operator === '==' ? '===' : '!=='} 更不容易出意外。`,
    })
  }
  for (const node of consoleNodes) add('console-call', node)
  for (const { node } of magicNumberNodes) {
    if (thresholds.magicAllow.includes(node.value)) continue
    add('magic-number', node, {
      message: `字面量 ${node.raw} 直接写在逻辑里：提成具名常量，名字说明它的含义。`,
    })
  }
  for (const node of complexConditionNodes) {
    add('complex-condition', node, {
      message: `这个条件有 ${conditionTerms(node.test)} 项判断：提炼成命名的布尔变量。`,
    })
  }
  for (const node of ternaryNodes) add('nested-ternary', node)
  for (const { node, depth } of chainNodes) {
    add('long-call-chain', node, {
      message: `消息链深度 ${depth}：给起点加一个委托方法把链收短。`,
    })
  }
  for (const node of loopPushNodes) {
    add('loop-push', node, {
      message: '循环体只有 push：用 map / filter / reduce 取代整个循环。',
    })
  }

  /* 重复代码：同一文件里逐条语句窗口比对 */
  for (const group of findDuplicateBlocks(code, functionFacts, thresholds)) {
    add('duplicate-code', group.node, {
      message: `这段 ${group.statements} 条语句与第 ${group.firstLine} 行的代码几乎相同：提炼成一个函数，两处都调用。`,
    })
  }

  /* 类 / 文件规模 */
  for (const fact of classFacts) {
    if (fact.methods > thresholds.maxClassMethods) {
      add('big-class', fact.node, {
        message: `这个类有 ${fact.methods} 个成员（阈值 ${thresholds.maxClassMethods}）：把总是一起变化的一组方法提取成新类。`,
      })
    }
  }
  if (lineCount > thresholds.maxFileLines) {
    add('long-file', ast, {
      message: `文件 ${lineCount} 行（阈值 ${thresholds.maxFileLines}）：按职责拆成多个模块。`,
      severity: 'info',
    })
  }

  /* 模块级可变全局 */
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration') continue
    if (statement.kind === 'const') continue
    add('mutable-global', statement, {
      message: `模块级 ${statement.kind} 变量：把它封装进对象，只暴露读函数与受控的写函数。`,
    })
  }

  /* 注释掉的代码：连续注释块里出现语句特征 */
  const commentedOut = findCommentedOutCode(comments, commentLines)
  for (const item of commentedOut) {
    add('commented-out-code', item.node, {
      message: '这一块注释看起来是注释掉的代码：直接删掉，需要时从版本历史里找回来。',
      severity: 'info',
    })
  }

  /* ── 汇总 ──────────────────────────────────────────────────────── */
  const filtered = findings.filter((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[minSeverity])
  const capped = []
  const perRule = new Map()
  for (const finding of filtered) {
    const count = perRule.get(finding.rule) || 0
    perRule.set(finding.rule, count + 1)
    if (count < MAX_PER_RULE) capped.push(finding)
  }
  capped.sort((a, b) => (b.severity === a.severity
    ? a.line - b.line
    : SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]))

  const bySeverity = { error: 0, warn: 0, info: 0 }
  for (const finding of capped) bySeverity[finding.severity] += 1

  let penalty = 0
  for (const [rule, count] of perRule) {
    const weight = SEVERITY_WEIGHT[RULES[rule] ? RULES[rule].severity : 'info'] || 2
    penalty += weight * Math.min(count, 3)
  }
  const score = Math.max(0, Math.min(100, 100 - penalty))

  const functionCount = functionFacts.length
  const maxFunctionLines = functionFacts.reduce((max, fact) => Math.max(max, fact.lineSpan || 0), 0)
  const metrics = {
    lines: lineCount,
    codeLines: lineCount - blankLines - commentLines.size,
    commentLines: commentLines.size,
    blankLines,
    functions: functionCount,
    longestFunction: maxFunctionLines,
    totalComplexity: functionFacts.reduce((sum, fact) => sum + (fact.complexity || 0), 0),
    maxNesting: functionFacts.reduce((max, fact) => Math.max(max, fact.maxDepth || 0), 0),
  }

  /* 下一步建议：按「技法出现次数」排序，给出最该先动的那几个手法 */
  const techniqueCounts = new Map()
  for (const finding of capped) {
    if (!finding.technique) continue
    techniqueCounts.set(finding.technique, (techniqueCounts.get(finding.technique) || 0) + 1)
  }
  const nextSteps = [...techniqueCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([technique, count]) => ({ technique, count }))

  return {
    ok: true,
    file: { path: filename, sourceType, lines: lineCount },
    score,
    grade: gradeOf(score),
    metrics,
    counts: { bySeverity, byRule: Object.fromEntries(perRule), total: filtered.length },
    findings: capped,
    nextSteps,
  }
}

/** 是否有把参数当值用（不只是当开关）。 */
function referencedFlagAsValue(body, name) {
  let asValue = false
  walkAst(body, (node, parent) => {
    if (node.type !== 'Identifier' || node.name !== name) return
    const isTest = parent && (parent.type === 'IfStatement' || parent.type === 'WhileStatement'
      || parent.type === 'ConditionalExpression' || parent.type === 'LogicalExpression') && parent.test === node
    const negated = parent && parent.type === 'UnaryExpression' && parent.operator === '!'
    if (!isTest && !negated) asValue = true
  })
  if (asValue) return true
  /* 只要该名字出现在调用实参里，就是「按值传」的标记参数——仍然算标记参数，
     但我们要避免把 `fn(a ? 1 : 2)` 这种误判成标记参数，所以这里保守返回 true。 */
  let passed = false
  walkAst(body, (node) => {
    if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return
    for (const arg of node.arguments) {
      if (arg.type === 'Identifier' && arg.name === name) passed = true
    }
  })
  return passed
}

/** 分数映射成档位。 */
export function gradeOf(score) {
  if (score >= 90) return 'A'
  if (score >= 75) return 'B'
  if (score >= 60) return 'C'
  if (score >= 40) return 'D'
  return 'E'
}

/**
 * 在同一文件里找重复语句块。
 *
 * 只看函数体的直接子语句（不递归进内层函数，避免把内层函数当成重复），
 * 用「连续 N 条语句的规范化文本」做签名；两处签名相同就从前缀开始向后
 * 贪心延长，报最长的那个块。跨函数才算重复——同一个函数里相邻语句相似
 * 通常不是坏味道，而是排版。
 */
function findDuplicateBlocks(code, functionFacts, thresholds) {
  const bodies = []
  for (const fact of functionFacts) {
    const statements = statementList(fact.node.body)
    if (statements.length < thresholds.duplicateMinStatements) continue
    bodies.push({
      statements,
      texts: statements.map((statement) => code.slice(statement.start, statement.end).replace(/\s+/g, ' ').trim()),
    })
  }

  const windowSize = thresholds.duplicateMinStatements
  const buckets = new Map()
  for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex += 1) {
    const { texts } = bodies[bodyIndex]
    for (let start = 0; start + windowSize <= texts.length; start += 1) {
      const signature = texts.slice(start, start + windowSize).join('\u0000')
      const list = buckets.get(signature) || []
      list.push({ body: bodyIndex, start })
      buckets.set(signature, list)
    }
  }

  const groups = []
  for (const occurrences of buckets.values()) {
    if (occurrences.length < 2) continue
    const sorted = occurrences.slice().sort((a, b) => (a.body - b.body) || (a.start - b.start))
    const first = sorted[0]
    const second = sorted[1]
    if (first.body === second.body) continue
    const textsA = bodies[first.body].texts
    const textsB = bodies[second.body].texts

    let size = windowSize
    while (first.start + size < textsA.length && second.start + size < textsB.length
      && textsA[first.start + size] === textsB[second.start + size]) size += 1

    const joined = textsA.slice(first.start, first.start + size).join(' ')
    if (joined.length < thresholds.duplicateMinChars) continue

    const nodeA = bodies[first.body].statements[first.start]
    const nodeB = bodies[second.body].statements[second.start]
    const lastA = bodies[first.body].statements[first.start + size - 1]
    groups.push({
      node: nodeB,
      firstLine: lineOf(nodeA),
      statements: size,
      rangeStart: nodeA.start,
      rangeEnd: lastA.end,
    })
  }

  groups.sort((a, b) => (b.statements - a.statements) || (a.rangeStart - b.rangeStart))
  const kept = []
  for (const group of groups) {
    if (kept.some((item) => group.rangeStart >= item.rangeStart && group.rangeStart < item.rangeEnd)) continue
    kept.push(group)
  }
  return kept.slice(0, 5)
}

/** 注释掉的代码：连续注释块，且去注释符后看起来像语句。 */
function findCommentedOutCode(comments, commentLines) {
  const results = []
  let block = []
  const flush = () => {
    if (block.length >= 3) {
      const text = block.map((comment) => comment.value).join('\n')
      const looksLikeCode = /[;=]\s*$|=>|\b(function|const|let|return|if\s*\(|for\s*\()/.test(text)
      if (looksLikeCode) {
        results.push({ node: block[0], line: block[0].loc.start.line })
      }
    }
    block = []
  }
  for (const comment of comments) {
    if (comment.type !== 'Line') {
      flush()
      continue
    }
    const previous = block[block.length - 1]
    if (previous && comment.loc.start.line === previous.loc.end.line + 1) block.push(comment)
    else {
      flush()
      block.push(comment)
    }
  }
  flush()
  return results
}
