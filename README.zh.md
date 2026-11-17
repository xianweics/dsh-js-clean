# dsh-js-clean

[English](./README.md) · 中文

![license: MIT](https://img.shields.io/badge/license-MIT-green) ![node: >=20](https://img.shields.io/badge/node-%3E%3D20-blue)

## 描述

DeepSeek Harness 插件：给 JavaScript 代码打整洁度分，并把每处问题对应到《重构》里的具体手法。手法名称与 before/after 示例出自 [xianweics/refator-code](https://github.com/xianweics/refator-code) 整理的中文名录。

一条 finding 不只告诉你哪儿不舒服，还会指出**该用哪个重构手法**——`6.1 提炼函数`、`10.3 以卫语句取代嵌套条件`、`8.8 以管道取代循环`——agent 拿到就能决定改哪里、怎么改。

## 功能介绍

- **整洁度评分：** 每个文件一个 A–E 的分数
- **带改法的问题清单：** 行号、列号、说明，以及对应的重构手法
- **安全的自动修复：** 只做能证明不改行为的改写，输出统一 diff
- **名录取用：** 61 个重构手法 + 24 个代码坏味道，可按 id、章节或关键词查

## 安装

```sh
dsh plugin add dsh-js-clean
```

或从本地目录装：

```sh
dsh plugin add /path/to/dsh-js-clean
```

装完开新会话，`js_clean` 工具就绪。

## 使用

一个工具 `js_clean`，四个 action：

| action | 结果 |
| --- | --- |
| `scan` | 整洁度 A–E、逐条问题（行号 + 列号 + 改法 + 对应手法） |
| `fix` | 只做能证明不改行为的修复，输出 diff；`write: true` 才落盘，先写 `<file>.bak` |
| `explain` | 查手法 / 坏味道（`technique: "6.1"` / `"Extract Function"` / `"提炼函数"`），带目的、适用场景和代码示例 |
| `catalog` | 列名录：`chapter: "10"` 或 `keyword: "conditional"`，都不给就全列 |

```json
{ "action": "scan", "path": "src/order.js" }
{ "action": "fix", "path": "src/order.js", "write": true }
{ "action": "explain", "technique": "提炼函数" }
```

`scan` 也可以传 `code` 代替 `path`；`thresholds` 可覆盖任何阈值（`longFunctionLines`、`maxParams`、`maxComplexity` 等）。

### 规则（22 条）

过长函数 · 过长参数列表 · 嵌套过深 · 嵌套三元 · 复杂条件 · 圈复杂度过高 · 魔数 · 过长消息链 · 重复代码 · 循环里 push · 标记参数 · 未使用的变量 / 函数 / 参数 · 可变模块级绑定 · `var` · 不会再赋值的 `let` · 松散相等 · `console.*` · 过长文件 · 过大的类 · 被注释掉的代码。

评分：`100 - Σ(权重 × min(命中数, 3))`，权重 error 8 / warn 5 / info 2。A≥90，B≥75，C≥60，D≥40，其余 E。

### 名录

`lib/catalog.json` 收录 61 个重构手法（6.1–6.11、7.1–7.9、8.1–8.9、9.1–9.5、10.1–10.6、11.1–11.10、12.1–12.11）和 24 个坏味道，均从上述仓库的 README 抽取。没有对应手法的问题照常报告，名录只补「该用哪个手法」这一层。

### fix 的边界

自动改：`var`→`const`/`let`、`let`→`const`、删除初始化无副作用的未使用声明；`aggressive: true` 时才把 `==`/`!=` 改成严格相等。

有意跳过（原因写进 `skipped`）：

- 脚本顶层的 `var`（它是全局对象的属性，改写会改变可见性）
- 同名多处声明、与参数同名、声明前就被引用（`var` 提升）
- 解构声明，以及初始化可能有副作用的情况
- 同一处被两条规则同时命中——大范围优先，小编辑记为「已合并」

## 开发

```sh
pnpm install
node test/analyzer.test.mjs
```

唯一依赖是 `acorn`，其余都是 `lib/` 里的纯函数：`analyzer.mjs`（解析 + 指标 + 坏味道）、`fixes.mjs`（编辑 + diff）、`knowledge.mjs`（名录查询）、`report.mjs`（Markdown 渲染）、`index.mjs`（工具注册）。

分析器单独导出，可复用：

```js
import { analyzeSource } from 'dsh-js-clean/analyzer'

const report = analyzeSource(source, { filename: 'order.js' })
```

## 许可

MIT。手法名称与示例归 [xianweics/refator-code](https://github.com/xianweics/refator-code) 的作者；本仓库代码以 MIT 授权。
