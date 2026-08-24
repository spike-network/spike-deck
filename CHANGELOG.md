# 更新日志 (Changelog)

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 规范。

---

## [1.0.3] - 2026-08-24

### 🔒 安全与权限优化 (Security & Permissions)

- **权限最小化重构 (Least Privilege)**：移除 `manifest.json` 中全网通配的 `http://*/*` 与 `https://*/*` 静态主机权限，消除扩展安装时 Chrome 弹出的“读取和更改您在所有网站上的数据”高危权限警告。
- **本地白名单预授权**：默认 `host_permissions` 仅保留 `http://127.0.0.1/*` 与 `http://localhost/*`，本地 Spike 实例完全开箱即用、零弹窗打扰。
- **动态按需权限申请**：将通配规则放入 `optional_host_permissions`，新增 `lib/permissions.js` 模块：
  - 在 Options 页面测试连接、保存实例、设为激活时，若为局域网 IP（如 `192.168.x.x`）或远程域名实例，按需向用户动态申请目标主机权限。
  - 在 Popup 面板切换实例时提供权限检测与未授权拦截回退保护。
- **自动化测试**：新增 `tests/permissions.mjs` 覆盖主机模式提取、本地回环识别与 Mock 动态权限请求。

---

## [1.0.2] - 2026-08-24

### ⚡ 性能与高频探测 (Performance & Polling)

- **离屏文档 (Offscreen Document) 双轨调度**：引入 `offscreen.html` / `offscreen.js` 与 Service Worker 协同工作，突破 MV3 后台定时器受限瓶颈。
- **可配置刷新频率**：
  - 选项页支持自定义健康检查间隔（默认 5s）与流量速率刷新间隔（默认 1s）。
  - 窗口聚焦且有前台监控时启用 1s 极速速率刷新，窗口失焦/关闭时自动降频节能。
- **离屏生命周期管理**：自动按需创建与关闭离屏文档，保障后台长效稳定与内存占用最小化。

---

## [1.0.1] - 2026-08-24

### 🛡️ 容灾与商店发布工具链 (Resilience & Tooling)

- **代理健康容灾联动**：当后台健康检查发现 Spike Core 离线或不可达时，自动临时释放 Chrome 代理控制权交回系统/其他扩展，防止浏览器断网卡死；待 Spike 恢复后自动重新接管。
- **商店发布自动化**：新增 `scripts/cws.sh` 与 `Makefile` 自动化发布目标（`make store-upload`、`make store-submit`、`make store-release`），接入 Chrome Web Store API v2。
- **商店素材与截屏工具**：新增 `store/capture.sh` 及截图夹具页面，支持一键捕获 1280x800 高清商店推广图。
- **UI 紧凑化与视口约束**：优化 Popup 面板在小屏幕与不同分辨率下的展示，约束弹出层高度不超过可视标签页的 85%。

---

## [1.0.0] - 2026-08-24

### 🎉 初始版本发布 (Initial Release)

- **多实例集中管理**：支持多个 Spike Control API 实例的配置、测试、快速切换与持久化存储。
- **Surge 风格线路控制面板**：
  - 极简深色暗黑风格，实时展示 Profile 概览、策略组结构与节点列表。
  - 节点一键切换、固定策略组一键恢复自动选择。
  - 策略组与节点实时关键字搜索过滤。
- **延迟测速 (Speedtest / Ping)**：单组/单节点延迟测试，Service Worker 后台任务追踪，关闭 Popup 不中断测速任务。
- **浏览器代理托管模式**：一键将 Chrome 代理托管给 Spike，自动识别 `/spike/status` 中的 listeners（Mixed / HTTP / SOCKS5）。
- **外部资源管理**：支持 `policy-path`、`RULE-SET`、`DOMAIN-SET` 列表查看、单独更新与一键批量更新。
- **运行模式与配置管理**：支持规则模式 (Rule)、直连模式 (Direct)、全局模式 (Global) 切换；支持 Profile 切换与脱敏展示。
- **实时流量角标**：工具栏图标动态显示实时下行速率角标，Title 展示完整上传/下载流量统计。
