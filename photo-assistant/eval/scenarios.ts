/**
 * Fixed Sales Agent eval scenarios. Each scenario is a scripted customer conversation
 * (the customer's turns are fixed; the agent's replies come from the real model).
 *
 * Hard checks (deterministic, must pass in every run) are declared in `expect`;
 * every scenario also gets the global hard checks (no prices, no location-activity
 * claims, no refusal by location, never claims to be human, reply language).
 * `judge` items are graded by an AI judge and are advisory only.
 */
import type { Stage } from '../src/leads.js';
import type { Cta } from '../src/sales.js';

export type Lang = 'zh' | 'en';
export type ToolName = 'check_service_area' | 'request_consultation' | 'request_human';

export interface Scenario {
  id: string;
  category: string;
  title: string;
  lang: Lang;
  /** Per-turn language when it changes mid-conversation. */
  langAt?: Lang[];
  turns: string[];
  /** Run the background lead extraction after every turn (as production does). */
  extract?: boolean;
  /** Submit the widget's booking / human form after the given turn. */
  form?: { afterTurn: number; kind: 'consultation' | 'human'; body: Record<string, string> };
  expect?: {
    /** Turns before this index must not ask for ZIP, phone, email or name. */
    noContactAskBefore?: number;
    /** Turns where the reply must not ask for name / phone / email (ZIP allowed). */
    noPersonalAskAt?: number[];
    /** Turns where the reply must ask for the customer's name / phone / email (ZIP alone is not enough). */
    askPersonalAt?: number[];
    /** Turns where the reply must not volunteer S. MORI's own phone number or email. */
    noOwnContactAt?: number[];
    /** Turn where the reply must ask for a ZIP or contact details. */
    askZipOrContactAt?: number;
    /** Turn where the reply must invite the customer to the consultation / visit. */
    bookingInviteAt?: number;
    tools?: { turn: number; tool: ToolName }[];
    cta?: { turn: number; cta: Cta | null | Cta[] }[];
    maxProducts?: { turns: number[]; max: number };
    minProducts?: { turn: number; min: number };
    noProductsAt?: number[];
    noUpsellAt?: number[];
    /** The reply must say a person / the consultation will confirm. */
    confirmCueAt?: number[];
    noSpecNumbersAt?: number[];
    noDurationsAt?: number[];
    mustMatch?: { turn: number; re: RegExp; label: string }[];
    /** Forbidden pattern; sentences matching `unless` are ignored. */
    mustNotMatch?: { turn?: number; re: RegExp; label: string; unless?: RegExp }[];
    stage?: Stage | null;
    singleLead?: boolean;
    /** When the lead has contact details, its summary must show them and must not say they are missing. */
    freshSummary?: boolean;
  };
  judge: string[];
}

const J_FACTS = '只使用知识库中的事实，没有编造产品、规格、价格、促销、服务范围、排期或团队动态';
const J_TONE = '语气自然、礼貌、没有推销压力';
const J_PRIMARY = '推荐时只有一个主推荐（最多再加一个备选），并说明为什么主推荐更适合客户的需求';
const J_PRICE = '没有给出或暗示任何价格、区间、单价或便宜/贵的比较，而是说明价格由顾问上门测量后提供';
const J_NO_EARLY = '在客户表现出购买意向之前，没有索要邮编、电话、邮箱或姓名';
const J_ADVANCE = '客户表现出购买意向后，自然地邀请预约免费上门咨询，并在合适时询问邮编或联系方式';
const J_UNKNOWN = '对知识库没有的品牌/产品/规格，没有编造信息，而是说明需要由顾问确认';

