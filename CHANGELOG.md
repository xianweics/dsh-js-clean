# Changelog

## 0.2.1

- Docs only: README split into `README.md` (English) and `README.zh.md` (Chinese), with a language switch at the top; both files ship in the package.

## 0.2.0

First public release.

- `js_clean` tool with four actions: `scan`, `fix`, `explain`, `catalog`.
- 22 rules over acorn AST: long function, long parameter list, deep nesting, nested ternary, complex condition, high complexity, magic number, long call chain, duplicate code, loop push, flag parameter, unused variable/function/parameter, mutable module-level binding, `var`, redundant `let`, loose equality, `console.*`, long file, large class, commented-out code.
- Cleanliness score A–E with per-rule caps.
- Behaviour-preserving autofixes: `var` → `const`/`let`, `let` → `const`, side-effect-free unused declarations; strict-equality rewrite behind `aggressive`.
- Refactoring catalog extracted from [xianweics/refator-code](https://github.com/xianweics/refator-code): 61 techniques, 24 smells, 59 before/after examples.
- Overlapping edits are merged instead of corrupting the output; skipped rewrites report why.

## 0.1.0

Internal build used during development.
