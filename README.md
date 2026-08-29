# SpikeDeck - Google Chrome Extension for Spike

**SpikeDeck** 是专为 [Spike](https://github.com/earendil-works/spike) 打造的 Google Chrome 浏览器扩展。它提供媲美 Surge 的精美暗黑线路与策略组选择菜单，支持多实例管理、策略组测速与节点实时切换，并提供可选的浏览器代理托管功能。

---

## ✨ 核心特性

1. **多实例集中管理**
   - 轻松管理多个 Spike 实例（例如：本地开发环境、远程服务器节点等）。
   - 在 Popup 面板与设置页中一键快速切换当前激活实例。

2. **Surge 风格线路选择菜单**
   - 极简精致的暗黑视觉设计（Surge / iOS / macOS 风格）。
   - 实时展示配置文件 (Profile) 概览、进程级 ↑↓ 速度与策略组 (Policy Groups) 列表。
   - 工具栏角标显示下行速度（约 4 字符）；完整 ↑↓ 写在图标 title。Popup 打开时每秒刷新；关闭后由后台 alarm 约 30 秒刷新一次（Chrome MV3 限制）。
   - 接管浏览器代理时，空闲角标仍显示 `ON`；有流量时优先显示速度。
    - 点击策略组中的任意节点即可**实时完成选路切换**（调用 Spike 原生 `PUT /spike/groups/{name}/select`）。
    - 支持关键字实时筛选策略组与节点，自动展开并只显示匹配项。
    - 支持中文与英文界面；首次安装按浏览器首选语言初始化，可在设置页即时切换。
    - 支持 `/` 聚焦筛选、`Esc` 分层退出，以及方向键、`Home` / `End` 和回车完成全键盘选路。
    - Popup 会恢复上次面板、滚动位置和焦点（不恢复筛选词），并集中显示运行中的测速与资源任务。
    - 节点切换会提示“仅影响新连接”，短时间内可撤销；非规则模式持续显示安全提示并可一键恢复。
   - Popup 可切换运行模式：规则模式、全部直连、全局代理（调用 `GET` / `PUT /spike/outbound`，全局模式选择一个策略）。
   - 对已固定（override/pin）的 `url-test` / `fallback` / `smart` 组，可一键**恢复自动选择**（`DELETE /spike/groups/{name}/select`）。

3. **延迟测试 (Speedtest / Ping)**
   - **单组/单节点测速**：随时刷新单个策略组或其中一个节点的 RTT 延迟。
   - 绿 / 黄 / 红 动态延迟徽章标识，超时或异常自动标注。
   - 测速任务由后台 Service Worker 跟踪并持久化；关闭 Popup 不会中断 Core 中的任务，重新打开后会恢复进度和结果，运行中的组测速可直接取消。

4. **浏览器代理托管模式 (Chrome Proxy Host)**
   - 可选开关：一键把 Chrome 浏览器的代理托管至当前 Spike 实例。
   - 端口不再手工配置：开启时从 Control API `GET /spike/status` 的 `listeners` 字段自动选择（优先 `mixed` / `http`，其次 `socks`）。
   - Popup 展示发现的 Mixed / HTTP / SOCKS5 可达地址。
   - 关闭托管时清除 SpikeDeck 写入的代理设置并释放控制权，不影响 SwitchyOmega 等其他代理扩展。
   - 接管开启时约每 3 秒探测当前实例（Popup 打开时随流量刷新约 1 秒一次）。Spike 不可达时交回代理控制，用户开关仍保持开启，实例恢复后自动重新接管。

5. **外部资源管理**
   - Popup 顶栏打开外部资源面板，列出全部 `policy-path`、`RULE-SET` 与 `DOMAIN-SET` 及其状态。
   - 支持全部更新或单独更新某一条；完成后展示每项状态与最近更新时间。
   - 刷新任务由 Spike Core 持有；关闭并重新打开 Popup 后会恢复进度，不会中断下载。
   - 后台定时刷新与手工刷新都会自动轮询到结束；下载或校验失败时继续使用原有运行时快照。
   - 资源 URL 默认隐藏查询参数，避免订阅凭据出现在 Popup 或截图中。

6. **运行工具**
   - 从 Popup 顶栏打开独立工具页，不受 Popup 生命周期限制。
   - 查看 live/recent 连接并终止 live 连接。
   - 查看 DNS cache，执行 DNS query/flush 和路由解释。
   - 查看并执行已配置脚本，也可执行带 mock type 的临时脚本文本。

---

## 🛠️ 安装与使用方法

### 1. 在 Chrome 中加载扩展

1. 打开 Google Chrome 浏览器，访问扩展管理页面：`chrome://extensions/`
2. 开启右上角 **“开发者模式” (Developer mode)**。
3. 点击 **“加载已解压的扩展程序” (Load unpacked)**。
4. 选择本项目中的 `extension` 目录。
5. 成功加载后，把 **SpikeDeck** 图标固定到浏览器工具栏。

### 2. 配置 Spike 实例

1. 点击扩展图标右侧的 **⚙️ 设置** 按钮（或在扩展管理中打开“选项”）。
2. 在选项页面中配置你的 Spike 控制面 API 信息：
   - **实例名称**：如 `Local Spike`
   - **Control API Base URL**：默认 `http://127.0.0.1:9090`
   - **Control Secret**：若在 Spike 配置中启用了控制面密码（`http-api`），填入该 Secret；未设置可留空。
   - **代理端口**：无需填写。开启浏览器代理时会读取 `/spike/status` 的 `listeners`（mixed / HTTP / SOCKS）。
3. 点击 **⚡ 测试连接** 验证配置（成功时会展示发现的 listeners），无误后点击 **保存实例**。

### 3. 日常使用

- **查看实时速度**：打开 Popup 后，状态条会显示进程级 ↓/↑；关掉面板后工具栏角标仍会按 Chrome 允许的间隔更新。
- **切换运行模式**：点击「模式」入口，在子面板选择规则、直连或全局；全局模式先选择目标策略。
- **切换策略组节点**：点击 Chrome 顶栏的 SpikeDeck 图标，展开目标策略组，点击节点名称即可瞬间切换。
- **策略组测速**：在策略组卡片上点 ⚡，测试该组全部节点；也可对单个节点测速。再次点击运行中的组测速按钮可取消该组全部测速任务。
- **快捷打开**：在 Chrome 中按 `Ctrl+Shift+K`（macOS 为 `Command+Shift+K`）直接打开 Popup；可在 Options 中停用，并可在 `chrome://extensions/shortcuts` 中重新绑定。
- **外部资源**：点击 Popup 顶栏的云下载按钮打开资源列表；可「全部更新」或对单条点「更新」，面板会展示每项结果。
- **刷新列表**：点击圆形箭头按钮，重新载入当前实例的策略组与状态。
- **实例切换**：点击「实例」入口，在子面板挑选激活的 Spike 实例。
- **切换 Profile**：点击「Profile」入口，选择配置后点「切换」；子面板同时展示路径、组/节点/规则数量、DNS 延迟与代理监听。
- **浏览器代理控制**：在状态条开关 **“接管代理”**，快捷切换是否让 Chrome 流量走 Spike。

---

## 📦 打包与商店发布

```bash
make package          # dist/spikedeck-<version>.zip
make store-release    # 打包 + 上传 + 提交审核
make store-status     # 查看商店条目状态
```

`store-upload` / `store-submit` / `store-release` 调用 Chrome Web Store API v2，**不能新建条目**。请先在 [Developer Dashboard](https://chrome.google.com/webstore/devconsole) 创建 item 并填完 Store listing 与 Privacy。然后复制 `.env.example` 为 `.env`，填入 OAuth 与 publisher/extension ID（步骤见该文件注释和 [Using the API](https://developer.chrome.com/docs/webstore/using-api)）。`publish` 会把当前草稿送审，通过后按现有可见性上架。

---

## 📁 目录结构

```text
extension/
├── manifest.json         # Manifest V3 配置文件
├── background.js          # Service Worker（测速/资源任务与 Chrome Proxy 控制）
├── popup.html             # Surge 风格弹出面板页面
├── popup.css              # Surge 极简暗黑样式表
├── popup.js               # Popup 展示与用户交互
├── options.html           # 实例管理与设置页面
├── options.css            # 设置页面样式表
├── options.js             # 实例 CRUD 与测试连接逻辑
├── tools.html/js/css      # 连接、DNS、路由与 Script 运行工具
├── lib/
│   ├── storage.js         # Chrome Local Storage 数据持久化层
│   └── spike-client.js    # Spike Control REST API 客户端
└── icons/                 # 扩展图标 (16x16, 48x48, 128x128, SVG)
```