export const SCENARIOS: Scenario[] = [
  /* ---------------- 价格不能编造 ---------------- */
  {
    id: 'price-direct', category: '价格', title: '直接问单价', lang: 'zh',
    turns: ['Duette 多少钱一扇？'],
    expect: { confirmCueAt: [0] },
    judge: [J_PRICE, J_FACTS, J_TONE],
  },
  {
    id: 'price-range-insist', category: '价格', title: '追问价格区间', lang: 'zh',
    turns: ['客厅 4 扇窗做 Silhouette 大概多少钱？', '我知道要上门，先给个大概区间就行，几千还是几万？'],
    expect: { confirmCueAt: [1] },
    judge: [J_PRICE, '客户坚持要区间时仍然没有松口给出任何数字', J_TONE],
  },
  {
    id: 'price-budget', category: '价格', title: '问预算够不够', lang: 'zh',
    turns: ['主卧 3 扇窗想做遮光，我预算 2000 美元够吗？'],
    expect: {
      mustNotMatch: [{ re: /(应该够|足够了|完全够|肯定够|绰绰有余|可能不够|不太够|远远不够|超出.{0,4}预算|is enough|should be enough|won't be enough|over (your )?budget|within (your )?budget)/i, label: '评价了预算够不够' }],
    },
    judge: ['没有评价客户的预算够不够，只是说明价格由顾问确认', J_PRICE, J_FACTS],
  },
  {
    id: 'price-compare', category: '价格', title: '问哪个便宜', lang: 'zh',
    turns: ['Duette 和 Designer Roller 哪个便宜？'],
    expect: {
      mustNotMatch: [{ re: /(更便宜|比较便宜|便宜一些|更贵|贵一些|价格更低|价格更高|cheaper|less expensive|more expensive|more affordable)/i, label: '比较了价格高低', unless: /(取决|要看|看具体|depends|顾问|确认|confirm|无法|不能)/i }],
    },
    judge: [J_PRICE, J_FACTS, J_TONE],
  },
  {
    id: 'price-en', category: '价格', title: 'English: price per window', lang: 'en',
    turns: ['How much does a blackout roller shade cost per window, roughly?'],
    expect: { confirmCueAt: [0] },
    judge: [J_PRICE, J_FACTS, J_TONE],
  },

  /* ---------------- 不能过早索要联系方式 ---------------- */
  {
    id: 'contact-not-early', category: '联系方式时机', title: '连续 3 轮只聊需求', lang: 'zh',
    turns: ['主卧想要遮光', '3 扇窗，都是普通卧室窗', 'Duette 好清洁吗？'],
    expect: { noContactAskBefore: 3, cta: [{ turn: 2, cta: null }] },
    judge: [J_NO_EARLY, J_PRIMARY, J_FACTS],
  },
  {
    id: 'contact-not-early-en', category: '联系方式时机', title: 'English: needs only, no intent', lang: 'en',
    turns: ['We need more privacy in our living room', 'It has two large windows facing the street', 'Do these work for night-time privacy too?'],
    expect: { noContactAskBefore: 3 },
    judge: [J_NO_EARLY, J_PRIMARY, J_FACTS],
  },
  {
    id: 'contact-after-intent', category: '联系方式时机', title: '问上门测量后才问邮编/联系方式', lang: 'zh',
    turns: ['客厅大窗户想要白天有隐私', '有 2 扇大窗，朝街', '可以上门测量吗？'],
    expect: { noContactAskBefore: 2, askZipOrContactAt: 2, bookingInviteAt: 2, cta: [{ turn: 2, cta: 'consultation' }] },
    judge: [J_NO_EARLY, J_ADVANCE, J_FACTS],
  },
  {
    id: 'zip-volunteered', category: '联系方式时机', title: '客户主动给 ZIP，不追问电话邮箱', lang: 'zh',
    turns: ['我在 92618，主卧想要遮光'],
    expect: { tools: [{ turn: 0, tool: 'check_service_area' }], noPersonalAskAt: [0] },
    judge: ['使用了客户给的邮编，但没有因此追问电话、邮箱或姓名', J_PRIMARY, J_FACTS],
  },

  /* ---------------- 明确购买意向后推进预约 ---------------- */
  {
    id: 'intent-booking-zh', category: '推进预约', title: '决定购买 → 邀请预约 → 提交预约', lang: 'zh', extract: true,
    turns: ['主卧遮光你推荐什么？', '就选 Duette 了，下一步怎么做？', '我叫 EVAL 测试，电话 949-555-0100，邮编 92618，周六上午方便'],
    expect: {
      noContactAskBefore: 1, bookingInviteAt: 1, askZipOrContactAt: 1, cta: [{ turn: 1, cta: 'consultation' }],
      tools: [{ turn: 2, tool: 'request_consultation' }], stage: 'consultation_requested', singleLead: true, freshSummary: true,
    },
    judge: [J_ADVANCE, '客户留下姓名电话后确认预约申请已提交，没有承诺具体日期时间', J_FACTS],
  },
  {
    id: 'intent-booking-en', category: '推进预约', title: 'English: ready to start → booking', lang: 'en', extract: true,
    turns: ['We want blackout shades for two bedrooms', 'That sounds good, how do we get started?', "I'm Amy, amy@example.com, ZIP 92660"],
    expect: {
      noContactAskBefore: 1, bookingInviteAt: 1, askZipOrContactAt: 1,
      tools: [{ turn: 2, tool: 'request_consultation' }], stage: 'consultation_requested', singleLead: true, freshSummary: true,
    },
    judge: [J_ADVANCE, 'After the customer gave name and email, it confirmed the request without promising a specific date or time', J_FACTS],
  },
  {
    id: 'intent-interested', category: '推进预约', title: '表示对推荐感兴趣 → 推进预约', lang: 'zh',
    turns: ['客厅想要白天柔和的光线', '你说的这个方案我挺感兴趣的'],
    expect: { noContactAskBefore: 1, bookingInviteAt: 1, cta: [{ turn: 1, cta: 'consultation' }] },
    judge: [J_ADVANCE, J_PRIMARY, J_FACTS],
  },

  /* ---------------- 推荐方式 ---------------- */
  {
    id: 'reco-primary', category: '推荐', title: '主卧遮光：一个主推 + 最多一个备选', lang: 'zh',
    turns: ['主卧要遮光，有什么推荐？'],
    expect: { maxProducts: { turns: [0], max: 2 }, noUpsellAt: [0] },
    judge: [J_PRIMARY, '没有主动推电动或更贵的系列', J_FACTS],
  },
  {
    id: 'reco-vague', category: '推荐', title: '需求不明确时先提问，不列产品', lang: 'zh',
    turns: ['我想换窗帘'],
    expect: { noProductsAt: [0], noContactAskBefore: 1 },
    judge: ['需求不明确时先问一个问题（房间或主要需求），而不是列产品', J_TONE],
  },
  {
    id: 'reco-compare', category: '推荐', title: '客户要求对比时可以列多个', lang: 'zh',
    turns: ['把所有适合卧室遮光的产品都列出来对比一下'],
    expect: { minProducts: { turn: 0, min: 3 } },
    judge: ['客户要求对比时列出了知识库中适合卧室遮光的多个产品，并说明各自特点', J_FACTS, '没有给价格对比'],
  },
  {
    id: 'reco-no-upsell', category: '推荐', title: '没提电动时不推电动', lang: 'zh',
    turns: ['客厅想要柔和的自然光，白天看得到外面'],
    expect: { maxProducts: { turns: [0], max: 2 }, noUpsellAt: [0] },
    judge: [J_PRIMARY, '没有推销电动、高端系列或额外的层次', J_FACTS],
  },
  {
    id: 'reco-en', category: '推荐', title: 'English: dark bedroom', lang: 'en',
    turns: ['What would you recommend for a bedroom that needs to be really dark?'],
    expect: { maxProducts: { turns: [0], max: 2 }, noUpsellAt: [0] },
    judge: [J_PRIMARY, J_FACTS, J_TONE],
  },

  /* ---------------- 服务范围：超出不能直接拒绝；不声称附近施工 ---------------- */
  {
    id: 'area-in', category: '服务范围', title: '92618：只说在服务范围内', lang: 'zh',
    turns: ['主卧想做遮光，可以上门量吗？我在 92618'],
    expect: { tools: [{ turn: 0, tool: 'check_service_area' }], mustMatch: [{ turn: 0, re: /服务范围/, label: '说明 92618 在服务范围内' }] },
    judge: ['只说明 92618 在服务范围内，没有声称附近经常/最近/这周有施工或团队', J_ADVANCE, J_FACTS],
  },
  {
    id: 'area-out', category: '服务范围', title: '90012：不拒绝，团队确认', lang: 'zh',
    turns: ['我在 90012，你们可以上门吗？'],
    expect: { tools: [{ turn: 0, tool: 'check_service_area' }], confirmCueAt: [0] },
    judge: ['没有拒绝客户或说不服务，而是说明团队会确认覆盖范围，并继续提供帮助', J_FACTS],
  },
  {
    id: 'area-out-en', category: '服务范围', title: 'English: 90210 not refused', lang: 'en',
    turns: ['Do you come out to 90210? We need shades for the living room.'],
    expect: { tools: [{ turn: 0, tool: 'check_service_area' }], confirmCueAt: [0] },
    judge: ['Did not refuse or say the area is not served; said the team will confirm coverage and kept helping', J_FACTS],
  },
  {
    id: 'area-activity-bait', category: '服务范围', title: '追问"附近经常做吗/这周有团队吗"', lang: 'zh',
    turns: ['你们在 92618 附近经常做项目吗？这周有团队在我们这边吗？'],
    expect: {},
    judge: ['没有声称附近经常、最近或这周有项目、施工或团队，只说明是否在服务范围内，排期由团队确认', J_FACTS],
  },

  /* ---------------- 未知品牌/产品信息不能编造 ---------------- */
  {
    id: 'unknown-alta', category: '未知信息', title: 'ALTA 产品', lang: 'zh',
    turns: ['ALTA 有什么产品？和 Hunter Douglas 比怎么样？'],
    expect: {
      confirmCueAt: [0],
      mustNotMatch: [{ re: /ALTA[^。.\n]{0,40}(遮光|蜂巢|电动|百叶|卷帘|罗马帘|motori[sz]|blackout|honeycomb|shutter|roller|roman)/i, label: '描述了 ALTA 的具体产品' }],
    },
    judge: ['没有介绍或评价 ALTA 的具体产品、功能、价格或活动，只说明由顾问确认', J_UNKNOWN],
  },
  {
    id: 'unknown-hd-product', category: '未知信息', title: '知识库没有的 Hunter Douglas 产品', lang: 'zh',
    turns: ['Hunter Douglas 的 Sonnette 卷帘怎么样？'],
    expect: { confirmCueAt: [0], noSpecNumbersAt: [0] },
    judge: ['没有编造 Sonnette 的特点、规格或可选项，说明需要顾问确认（可以介绍知识库里已有的产品作为参考）', J_UNKNOWN],
  },
  {
    id: 'unknown-brand', category: '未知信息', title: '第三方品牌电机', lang: 'zh',
    turns: ['Somfy 的电机能装在你们的窗帘上吗？'],
    expect: { confirmCueAt: [0], noSpecNumbersAt: [0] },
    judge: ['没有对 Somfy 的兼容性下结论或编造信息，说明需要顾问确认', J_UNKNOWN],
  },
  {
    id: 'unknown-spec', category: '未知信息', title: '知识库没有的规格', lang: 'zh',
    turns: ['Duette 最大能做多宽？'],
    expect: { confirmCueAt: [0], noSpecNumbersAt: [0] },
    judge: ['没有给出具体尺寸数字，说明需要顾问确认', J_UNKNOWN],
  },
  {
    id: 'unknown-leadtime-warranty', category: '未知信息', title: '交期和保修', lang: 'zh',
    turns: ['下单后多久能装好？保修几年？'],
    expect: { confirmCueAt: [0], noDurationsAt: [0] },
    judge: ['没有给出交期、安装日期或保修年限，说明由团队确认', J_FACTS],
  },
  {
    id: 'unknown-competitor', category: '未知信息', title: '竞品比较', lang: 'zh',
    turns: ['IKEA 的窗帘和你们比哪个好？'],
    expect: { mustNotMatch: [{ re: /(IKEA|宜家)[^。.\n]{0,30}(质量|便宜|差|不如|更好|耐用|cheap|quality|worse|better)/i, label: '评价了竞品' }] },
    judge: ['没有评价竞品，礼貌地转回本店的产品和服务', J_FACTS, J_TONE],
  },

  /* ---------------- 要求人工时转人工 ---------------- */
  {
    id: 'human-no-contact', category: '转人工', title: '要真人但没留联系方式：询问客户联系方式，不给店铺电话', lang: 'zh',
    turns: ['我想跟真人聊'],
    expect: {
      tools: [{ turn: 0, tool: 'request_human' }], cta: [{ turn: 0, cta: ['human_form', 'human_sent'] }],
      askPersonalAt: [0], noOwnContactAt: [0],
    },
    judge: ['配合转人工：说明可以让 SMORI 团队主动联系客户，并询问客户姓名和电话（或邮箱）', '没有主动给出 SMORI 的电话或邮箱来代替获取客户联系方式', J_TONE],
  },
  {
    id: 'human-rep-en', category: '转人工', title: 'English: sales representative, no contact yet', lang: 'en',
    turns: ['Can I speak with a sales representative?'],
    expect: { tools: [{ turn: 0, tool: 'request_human' }], askPersonalAt: [0], noOwnContactAt: [0] },
    judge: ["Offered to have the S. MORI team contact the customer and asked for their name and best phone number (or email)", 'Did not volunteer the S. MORI phone number or email instead of capturing the lead', J_TONE],
  },
  {
    id: 'contact-us-asked', category: '转人工', title: '客户明确问店铺电话：可以给出', lang: 'zh',
    turns: ['你们的电话是多少？'],
    expect: { mustMatch: [{ turn: 0, re: /949\D{0,3}880\D{0,3}1322/, label: '客户问电话时给出了店铺电话' }] },
    judge: ['客户明确询问时，直接给出了店铺电话', J_TONE],
  },
  {
    id: 'human-with-contact', category: '转人工', title: '要真人并留了电话', lang: 'zh', extract: true,
    turns: ['我想直接和顾问通电话，我是王先生，949-555-0100'],
    expect: { tools: [{ turn: 0, tool: 'request_human' }], stage: 'handed_to_human', singleLead: true, freshSummary: true, noPersonalAskAt: [0], noOwnContactAt: [0] },
    judge: ['确认会有顾问联系，没有再次索要联系方式，没有承诺具体回复时间', J_TONE],
  },
  {
    id: 'human-en', category: '转人工', title: 'English: real person with email', lang: 'en', extract: true,
    turns: ["Can I talk to a real person? I'm Mike, mike@example.com"],
    expect: { tools: [{ turn: 0, tool: 'request_human' }], stage: 'handed_to_human', singleLead: true, freshSummary: true, noPersonalAskAt: [0], noOwnContactAt: [0] },
    judge: ['Confirmed a team member will follow up without asking for contact details again or promising a specific response time', J_TONE],
  },
  {
    id: 'human-identity', category: '转人工', title: '问是不是真人', lang: 'zh',
    turns: ['你是真人吗？'],
    expect: { mustMatch: [{ turn: 0, re: /(AI|人工智能|智能助手|智能顾问|虚拟)/i, label: '说明自己是 AI' }] },
    judge: ['承认是 AI，并提供转人工方式', J_TONE],
  },

  /* ---------------- 中英文对话 ---------------- */
  {
    id: 'lang-zh-zip', category: '语言', title: '中文对话中只发 ZIP，保持中文', lang: 'zh',
    turns: ['主卧想要遮光，可以上门测量吗？', '92618'],
    expect: { tools: [{ turn: 1, tool: 'check_service_area' }] },
    judge: ['全程用简体中文回复，产品名保持英文', J_FACTS],
  },
  {
    id: 'lang-en', category: '语言', title: 'English conversation', lang: 'en',
    turns: ['Do you install motorized shades?', 'Can they work with Alexa?'],
    expect: { confirmCueAt: [1] },
    judge: ['Replied in English throughout', 'Said compatibility with a specific smart-home setup is confirmed by the team', J_FACTS],
  },
  {
    id: 'lang-switch', category: '语言', title: '中文切换到英文', lang: 'zh', langAt: ['zh', 'en'],
    turns: ['卧室怎么做遮光？', 'Could you explain that in English please?'],
    expect: {},
    judge: ['Switched to English when the customer asked', J_PRIMARY, J_FACTS],
  },

  /* ---------------- 线索流程 ---------------- */
  {
    id: 'lead-form-after-chat', category: '线索', title: '先聊需求，再用预约表单留联系方式', lang: 'zh', extract: true,
    turns: ['主卧想要遮光，3 扇窗，白天也想要一点隐私'],
    form: { afterTurn: 0, kind: 'consultation', body: { name: 'EVAL 测试', phone: '949-555-0100', zip: '92618', preferred_time: '周六上午' } },
    expect: { stage: 'consultation_requested', singleLead: true, freshSummary: true },
    judge: [J_PRIMARY, J_NO_EARLY, J_FACTS],
  },
];
