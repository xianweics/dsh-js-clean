# 发布清单

按顺序做，最后再递交上架 PR。

## 0. 先改占位符

全文替换 `GITHUB_OWNER` 为你的 GitHub 用户名（目前出现在 `package.json`(3 处) 和 `docs/awesome-dsh-plugin-entry.yml`）：

```sh
grep -rn GITHUB_OWNER .
```

## 1. 建仓库并推送

```sh
cd dsh-js-clean
git init -b main
git add -A
git commit -m "feat: JavaScript cleanliness scanner mapped to the refactoring catalog"
gh repo create dsh-js-clean --public --source=. --push
```

没有 `gh` 就在 GitHub 网页建空仓库，再把 `origin` 指过去推。

## 2. 仓库设置（上架硬门槛）

- 加 topic：`dsh-plugin`（顺带 `deepseek-harness`、`cordis-plugin`、`refactoring`）
- 简介可以照抄 `package.json` 的 description
- 确认 **仓库创建已满 1 天**，没满就先别递 PR（满 1 天后递即可，不必补提交）

## 3. 发 npm（推荐）

```sh
npm publish --access public
```

发完 `dsh plugin add dsh-js-clean` 就能直接从 npm 装，用户不用构建、不触发 allowBuilds 授权。

## 4. 或者挂 Release tarball（不发 npm 时必需）

```sh
pnpm pack
# 把生成的 dsh-js-clean-0.2.0.tgz 重命名为不带版本的名字再传
mv dsh-js-clean-0.2.0.tgz dsh-js-clean.tgz
gh release create v0.2.0 dsh-js-clean.tgz -t v0.2.0
```

然后取消 `docs/awesome-dsh-plugin-entry.yml` 里 `tarball:` 那行的注释。文件名必须不带版本号，否则下次发版 `latest/download/` 会 404。

## 5. 递交上架 PR

- fork `awesome-dsh-plugin/awesome-dsh-plugin`
- 新增一个文件：`data/plugins/GITHUB_OWNER__dsh-js-clean.yml`，内容复制 `docs/awesome-dsh-plugin-entry.yml`
- 不要改 README（脚本生成），一个 PR 最多 3 条
- 描述里若出现「: 」（冒号+空格）必须给整句加引号，否则 YAML 会解析成嵌套键

## 6. 被要求修改时

维护者会打 `held: author` 标签。推到同一个分支 + 留**一条**评论说明改了什么即可，别重开 PR。

## 自检

```sh
pnpm install
pnpm test                              # 9 项全过
node -e "console.log(require('./package.json').dsh.bundle)"   # { patch: './cordis.patch.yml' }
pnpm pack --dry-run                    # 包里应有 lib/ cordis.patch.yml README.md LICENSE
```
