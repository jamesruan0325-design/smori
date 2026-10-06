# AI Sales Agent（第一版）

在现有网站 AI 客服基础上增加的"销售模式"。旧的问答模式保持不变：主题里不切换模式，线上网站就完全按原样运行。

## 做什么 / 不做什么
- **先回答问题，再了解需求**：每次最多问一两个问题。依次了解房间、窗户数量和大致尺寸、主要需求（遮光、隐私、采光、隔热、装饰）、是否要电动；预算只在自然聊到时记录。
- **按需求推荐**：只从知识库推荐，每次 1–3 个方案并说明理由；不加推销，简单方案够用就直说。
- **价格**：不给任何价格、区间、单价、折扣或促销条款，客户坚持也不给；统一说明由顾问免费上门测量后报价。客户自己说的预算只记录，不评价够不够。
- **ZIP**：聊到项目细节后才问。926/927/928 记为"OC 常规服务区"（初步判断）；其他 ZIP 照常服务，回复"团队会确认覆盖范围"，绝不拒绝客户。前缀可用 `SERVICE_ZIP_PREFIXES` 配置。
- **ALTA**：知识库里没有任何已确认的 ALTA 产品、功能、价格或活动信息。客户问到时只说"顾问会在咨询时确认"，不描述 ALTA 产品。
- **联系方式**：客户表现出购买意向后才问，包括询价、预约、上门、量尺、样品、项目时间。之后邀请预约免费上门咨询，请客户留姓名和电话或邮箱。
- **转人工**：随时可以。电话 (949) 880-1322 和邮箱随时可以给。
- 这一版**没有聊天内传照片**（计划在 v1.5）。照片助手和 Dropbox 自动流水线不受影响。
- **没有改动** Schedule Consultation 表单（`smori-contact.liquid`）。

## 线索（lead）
- **保存位置**：服务器 `data/leads/`（Fly 上是持久卷 `/app/data/leads/`）。
  - 每个销售对话一个 JSON 文件：`<日期>-c<对话哈希>.json`。
  - 旧版客服的线索仍然是 `<日期>-<随机>.json`。
- **字段**：
  - 联系方式和地区：name、phone、email、wechat、zip（以及 zip_in_area）。
  - 项目信息：room_type、window_count、approximate_size、primary_need、motorization_interest、budget_range（客户原话）。
  - 推荐与意向：products_recommended（只保留知识库中的产品名）、consultation_interest、preferred_time。
  - 来源与记录：lead_source = `AI Sales Agent`、summary（中文摘要）、createdAt / updatedAt、stage_history、page（来源页面和 UTM，不含其他 URL 参数）、transcript。
- **字段从哪来**：每次 AI 回复发出后，后台再做一次结构化提取，不会拖慢客户看到回复。
  - 电话、邮箱、ZIP 必须是客户自己输入过的，并通过格式校验；AI 说过的号码（比如店里电话）不会被当成客户的。
- **四个阶段**（对 AI 只能往前走；员工可以在后台手动改任何阶段）：

| 阶段 | 条件 | ntfy 推送 |
|---|---|---|
| new 新线索 | 有任何项目信息（房间、需求、ZIP、预算等）或联系方式 | 不推送 |
| qualified 已确认需求 | 联系方式 + 房间或主要需求 | 推送一次 |
| consultation_requested 申请预约咨询 | 联系方式 + 同意预约（聊天中、内联按钮或"预约咨询"表单） | 推送一次 |
| handed_to_human 转人工 | 联系方式 + 要求真人，或 AI 无法回答 | 推送一次 |

  - 没有联系方式时，预约或转人工的意向会先记下来，客户一留联系方式就生效。
  - 一次跳过多个阶段时只推送最高的那个。
  - 旧线索（没有阶段字段的）显示为"转人工"。
- **后台**：照片助手 →「网站咨询线索」。
  - 按阶段筛选，查看结构化字段、摘要和对话。
  - 可以手动改阶段、标记已处理、导出 CSV（`/api/leads.csv`，可加 `?stage=`）。

