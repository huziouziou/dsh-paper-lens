# dsh-paper-lens（论文阅读）

在项目里打开 PDF 就能用的阅读器：**右侧边栏**打开 PDF，划词可**翻译**、可**引用到当前会话**、可提问；模型在回答里写的 `[main.pdf p.7 "exact words"]` 会变成可点链接，点开跳到该处并高亮原文。

本项目是 [dsh-cite-lens](https://github.com/adithyanraj03/dsh-cite-lens) 0.3.1（MIT）的**本地改造版**，独立维护，不跟随上游发布。

> **项目文档（决策/进度/发布/已知问题）不在这里**，在 Obsidian 库：
> `D:\Obsidian\第二大脑\02_Code_Library（代码库）\dsh-paper-lens\`
> 本目录只放源码、构建与 git 历史；版本历史以本仓库的 `git tag` 为准。

## 和上游的差别

| 项目 | 上游 dsh-cite-lens 0.3.1 | 本版 |
|---|---|---|
| 包名 / 插件 id | `dsh-cite-lens` | **`dsh-paper-lens`** |
| 划词翻译 | 无 | **有**：划词点「译」，气泡里只显示中文译文 |
| 界面语言 | 英文 | **中文**（界面文案、命令说明、状态提示）|
| 翻译走哪个模型 | — | **应用当前默认模型**（`agentDefaultModel`），不需要配端点、不需要 API key |
| 翻译呈现 | — | **一次性返回**，不做流式 |
| 版本线 | 0.3.1 | 0.1.0（自维护起点）|

上游能力全部保留：右侧边栏 PDF 视图、划词引用/提问/解释/挑错、引用链接与高亮跳转、`/cite-links` 逐会话开关、按会话记忆开关状态。

## 安装

DSH `0.2.1-rc.5` 起，桌面的 `desktop` profile 只能由应用自己管理（命令行 `dsh plugin add` 会被拒绝）。用应用内界面安装：

1. **设置 → 插件 → 添加插件**
2. 「包名或地址」填本目录路径：

   ```
   D:\AgentTools\Projects\dsh-paper-lens
   ```

3. 点「安装」，按提示重启 DeepSeek Harness。

安装后 `profiles\desktop\package.json` 的 `dependencies` 与 `dsh.profile.bundles` 各出现一次 `dsh-paper-lens`，`node_modules` 下有对应目录——这三处才是安装成功的判据，不要只看界面提示。

**安装前先卸载 `dsh-cite-lens`**：两者都声明接管 `.pdf` 预览（`documentPreviews`，优先级 `extension`），同时启用会争抢同一个预览位。

## 用法

打开任意 PDF（会话的「文件」页签里点开），它会在右侧边栏渲染。

选中一段文字后，工具条给出五个动作：

| 按钮 | 作用 |
|---|---|
| **译** | 翻成简体中文，**边收边出**（流式），结果只显示译文；公式/变量名/数字/单位保持原样。气泡可**按住标题栏拖动**，标题栏的「复制」只在该段译完后可用 |
| 引用 | 把这段带 `文件 · p.N` 引用到当前会话输入框 |
| ▾ | 带提示词引用：提问 / 解释 / 挑错（内容可配置，见下）。也可以**长按「引用」**打开同一个菜单 |
| 标注 | 选一种颜色标在页面上，存进 PDF 同级的 `marks/`；随后弹出详情卡可写文字 |
| 复制 | 把这段正文复制到剪贴板（换行已归一，选区保留） |

`/cite-links` 让当前会话把每条关于论文的论断都链到 PDF（可 `on` / `off` / `status`）。

## 版本记录

本目录是 git 仓库，版本用标签标记：

```powershell
git log --oneline --decorate     # 提交历史
git tag -l                       # 已发布版本
git show v0.1.0 --stat           # 某一版改了哪些文件
git diff v0.1.0 HEAD -- src      # 两版之间的代码差异
```

发新版本时：改 `package.json` 与 `dsh.plugin.json` 的 `version` → `npm run build` → `npm test` → 提交 → `git tag -a vX.Y.Z -m '…'`。

已发布的版本：

| 标签 | 内容 |
|---|---|
| `v0.1.0` | 首个可用版：划词翻译（一次出）、界面中文化、引用/提问的会话兜底修复、自绘图标 |
| `v0.2.0` | 翻译改流式 + 气泡可拖动 + 翻译路由契约测试 |
| `v0.2.1` | 修复阅读器顶栏黑底黑字（改用 DSH 真实主题变量）、页码框可读性与回车跳页；补「边收边写」与主题 token 回归测试 |
| `v0.3.0` | 工具条合并为「引用」+ 可选预设提示词（配置可改）；PDF 批注（标色/查看/删除/转引用，存 `marks/`）；翻译缓存、提前 flush、动态 maxTokens、按段并行；字号与气泡宽度设置 |
| `v0.3.1` | 修批注 cwd（`agent/session-start` → `agent/created`）；修翻译 max-tokens（推理预算 + 截断检测）；修顶栏换行；新增阅读器主题（跟随应用/浅色/深色） |
| `v0.3.2` | 批注可写文字：`custom.note`、`PATCH /marks`、详情卡输入框、面板显示与「改文字」、引用带 `注：…` |
| `v0.3.3` | 划词「复制」、译文气泡「复制」（流式禁用）、批注卡可拖动；剪贴板 API 失败时退回 textarea |

## 开发

```powershell
cd D:\AgentTools\Projects\dsh-paper-lens
npm install          # 只装 esbuild 与 pdfjs-dist（devDependencies）
npm run build        # src/client/* -> lib/client.js（约 1.7 MB，内嵌 pdf.js 与 worker）
npm test             # 60 个用例，含真的加载 lib/client.js 的用例
```

**改完 `src/client/**` 必须 `npm run build`**——`lib/client.js` 是生成物，直接改它会在下次构建时被覆盖。

`src/index.js` 是服务端半边，不需要构建，改完重启 DSH 生效。

### 目录

```
src/index.js          服务端：系统提示词注入、/cite-links、/translate、/config、/marks 路由
src/prompts.js        预设提示词的默认值与配置归一化（两半共用）
src/marks.js          批注的文件定位、校验、读写（<pdf-dir>/marks/*.marks.json）
src/client/           浏览器半边（React + pdf.js）
  index.js            预览体、工具条、翻译气泡、批注面板、显示设置、插槽注册
  chat.js             引用块格式、写入当前会话输入框、`[p.N]` 解析
  prefs.js            字号/气泡宽度：归一化与 localStorage 持久化
  marks.js            批注的选区转格式、HTTP 客户端
  viewer.js           pdf.js 视图、批注高亮与编号徽标
  selection.js        选区机制（pdf.js 文本层修正、手柄、键盘扩展）
  pagelinks.js        引用链接的渲染与跳转高亮
  textsearch.js       页内查找
  chip.js             会话顶栏的引用链接开关
build.mjs             esbuild 打包，输出 lib/client.js
test/                 node --test 用例
upstream-cite-lens-0.3.1/   上游原始快照，仅作对照，勿改
```

### 引用工具条与预设提示词

- 划词后只有「译」「引用」「标注」；「引用」是普通引用，点旁边的 `▾`（或**长按「引用」**）才展开预设提示词（提问 / 解释 / 挑错）。
- 预设内容走插件配置，不写死在界面里。可以在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

  ```yaml
  - id: dsh-paper-lens
    name: "dsh-paper-lens"
    config:
      prompts:
        - id: ask
          label: 提问
          prompt: "问题："
        - id: explain
          label: 解释
          prompt: "解释这段：它说了什么，为什么重要。"
  ```

  `prompts: []` 会关掉预设，只保留普通引用。改完重启 DSH；客户端从 `GET /plugin-data/dsh-paper-lens/config` 读取。

### 批注

- 划词 → 「标注」→ 选颜色，立即保存；高亮画在页面上，左侧编号徽标点开可查看、引用、删除。
- **可以写文字**：选色后详情卡直接弹出，输入框里写备注（≤2000 字），点「保存文字」或按 `Ctrl/⌘+Enter`。之后从编号徽标或列表点「改文字」都能再改；**清空输入框再保存**就是删掉文字（`note` 键整个消失，不留空串）。
- 顶栏「批注 N」打开本 PDF 的批注列表：每条显示原文和文字（左侧色条），可「引用」「改文字」「删除」。
- 引用带文字的批注时，会话里除了引用块还会多一行 `注：…`。
- 存储位置：**PDF 同级的 `marks/<pdf-name>.marks.json`**，不写工作区根目录。结构：

  ```json
  {
    "version": 1,
    "pdf": "main.pdf",
    "marks": [{
      "id": "m-…",
      "pageIndex": 3,
      "rect": { "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04 },
      "segmentRects": [{ "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04 }],
      "strokeColor": "#f59e0b",
      "custom": { "quote": "原文……", "note": "我的批注（可省略）" },
      "createdAt": 1790000000000
    }]
  }
  ```

  `pageIndex` 从 0 开始，`rect` / `segmentRects` 是页内比例（0–1），缩放不影响。相对 PDF 路径按会话 `cwd` 解析，越出工作区的路径会被拒绝。

  **会话 `cwd` 怎么拿**：`agent/created` 事件（dsh 0.2.2 起的生命周期事件，0.2.1 及更早叫 `agent/session-start`，两个都挂）记下 session → agent；取不到时退回 `ctx.agents.get(id)` 与 `ctx.sessions.get(id)` 的 `header.cwd`。这三条路都断了才会报「PDF 路径缺失或越出会话工作区」。

### 显示设置

顶栏「设置」可调**主题**（跟随应用 / 浅色 / 深色）、**译文字号**（11–20px）和**气泡宽度**（280–640px），改动立即生效并写入 `localStorage` 的 `dsh-paper-lens:ui`，重启后保留。

主题只改阅读器自己：PDF 纸面仍是白的，顶栏、批注面板、译文气泡跟着换色。皮肤插件会在后代元素上重声明 `--dsw-alias-*`，所以这几个面板按主题直接上色，不依赖变量继承。

### 翻译提速

- 先量基线：1129 字符段落（真实 DSH + 模型）`fetch` 等到响应头 8.6s、首 delta 8.6s、整段 10.2s、57 个分片。
- **关推理**：翻译不需要思考，但推理分片同样吃 `maxTokens` —— 实测短段落只剩半句、长段落直接 `max-tokens`。现在先带 `reasoningEffort`（默认 `off`）试，provider 拒绝就退回不带 effort、预算抬到 ≥2048。配置 `translateReasoning` 可改（`low` / `false` / 删掉即默认）。
- **截断不上屏**：`max-tokens` / `length` 结束的译文一律报「译文被截断」，不缓存、不显示半句。
- **同选区缓存**：`provider/model + 原文` 作键，最多 48 条；命中时直接回一条 `{delta}` + `{done}`，响应头带 `x-dpl-cache: hit`。
- **动态 maxTokens**：`max(512, len * 1.6)` 且不超过 4096。
- **按段并行**：300 字符以上且有空行分段时，最多 3 段并行请求；第一段实时出字，其余按顺序补，不改变阅读顺序。（PDF 选区多为单换行，实际很少触发。）
- 提前 `flushHeaders()` 对 HTTP 直连有效（实测 54ms 回头），但桌面端的 `dsh-app://` 协议会缓冲整段响应，应用里看不到「边翻边出」——这是宿主的。

### 翻译是怎么实现的

- 服务端 `POST /plugin-data/dsh-paper-lens/translate`，请求体 `{ text, session }`，响应是 **NDJSON 流**：
  - `{"delta":"…"}` 增量文字
  - `{"error":"…"}` 失败（含分片直方图、结束原因、失败码）
  - `{"done":true}` 正常结束

  用 JSON 行而不是裸文本，是因为译文本身带换行，纯文本流无法区分「内容」与「结束」。
- 模型按顺序取：**该会话实际路由到的模型**（`agent.session.requestHeader().config`，与官方压缩调用同源，一定带可用凭据）→ `ctx.agentDefaultModel.currentSelection()` → 插件配置里的 `provider`/`model`
- 用 `ctx.llm.stream()`（`@deepseek-ai/dsh-llm` 的服务）；**必须带 `sessionId`**，适配器据此解析凭据
- 分片解析是宽容的：`text-delta` 累加并即时推送，只有 `block-end` 时把整块当一次增量；**排除 `reasoning-delta`**（那是思考过程，不是译文）
- 客户端按行解析，增量约 60ms 合并一次再重渲染，避免一个 token 一次 setState；流式时气泡正文自动滚到底
- 校验（方法/空文本/超长）发生在发头之前，所以那几种失败仍是正常的 HTTP 状态码；一旦开始流式，失败只能作为一行 `error` 回来
- 单次上限 6000 字符（服务端 `MAX_TRANSLATE_CHARS`）

### 译文气泡

- 默认贴在选区下方；**按住标题栏可拖动**，位移相对选区位置，并始终收在窗口内
- 颜色跟随应用主题变量（`--dsw-alias-bg-overlay` / `label-primary` / `border-l2`），深浅主题都可读

## 维护

- **DSH 升级后要先验证**：本插件依赖 5 个客户端服务（`slots`、`documentPreviews`、`sessions`、`conversation`、`sidebarRight`）和服务端 `llm`、`webServer`、`agents`、`sessions`。内核改接口时这里最可能先坏。
- **事件名是暗坑**：v0.3.0 用 `agent/session-start`，dsh 0.2.2 改名成 `agent/created` 后**没有任何报错**——引用指南不再注入、批注相对路径全部 400。升级内核后优先核对 `ctx.on(...)` 的名字（`cordis_inspect_query` 的 Event provider 能列出真实事件与签名）。
- **改 JSON 清单别用 PowerShell 的 `Set-Content -Encoding UTF8`**：会写 BOM，应用直接报「包不可用」。用 `[System.IO.File]::WriteAllText` + `UTF8Encoding($false)`。
- **不跟随上游**：上游有修 bug 时，手动对照 `upstream-cite-lens-0.3.1/` 搬过来。
- **回退**：卸载（设置 → 插件 → 卸载）后重装上一版本即可；本目录即源码，删掉 `node_modules` 与 `lib/client.js` 可完全重建。

## 许可

MIT。基于 Adithya N Raj 的 dsh-cite-lens 0.3.1 改造，原始版权声明见 `LICENSE`。
