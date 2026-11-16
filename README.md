# Paper Lens

在 DSH 里读论文：右侧边栏打开 PDF，划词就能翻译、引用、批注——不用切窗口，不用复制粘贴到别处。

A PDF reading plugin for [DeepSeek Harness](https://github.com/deepseek-ai): open a paper in the right sidebar, select text to translate, quote it into the chat, or annotate it.

- **右侧边栏读 PDF**：pdf.js 渲染，缩放 / 适宽 / 页码跳转，跨页连续滚动。切走再切回，停在你离开的那一行（不是页首）。
- **划词翻译**：只出译文，流式显示；长段落自动并行，译文按模型与原文缓存在本机。
- **划词引用**：把选中段落带页码写进对话（`p.2–3` 这种跨页范围也对），页眉、版权横幅、页码标签会被剔掉。
- **批注**：四种颜色高亮，可写文字、可拖动、在边栏里统一查看与定位；批注和 PDF 放在一起，跟着文件走。
- **引用链接**：模型写出的 `[main.pdf p.7 "exact words"]` 会变成可点链接，点开跳到该页并高亮原句。

## 安装

插件就是一个 npm 包，有两种装法。

**本地目录（开发或自用）**：在 DSH 里打开 **设置 → 插件 → 添加插件**，填仓库目录的完整路径（`package.json` 所在目录，不是 `lib/client.js`）。改完代码后需要重启 DSH，客户端改动还要重新构建（`npm run build`）。

**从 npm 安装（发布后）**：

```powershell
dsh plugin --profile desktop add dsh-paper-lens
```

然后重启 DSH。服务端代码在宿主进程里加载，改完必须重启才能生效。

## 翻译引擎

三种引擎互斥，只有选中的那一种生效；设置面板里会显示「当前生效：provider / model」，不用猜。

| 引擎 | 行为 | 凭据 |
|---|---|---|
| 跟随会话（默认） | 用当前会话实际路由的模型 | 宿主管理，插件不接触 |
| 指定模型 | 仍走宿主模型服务，只换 provider / model | 宿主管理 |
| 自定义 API | 直连 OpenAI 兼容的 `/chat/completions` | key 只存在本机 `~/.dsh/storages/dsh-paper-lens.json` |

指向 `127.0.0.1` / `localhost` 时，可以填一条「启动命令」，翻译时自动拉起本地服务，空闲十分钟后关掉。仓库里的用法是 [llama.cpp](https://github.com/ggml-org/llama.cpp) + 腾讯混元的 hy-mt 本地翻译模型（Q4_K_M 约 1 GB，纯 CPU 约 25 字/秒），离线可用、不花 token：

```bat
llama-server -m Hy-MT2-1.8B-Q4_K_M.gguf --host 127.0.0.1 --port 8080 -c 8192 -t 8 --alias hy-mt
```

译文语言可选：简体中文、繁體中文、English、日本語、한국어、Deutsch、Français、Español、Русский、العربية。语言会进缓存键，来回切换不会串译文。

## 引用与批注

选中一段文字，工具条出现：

- **译**：译文气泡，可拖动、可复制。
- **引用**：把 `> **main.pdf · p.2–3:** "…"` 插入对话输入框，模型看得到页码。
- **标注**：选颜色高亮；一条批注属于一页，跨页选区会提示先分页标注（翻译和引用不受影响）。
- **复制**：只复制干净正文。

选中的段落如果跨页，页码会写成范围；每页顶部的小字页眉、bioRxiv 那类版权横幅、正文里的页码标签都会被识别并剔除，不会混进译文或引用。

## 开发

```powershell
cd dsh-paper-lens
npm install
npm run build      # 客户端 bundle → lib/client.js
npm test           # 116 个用例，必须全过
```

- 服务端 `src/index.js`（路由、翻译、批注、配置），客户端 `src/client/*`（阅读器、选区、译文气泡、设置面板）。
- 客户端是手写 hyperscript，没有框架依赖；bundle 里的 pdf.js 由 `build.mjs` 打包，运行时零依赖。
- 改服务端要重启 DSH；改客户端要 `npm run build` 后重启（宿主会缓存 bundle）。

## 已知边界

- 桌面端走 `dsh-app://` 自定义协议，响应头与首个正文分片一起到达，所以「边翻边出」在桌面端不如浏览器里明显；已经出字后仍是一段段追加的。
- 翻译速度取决于模型。默认的推理型模型每段有几秒启动开销，长段落会慢；本地 MT 或非推理小模型快得多，质量略低。
- 跨页批注按页拆开标注；这是批注数据结构的限制（一条批注属于一页）。

## 许可

MIT。改造自 [dsh-cite-lens 0.3.1](https://github.com/adithyanraj/dsh-cite-lens)（MIT，作者 Adithya N Raj）：引用链接与 PDF 预览的骨架来自它，翻译、批注、语言与引擎设置是后加的。
