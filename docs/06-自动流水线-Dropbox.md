# 自动流水线：手机拍照 → 自动整理 → 自动发布

目标：安装现场拍完照片后不再手动操作。流程：

1. 手机 Dropbox 应用把相机胶卷自动备份到 Dropbox 的 `Camera Uploads` 文件夹。
2. 服务器每 10 分钟从 Dropbox 取新照片，用 AI 逐张筛选：不是窗饰安装现场的照片直接丢弃、不保存。
3. 同一天、同一地点（GPS 400 米内）的照片归为一个案例；地点由 GPS 反查城市（OpenStreetMap）；产品型号由 AI 从画面判断并计算把握度；安装日期取拍摄日期。
4. 案例 6 小时没有新照片后自动整理：生成中英文文案和小红书文案，上传照片，创建 Shopify 案例。
5. 把握度 ≥ 80% 且有地点 → 自动设为「已发布」，网站立即显示，并推送通知。
   把握度不足或没有 GPS → 保持「草稿」，推送"需要确认"通知；在照片助手里选好产品/地点，点 **确认并发布**。
6. 每条通知带链接（后台或照片助手页面）。小红书文案在项目页"小红书"标签里，一键复制。

隐私：手机相册里的非工作照片会被服务器下载一次用于判断，判断为"非安装现场"后立即丢弃，不写入磁盘、不上传 Shopify；日志只记录文件名。

## 一次性设置

### A. Dropbox 开发者应用（生成 App key / secret）
1. 打开 https://www.dropbox.com/developers/apps → **Create app**。
2. 选 **Scoped access** → **Full Dropbox**（相机上传文件夹在根目录）→ 名称如 `SMORI Photo Assistant` → **Create app**。
3. **Settings** 标签：
   - 在 **Redirect URIs** 填 `https://smori-photo-assistant.fly.dev/connect/dropbox/callback` → **Add**。
   - 记下 **App key**；点 **Show** 看 **App secret**。
4. **Permissions** 标签：勾选 `account_info.read`、`files.metadata.read`、`files.content.read` → **Submit**。
5. 到 Fly Dashboard → 应用 → **Secrets** 添加 `DROPBOX_APP_KEY` 和 `DROPBOX_APP_SECRET`（值不经过聊天）。

### B. 通知（ntfy，免费）
1. 手机安装 **ntfy** 应用（iOS / Android）。
2. 在应用里 **Subscribe to topic**，主题名用一串别人猜不到的随机字符，例如 `smori-案例-x7k2p9q4`（英文字母数字更稳妥）。
3. Fly Secrets 添加 `NTFY_TOPIC` = 这个主题名。

### C. 手机
1. 安装 **Dropbox** 应用并登录（与 A 中的账号相同）。
2. Dropbox → 账户 → **相机上传** → 打开；建议只在 Wi‑Fi 下上传。
3. iPhone：**设置 → 相机 → 格式 → 兼容性最佳**（保存为 JPG）。HEIC 格式的照片服务器无法处理会跳过并提醒。

### D. 连接并启动
1. `fly deploy`（新版本已包含流水线）。
2. 打开照片助手 https://smori-photo-assistant.fly.dev → 右上角 **连接 Dropbox** → Dropbox 授权页点 **Allow**。
3. 连接后只导入**之后**新增的照片（不会把历史相册全部导入）。要导入历史照片，用 `npm run cli -- auto --from-scratch`。
4. 可点 **立即同步** 手动触发一次。

## 参数（Fly `[env]` 或 Secrets）
| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `AUTO_POLL_MINUTES` | 10 | 轮询间隔 |
| `AUTO_PUBLISH_CONFIDENCE` | 0.8 | 自动发布的最低把握度 |
| `PROJECT_CLOSE_HOURS` | 6 | 多久没有新照片视为案例结束 |
| `CLUSTER_GAP_HOURS` / `CLUSTER_RADIUS_METERS` | 8 / 400 | 归组规则 |
| `CLAUDE_SCREEN_MODEL` | claude-sonnet-5 | 筛选用模型（文案仍用 claude-opus-5） |
| `INBOX_TOKEN` | 空 | 可选：给 iOS 快捷指令直传 `/api/inbox` 用的令牌 |

## 费用估算
每张照片筛选约 0.005–0.01 美元；每个案例文案约 0.1–0.2 美元。每月 30 个案例、300 张照片约 6–10 美元。Fly 机器常驻约 5 美元/月。
