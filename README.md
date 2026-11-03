# dsh-paper-lens（论文阅读）

在项目里打开 PDF 就能用的阅读器：**右侧边栏**打开 PDF，划词可**翻译**、可**引用到当前会话**、可提问；模型在回答里写的 `[main.pdf p.7 "exact words"]` 会变成可点链接，点开跳到该处并高亮原文。

本项目是 [dsh-cite-lens](https://github.com/adithyanraj03/dsh-cite-lens) 0.3.1（MIT）的**本地改造版**，独立维护，不跟随上游发布。

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
| **译** | 翻成简体中文，结果只显示译文；公式/变量名/数字/单位保持原样 |
| 引用 | 把这段带 `文件 · p.N` 引用到当前会话输入框 |
| 提问 | 引用后把光标放到「问题：」后面 |
| 解释 | 引用后请模型解释这段在论文里的作用 |
| 挑错 | 引用后请模型检查这段有无无依据的说法 |

`/cite-links` 让当前会话把每条关于论文的论断都链到 PDF（可 `on` / `off` / `status`）。

## 开发

```powershell
cd D:\AgentTools\Projects\dsh-paper-lens
npm install          # 只装 esbuild 与 pdfjs-dist（devDependencies）
npm run build        # src/client/* -> lib/client.js（约 1.7 MB，内嵌 pdf.js 与 worker）
npm test             # 16 个用例，含一个真的加载 lib/client.js 的用例
```

**改完 `src/client/**` 必须 `npm run build`**——`lib/client.js` 是生成物，直接改它会在下次构建时被覆盖。

`src/index.js` 是服务端半边，不需要构建，改完重启 DSH 生效。

### 目录

```
src/index.js          服务端：系统提示词注入、/cite-links、/translate 路由
src/client/           浏览器半边（React + pdf.js）
  index.js            预览体、工具条、翻译气泡、插槽注册
  chat.js             划词动作定义、引用块格式、写入当前会话输入框
  viewer.js           pdf.js 视图
  selection.js        选区机制（pdf.js 文本层修正、手柄、键盘扩展）
  pagelinks.js        引用链接的渲染与跳转高亮
  textsearch.js       页内查找
  chip.js             会话顶栏的引用链接开关
build.mjs             esbuild 打包，输出 lib/client.js
test/                 node --test 用例
upstream-cite-lens-0.3.1/   上游原始快照，仅作对照，勿改
```

### 翻译是怎么实现的

- 服务端 `POST /plugin-data/dsh-paper-lens/translate`，请求体 `{ text, session }`，返回 `{ translation }`
- 模型按顺序取：**该会话实际路由到的模型**（`agent.session.requestHeader().config`，与官方压缩调用同源，一定带可用凭据）→ `ctx.agentDefaultModel.currentSelection()` → 插件配置里的 `provider`/`model`
- 用 `ctx.llm.stream()`（`@deepseek-ai/dsh-llm` 的服务）把分片读干再一次性返回；**必须带 `sessionId`**，适配器据此解析凭据
- 分片解析是宽容的：`text-delta` 累加，只有 `block-end` 时取整块；**排除 `reasoning-delta`**（那是思考过程，不是译文）
- 失败时错误信息带上分片直方图、结束原因、失败码与失败消息，便于定位而不是只报「没有返回译文」
- 单次上限 6000 字符（服务端 `MAX_TRANSLATE_CHARS`）

## 维护

- **DSH 升级后要先验证**：本插件依赖 5 个客户端服务（`slots`、`documentPreviews`、`sessions`、`conversation`、`sidebarRight`）和 1 个服务端服务（`llm`）。内核改接口时这里最可能先坏。
- **不跟随上游**：上游有修 bug 时，手动对照 `upstream-cite-lens-0.3.1/` 搬过来。
- **回退**：卸载（设置 → 插件 → 卸载）后重装上一版本即可；本目录即源码，删掉 `node_modules` 与 `lib/client.js` 可完全重建。

## 许可

MIT。基于 Adithya N Raj 的 dsh-cite-lens 0.3.1 改造，原始版权声明见 `LICENSE`。
