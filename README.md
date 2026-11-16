# dsh-js-clean

A DeepSeek Harness plugin that scores how clean a JavaScript file is, and names **which refactoring to apply** for every problem it finds. The technique names and before/after examples come from [xianweics/refator-code](https://github.com/xianweics/refator-code), a Chinese reading of Martin Fowler's *Refactoring: Improving the Design of Existing Code*.

Instead of a bare lint warning, most findings point at a catalog entry — `6.1 Extract Function`, `10.3 Replace Nested Conditional with Guard Clauses`, `8.8 Replace Loop with Pipeline` — so an agent reading the result knows both what is wrong and how the book says to fix it.

## Install

```sh
dsh plugin add dsh-js-clean
```

or from a checkout:

```sh
dsh plugin add /path/to/dsh-js-clean
```

Start a new session afterwards; the `js_clean` tool is registered at plugin mount.

## What it does

One tool, `js_clean`, with four actions:

| action | result |
| --- | --- |
| `scan` | cleanliness score (A–E), every finding with line + column + advice, and the refactoring each one maps to |
| `fix` | only rewrites that are provably behaviour-preserving; returns a unified diff, writes only with `write: true` and saves `<file>.bak` first |
| `explain` | looks up a technique or smell (`technique: "6.1"` / `"Extract Function"` / `"提炼函数"`) with intent, when-to-use and a code example |
| `catalog` | lists the catalog: `chapter: "10"` or `keyword: "conditional"`, otherwise everything |

```json
{ "action": "scan", "path": "src/order.js" }
{ "action": "fix", "path": "src/order.js", "write": true }
{ "action": "explain", "technique": "6.1" }
```

`scan` also accepts `code` instead of `path`. `thresholds` overrides any limit (`longFunctionLines`, `maxParams`, `maxComplexity`, …).

### Rules (22)

long function · long parameter list · deep nesting · nested ternary · complex condition · high cyclomatic complexity · magic number · long call chain · duplicate code · loop with push · flag parameter · unused variable / function / parameter · mutable module-level binding · `var` · `let` that is never reassigned · loose equality · `console.*` · long file · large class · commented-out code.

Score: `100 - Σ(weight × min(hits, 3))`, weights error 8 / warn 5 / info 2. Grades A≥90, B≥75, C≥60, D≥40, then E.

### Catalog

`lib/catalog.json` holds 61 refactoring techniques (6.1–6.11, 7.1–7.9, 8.1–8.9, 9.1–9.5, 10.1–10.6, 11.1–11.10, 12.1–12.11) and 24 code smells, extracted from that repository's README. Findings without a matching technique still report normally; the catalog only adds the "which refactoring" pointer.

### What `fix` will and will not touch

Applied automatically: `var` → `const`/`let`, `let` → `const`, and removal of unused declarations whose initializer is side-effect free. With `aggressive: true` it also rewrites `==`/`!=` to strict equality.

Deliberately skipped, with the reason in `skipped`:

- a `var` at script top level (it is a property of the global object; rewriting changes visibility)
- a name declared more than once, shadowing a parameter, or referenced before its declaration (`var` hoisting)
- destructuring patterns, initializers that may have side effects
- any location hit by two rules at once — the larger edit wins and the smaller one is reported as merged

## Development

```sh
pnpm install
node test/analyzer.test.mjs
```

Only dependency is `acorn`. Everything else is a plain function in `lib/`: `analyzer.mjs` (parse + metrics + smells), `fixes.mjs` (edits + diff), `knowledge.mjs` (catalog queries), `report.mjs` (Markdown rendering), `index.mjs` (tool registration).

The analyzer is exported separately for reuse:

```js
import { analyzeSource } from 'dsh-js-clean/analyzer'

const report = analyzeSource(source, { filename: 'order.js' })
```

## 中文说明

给 DeepSeek Harness 用的 JavaScript 代码整洁度体检插件。规则出自 [xianweics/refator-code](https://github.com/xianweics/refator-code) 整理的《重构》中文名录。

一条 finding 不只告诉你哪儿不舒服，还会指出**该用哪个重构手法**（6.1 提炼函数 / 10.3 以卫语句取代嵌套条件……），agent 拿到就能决定改哪里、怎么改。

### 装

```sh
dsh plugin add dsh-js-clean
```

装完开新会话，`js_clean` 工具就绪。

### 用

```json
{ "action": "scan", "path": "src/order.js" }
{ "action": "fix", "path": "src/order.js", "write": true }
{ "action": "explain", "technique": "提炼函数" }
```

- `scan`：整洁度 A–E、逐条问题（行号 + 改法 + 对应手法）
- `fix`：只做能证明不改行为的修复，输出 diff；`write: true` 才落盘，先写 `.bak`
- `explain`：查手法 / 坏味道，带目的、适用场景和 before-after
- `catalog`：列名录，可按 `chapter` 或 `keyword` 过滤

### fix 的边界

自动改：`var`→`const/let`、`let`→`const`、删除无副作用的未使用声明；`aggressive: true` 时才把 `==` 改成 `===`。

跳过并说明原因：脚本顶层 `var`、同名多声明 / 与参数同名 / 声明前就被引用、解构声明、初始化可能有副作用、同一处被两条规则同时命中。

### 测试

```sh
node test/analyzer.test.mjs
```

## License

MIT. Technique names and examples belong to the authors of [xianweics/refator-code](https://github.com/xianweics/refator-code); this repository's code is MIT-licensed.
