# S. MORI Window Fashion — Shopify 项目

| 目录 | 内容 |
| --- | --- |
| `theme/` | 线上 Dawn 主题的副本 + 首页文字对比度修复 + 安装案例模块（`installation_case` 元对象） |
| `photo-assistant/` | 照片助手 + 自动流水线 + 网站 AI 客服后端：Dropbox 自动导入、Claude 筛选/文案、写入 Shopify；App Proxy 聊天接口与线索管理。Shopify 应用（OAuth）+ Fly.io 部署 |
| `docs/` | 修改说明、后台配置、预览步骤、AI 接入方案、应用发布与安装步骤、自动流水线设置（中文） |

关键状态见 `docs/05-Shopify应用安装步骤.md`。密钥一律不进仓库：Shopify Client secret、SESSION_SECRET、ADMIN_PASSWORD、Anthropic API Key 只放在 Fly.io Secrets。