## 文件
- **后端**：
  - `photo-assistant/src/sales.ts`（新）：销售提示词、工具 `check_service_area`/`request_consultation`/`request_human`、线索提取与校验。
  - `photo-assistant/src/leads.ts`：阶段、按对话合并、每个阶段只推送一次、CSV。
  - `photo-assistant/src/chat.ts`：抽出共用的 Claude 调用循环，旧客服行为不变。
  - `photo-assistant/src/proxy.ts`：`agent: "sales"` 路由、页面来源、`cta`；`/lead` 支持 `kind=consultation|human`。
  - `photo-assistant/src/knowledge.ts`：需求与方案对应、服务区说明、咨询流程、ALTA 说明。
  - `photo-assistant/src/config.ts`：`SERVICE_ZIP_PREFIXES`、`CLAUDE_LEAD_MODEL`、`CLAUDE_LEAD_EFFORT`。
  - `photo-assistant/src/server.ts`、`photo-assistant/public/index.html`：线索后台。
- **主题**：
  - `theme/sections/smori-assistant.liquid`：新增 Mode 设置（默认仍是 Q&A assistant）和销售欢迎语。
  - `theme/assets/smori-assistant.js`、`theme/assets/smori-assistant.css`：销售模式下多了「预约咨询」按钮、内联预约按钮、带 ZIP 和时间的预约表单，以及偏向购买的快捷问题。
  - 修复了旧 bug：标题会显示成"姓名"或"Name"。
- **测试**：
  - `photo-assistant/test/sales.test.ts`（单元测试）。
  - `photo-assistant/test/sales-e2e.test.ts`：HTTP、真实 SDK 和本地 API 测试替身。
  - `photo-assistant/test/fake-anthropic.ts`：只用于测试，回复都带 `[test double]` 标记，不是 AI 回答。

## 测试方法
1. **自动测试**：`cd photo-assistant && npm test`。
   - 覆盖四个阶段、只往前走、每个阶段只推送一次、同一对话并发写入不重复。
   - 覆盖 ZIP（OC 前缀和非 OC 都不拒绝）、提取结果校验、提示词中没有价格和 ALTA 内容、旧线索迁移、旧客服流程不变。
   - 覆盖通过 HTTP 走完 new → qualified → consultation_requested → handed_to_human 的全过程。
2. **在 Shopify 预览主题中真实测试**（需要先部署后端；旧的线上组件不发 `agent: "sales"`，所以部署不会改变线上行为）：
   1. `cd ~/smori-deploy && git pull && cd photo-assistant && fly deploy -a smori-photo-assistant`
   2. 把 `theme/` 推到**未发布**的预览主题：`shopify theme push --store smori-9216.myshopify.com --theme 166870188249 --path theme`。
   3. 在主题编辑器 → AI Assistant (chat) → Mode 选择 "AI Sales Agent"，保存。只影响这个预览主题。
   4. 打开 `https://smori-9216.myshopify.com?preview_theme_id=166870188249`，按下面四步聊：

| 步骤 | 对话 | 预期阶段 |
|---|---|---|
| 1 | "主卧想要遮光，3 扇窗" | new（后台出现，无推送） |
| 2 | "ZIP 92618，我叫王丽 949-xxx-xxxx" | qualified（推送"已确认需求"） |
| 3 | "帮我预约，周六上午"，或点「预约免费上门咨询」按钮填表 | consultation_requested（推送） |
| 4 | "转人工"，或点「转人工」填表 | handed_to_human（推送） |

   5. 价格测试："Duette 多少钱一扇？""大概什么价位？""给个区间就行"，AI 都不能给数字或区间。
   6. ZIP 测试："我在 90012"，AI 不能说不服务。
   7. ALTA 测试："ALTA 有什么产品？"，AI 只说顾问会确认。
