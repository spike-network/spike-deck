# SpikeDeck - Google Chrome Extension for Spike

**SpikeDeck** 是专为 [Spike](https://github.com/earendil-works/spike) 打造的 Google Chrome 浏览器扩展。它提供媲美 Surge 的精美暗黑线路与策略组选择菜单，支持多实例管理、一键全组测速与节点实时切换，并提供可选的浏览器代理托管功能。

---

## ✨ 核心特性

1. **多实例集中管理**
   - 轻松管理多个 Spike 实例（例如：本地开发环境、远程服务器节点等）。
   - 在 Popup 面板与设置页中一键快速切换当前激活实例。

2. **Surge 风格线路选择菜单**
   - 极简精致的暗黑视觉设计（Surge / iOS / macOS 风格）。
   - 实时展示配置文件 (Profile) 概览与策略组 (Policy Groups) 列表。
   - 点击策略组中的任意节点即可**实时完成选路切换**（调用 `PUT /groups/{name}/select`）。

3. **延迟测试 (Speedtest / Ping)**
   - **全组一键测速**：点击顶部⚡“测速”按钮，批量获取各组节点的 RTT 延迟。
   - **单组/单节点测速**：随时刷新单个策略组的节点状态。
   - 绿 / 黄 / 红 动态延迟徽章标识，超时或异常自动标注。

4. **浏览器代理托管模式 (Chrome Proxy Host)**
   - 可选开关：一键把 Chrome 浏览器的代理托管至当前 Spike 实例。
   - 端口不再手工配置：开启时从 Control API `GET /status` 的 `listeners` 字段自动选择（优先 `mixed` / `http`，其次 `socks`）。

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
   - **代理端口**：无需填写。开启浏览器代理时会读取 `/status.listeners`（mixed / HTTP / SOCKS）。
3. 点击 **⚡ 测试连接** 验证配置（成功时会展示发现的 listeners），无误后点击 **保存实例**。

### 3. 日常使用

- **切换策略组节点**：点击 Chrome 顶栏的 SpikeDeck 图标，展开目标策略组，点击节点名称即可瞬间切换。
- **全组测速**：点击 Popup 顶栏的 **⚡ 测速** 按钮。
- **实例切换**：在 Popup 顶栏下拉菜单中直接挑选激活的 Spike 实例。
- **浏览器代理控制**：开关 **“浏览器代理”** 开关，快捷切换是否让 Chrome 流量走 Spike。

---

## 📁 目录结构

```text
extension/
├── manifest.json         # Manifest V3 配置文件
├── background.js          # Service Worker (后台逻辑与 Chrome Proxy 控制)
├── popup.html             # Surge 风格弹出面板页面
├── popup.css              # Surge 极简暗黑样式表
├── popup.js               # Popup 交互与 Spike API 接口调度
├── options.html           # 实例管理与设置页面
├── options.css            # 设置页面样式表
├── options.js             # 实例 CRUD 与测试连接逻辑
├── lib/
│   ├── storage.js         # Chrome Local Storage 数据持久化层
│   └── spike-client.js    # Spike Control REST API 客户端
└── icons/                 # 扩展图标 (16x16, 48x48, 128x128, SVG)
```
