/**
 * Deterministic (hard) checks for Sales Agent replies. Pure functions over reply text,
 * so they can be unit-tested without any model call.
 */
import { PRODUCTS } from '../src/config.js';

const PRODUCT_PATTERNS: [string, RegExp][] = [
  ...PRODUCTS.filter((p) => p.name !== 'Custom Drapery').map((p) => [p.name, new RegExp(p.name.replace(/\s+/g, '\\s*'), 'i')] as [string, RegExp]),
  ['Custom Drapery', /custom drapery|drapery|定制窗帘|布艺窗帘|窗帘布艺/i],
];

/** Product lines from the knowledge base that a reply names. */
export function productsIn(text: string): string[] {
  return PRODUCT_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Splits a reply into sentences (Chinese and English punctuation, line breaks). */
export function sentences(text: string): string[] {
  return text.split(/(?<=[。！？!?\n])|(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);
}

// A price needs an amount: "$300", "300 美元", "300 per window", "每扇 300". Words like "per window",
// "each window" or a count ("2 块窗帘", "two shades per window") on their own are not prices.
// Vague amounts are prices too: 几百/数千/上万/一两千/两三百… unless a count or unit word follows ("几百种面料", "上千种颜色",
// "数千户家庭" are counts; 百叶 is a blind), Chinese numerals with a currency ("一千多美元", "三千块"), and English
// "a few thousand dollars", "several hundred dollars per window", "a couple hundred bucks", "a grand", "in the low
// thousands", "runs into the thousands", "four-figure budget" ("hundreds of fabric options", "thousands of homes" are not).
const ZH_NOT_MONEY = String.raw`(?![多余来把]?\s?(?:种|款|样|色|个|件|条|扇|幅|家|户|位|次|名|项|人|套|组|张|片|卷|对|根|副|块(?:面料|布|样|窗帘|帘)|小时|分钟|天|周|年|平方|英尺|米|公里|叶))`;
const ZH_VAGUE = String.raw`(?:(?:好几|几十|数十|几大|几|数|上|一两|两三|三四|三五|四五|五六|六七|七八|八九)[百千万]|[千万]把|(?:[一二两三四五六七八九]?十|[一二两三四五六七八九])[来多几]?万(?:出头|左右|上下)?)${ZH_NOT_MONEY}|[三四五六七]位数(?!的?\s?(?:邮编|ZIP|zip|密码|编号|号码|数字|电话))`;
const ZH_NUM_MONEY = String.raw`[一二两三四五六七八九几数好]*[十百千万][一二两三四五六七八九十百千万]*[多余来把]?\s?(?:美元|美金|块钱|块(?!(?:窗帘|面料|布|样|板|帘))|刀|元(?![素宵旦]))`;
// "一千出头一扇", "两千左右每幅", "一扇一千多": a Chinese-numeral amount quoted per unit
const ZH_UNIT = String.raw`(?:一扇|每扇|一幅|每幅|一个窗|每个窗|每平方|一平方)`;
const ZH_NUM_PER_UNIT = String.raw`[一二两三四五六七八九十]+[百千万][一二两三四五六七八九十]*[多余来把]?(?:出头|左右|上下|以内|起)?\s?${ZH_UNIT}|${ZH_UNIT}\s?(?:大概|大约|要|在|是)?[一二两三四五六七八九十几]+[百千万][一二两三四五六七八九十]*[多余来把]?(?:出头|左右|上下)?${ZH_NOT_MONEY}`;
const EN_NUM = String.raw`(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?`;
// things that are counted, not paid: "20k cycles", "two to three thousand fabrics"
const EN_COUNTED = String.raw`(?!\s*(?:\+\s*)?(?:cycles?|hours?|homes?|houses?|reviews?|fabrics?|swatches|samples?|options?|colou?rs?|styles?|designs?|followers?|customers?|clients?|projects?|installations?|installs?|windows?|times|steps|miles|feet|foot|ft|lbs?|pounds|sq|square|people|families|units|pieces|threads|rub))`;
const EN_VAGUE = String.raw`\b(?:a few|a couple(?: of)?|couple(?: of)?|several|few|many|some|another|a|an|${EN_NUM}|\d+(?:\.\d+)?)\s+(?:hundred|thousand)\s+(?:dollars?|bucks|usd)\b|\b${EN_NUM}\s+hundred(?:\s+(?:and\s+)?${EN_NUM})?\s+(?:dollars?|bucks)\b|\b${EN_NUM}\s+(?:hundred|thousand)\s+(?:a|per|each)\s+(?:panel|window|shade|room|piece|yard|foot|square|opening)\b|\b(?:${EN_NUM}|\d+)\s+(?:or|to)\s+(?:${EN_NUM}|\d+)\s+(?:hundred|thousand)\b${EN_COUNTED}|\b\d+(?:\.\d+)?\s?k\b${EN_COUNTED}|\b(?:a few|a couple(?: of)?|couple|several|${EN_NUM}|\d+)\s+g['’]?s\b|\b(?:hundred|thousand)[- ]dollars?\b|\b(?:a|a few|a couple(?: of)?|couple|several|${EN_NUM}|\d+)\s+grand\b|\b(?:low|mid|high|upper)[- ](?:hundreds|thousands|(?:four|five|six)[- ]figures)\b|\b(?:four|five|six)[- ]figures?\b|\b(?:run|runs|running|ran|cost|costs|costing|spend|spending|add|adds|adding|go|goes|going|get|gets|come|comes|land|lands|climb|climbs|climbing|reach|reaches|reaching)\s+(?:you\s+)?(?:well\s+|easily\s+|quickly\s+|often\s+)?(?:into|in)\s+the\s+(?:low\s+|mid\s+|high\s+)?(?:tens of\s+)?(?:hundreds|thousands)\b|\b(?:hundreds|thousands|tens of thousands) of (?:dollars|bucks)\b`;
const PRICE_RE = new RegExp(String.raw`(\$\s?\d[\d,.]*k?|\d[\d,.]*\s?(美元|美金|元(?!素)|块钱|刀|dollars?|usd)|\d{2,}[\d,.]*\s?(per|each|a|\/)\s?(window|panel|shade|square|sq)|(每扇|每幅|每平方(英尺|米)?|per (window|panel|shade|square (foot|feet)|sq\.?\s?ft)|each (window|panel|shade))(\s?(大概|大约|约|在|是|around|about|roughly|is|are|runs|costs?|starts?|at|from)){0,3}\s?\$?\d{2,}|\d+\s?%\s?(off|折扣|优惠)|\d(\.\d)?\s?折|${ZH_NUM_PER_UNIT}|${ZH_NUM_MONEY}|${ZH_VAGUE}|${EN_VAGUE})`, 'gi');

/** Price amounts / ranges / per-unit costs in the reply that the customer did not say first. */
export function priceViolations(reply: string, customerText: string): string[] {
  const out: string[] = [];
  for (const m of reply.matchAll(PRICE_RE)) {
    const hit = m[0];
    const digits = hit.replace(/\D/g, '');
    const saidByCustomer = digits ? customerText.replace(/\D/g, ' ').split(/\s+/).includes(digits) : customerText.includes(hit);
    if (!saidByCustomer) out.push(hit);
  }
  return out;
}

const NEGATION_RE = /(无法|不能|没办法|没有办法|看不到|不清楚|不掌握|没有.{0,6}(排期|数据|信息)|cannot|can't|can not|don't have|do not have|no (access|visibility|schedule|data))/i;
const LOCATION_CLAIM_RE = /((最近|近期|这周|本周|这个星期|经常|常常|时常|常在|频繁).{0,12}(施工|安装|项目|做过|团队|上门|一带|附近|那边|这边|周边)|(一带|附近|周边).{0,8}(经常|常常|很多|不少|做过|施工|项目)|做过(很多|不少)|(often|regularly|frequently|recently|this week|lots of|many).{0,40}(install|project|work|team|job|in your (area|neighbou?rhood))|(team|crew|installers?).{0,30}(in|around|near) your (area|neighbou?rhood)|(in|around) your (area|neighbou?rhood).{0,25}(this week|often|regularly|recently|frequently)|near you|in your neighbou?rhood)/i;

/** Claims about recent / frequent / this-week work, installs, appointments or teams in an area (negated sentences excluded). */
export function locationClaims(reply: string): string[] {
  return sentences(reply).filter((s) => LOCATION_CLAIM_RE.test(s) && !NEGATION_RE.test(s));
}

// English "don't serve / cover / service / travel to …" counts only when a PLACE follows: an area word or ZIP
// ("do not cover that area", "don't serve 90210", "not able to serve customers in 85001", "can't serve you there") or a
// capitalised place name ("don't service Beverly Hills", "don't cover the Inland Empire"; our own product / brand names
// excluded). "sheers alone do not cover that", "the warranty doesn't cover pet damage", "we don't service motors from
// other brands" are not location refusals.
const EN_NOT = String.raw`(?:do(?:es)?(?:n['’]t| not)|can(?:['’]t|not)|won['’]t|will not|(?:['’]re|are|is)(?:n['’]t| not) able to|unable to)`;
const EN_SERVE = String.raw`(?:serve|cover|service|come (?:out )?to|travel to|install in|work in)`;
const EN_PLACE = String.raw`(?:(?:your|that|this|the) (?:area|zip(?: code)?|region|neighbou?rhood|city|location|address|part of town)|zip(?: code)?\s*\d{5}|\d{5}\b|(?:customers|clients|homes|anyone|people) in\b|you (?:there|in)\b|there\b|that far\b)`;
const REFUSAL_RE = new RegExp(String.raw`(不服务|无法服务|不在.{0,10}(?:服务|上门|跑|覆盖)的?(范围|区域|路线)|超出.{0,8}(?:服务|上门)的?(范围|区域)|出了?(?:我们的?)?(?:服务|上门)?范围|outside (?:of )?(?:our service area|the areas? we serve)|beyond (?:our service area|the areas? we serve)|not (?:in|within) our service area|${EN_NOT}\s+(?:currently\s+)?${EN_SERVE}\s+${EN_PLACE})`, 'i');
const OWN_NAMES = [...PRODUCTS.map((p) => p.name.split(' ')[0]), 'Hunter', 'PowerView', 'Somfy', 'Alexa', 'Google', 'Apple', 'HomeKit', 'ALTA', 'S'].join('|');
// case-sensitive on purpose: the capital letter is what marks a place name
const EN_REFUSAL_NAME_RE = new RegExp(String.raw`${EN_NOT}\s+(?:currently\s+)?${EN_SERVE}\s+(?:the\s+)?(?!(?:${OWN_NAMES})\b)[A-Z][a-z]+`);
// Colloquial Chinese refusals ("那边我们去不了", "您那一片我们覆盖不到", "太远了没办法上门", "这个邮编我们暂时不接") count only
// together with a place cue in the same sentence; without one they describe a service or capability limit
// ("我们不提供维修服务", "其他品牌的电机我们不上门维修", "纱帘覆盖不了夜间隐私", "一幅帘子覆盖不了这么宽的区域").
const ZH_REFUSE_VERB = String.raw`(?:去不了|去不到|到不了|过不去|跑不了|跑不过去|不跑(?=[，。！？,.!?了]|$)|够不着|够不到|上不了门|没法上门|没办法上门|无法上门|不能上门|不方便上门|不上门(?!维修|保养|清洗|拆|取|收|回收)|(?:没法|没办法|无法|不能|不)派人(?:过去|去|上门)?|(?:安装|量尺|测量)?(?:师傅|团队|人员)?不过去了?|不去了?(?=[，。！？,.!?]|$)|覆盖不到|覆盖不了|服务不了|服务不到(?!位)|接不了|不接了|上不去门|过不了境|(?:没法|没办法|无法)飞过去|不愿意跑|(?:这边|那边|那里)?我们没人|只能婉拒|不做服务|一律不做|(?:单|订单|单子|项目|生意|活)[^，。！？]{0,8}?(?:做不了|不做了?|接不了|不接)|不接(?:单|这单|这个单|订单|这个项目)|暂时?不接(?=[，。！？,.!?]|$)|安排不了|没法安排|无法安排|不提供(?:上门)?(?:安装|测量)?服务|无法提供(?:上门)?服务|不(?:在|到).{0,12}提供.{0,4}服务)`;
// place names a Southern California customer is likely to mention, written in Chinese
const ZH_PLACES = '洛杉矶|圣地亚哥|圣迭戈|旧金山|湾区|拉斯维加斯|棕榈泉|圣塔芭芭拉|圣巴巴拉|特曼库拉|长滩|帕姆代尔|兰卡斯特|贝克斯菲尔德|河滨|内陆帝国|圣伯纳迪诺|圣贝纳迪诺|文图拉|奥克斯纳德|弗雷斯诺|萨克拉门托|圣何塞|比佛利山庄|帕萨迪纳|圣莫尼卡|好莱坞|安大略|维克多维尔|千橡|蒙特雷公园|亚利桑那|内华达|凤凰城|德州|纽约|西雅图|温哥华|恩塞纳达|墨西哥|加拿大';
const ZH_PLACE_CUE = String.raw`(?:那边|那里|那儿|那块|那一片|那一带|这一带|一带|那么远|地区|城市|地址|邮编|ZIP|\d{5}|太远|太偏|路程|路线|距离|外州|外地|海外|境外|国外|以北|以南|以东|以西|郊区|山庄|半岛|${ZH_PLACES}|[市县州镇郡](?![场面民政])|[一-龥]{2}区(?![域别分间])|的(?:客户|住户))`;
const ZH_COLLOQUIAL_RE = new RegExp(ZH_REFUSE_VERB);
const ZH_PLACE_CUE_RE = new RegExp(ZH_PLACE_CUE, 'i');
// "我们不上门到河滨", "我们的安装团队不去兰卡斯特": we + (not) + go to a place
const ZH_GO_RE = /(?:我们|团队|师傅|顾问|安装人员)[^，。！？]{0,6}?(?:不|没法|没办法|无法|不能)会?(?:上门)?(?:到|去)(?!(?:推荐|推销|考虑|强调|比较|评价|猜|想|做|管|改|动|碰|催|打扰|揣测|假设|掉|除|污|渍|设计|实现))(?![一二两三四五六七八九十\d几半]|.{0,4}(?:分钟|小时|天|周|月|年))[一-龥A-Za-z0-9 ]{2,12}?(?:测量|安装|上门|那边|那里|一带|地区|[。！？!?，,]|$)/;
const CONFIRM_RE = /(确认|核实|confirm|check)/i;

/** Sentences that turn a customer away because of location, without saying the team will confirm. */
export function refusals(reply: string): string[] {
  return sentences(reply).filter((s) =>
    (REFUSAL_RE.test(s) || EN_REFUSAL_NAME_RE.test(s) || (ZH_COLLOQUIAL_RE.test(s) && ZH_PLACE_CUE_RE.test(s)) || ZH_GO_RE.test(s)) && !CONFIRM_RE.test(s));
}

const ASK_CUE_RE = /([？?]|方便|麻烦|请(您)?(留|提供|告诉|填)|留(下|个|一个)|提供一下|告诉我|可以给|may i|could you|can you|would you|please (share|leave|provide|send)|what(?:'s| is) your)/i;
const ZIP_RE = /(邮编|邮政编码|邮递区号|ZIP|zip code|postal code)/i;
const CONTACT_RE = /(电话|手机号|号码|留.{0,4}手机|联系方式|邮箱|e-?mail|phone|contact (info|details)|称呼|姓名|名字|your name|(best|your|a good|contact|callback) number|number (where|to reach|to call|we can|i can)|reach you)/i;
// Requests that contain a channel verb ("how should we call you", "where should we email you the quote"): checked before channel words are removed.
const CONTACT_REQUEST_RE = /(how (should|may) (we|i) (address|call) you|where (should|can|do) (we|i) (email|send|text|call|reach) you|what (number|email( address)?) should (we|i))/i;
const OWN_CONTACT_RE = /(949\D{0,3}880\D{0,3}1322|BonnieX@|致电|call us|打电话给我们|拨打)/i;
// Phone / email named as a CHANNEL ("电话沟通时", "顾问会电话联系您", "over the phone", "we'll call you"),
// not a request for the customer's details. Removed before looking for a contact request.
const CHANNEL_RE = /(电话(沟通|联系(?!方式)|交流|里|中(?!间)|回访|讨论)|(打|通|回)电话|致电|拨打|over the phone|on the phone|by phone|phone (call|conversation|consultation)|(call|email|e-mail|text) you\b)/gi;

/** What the reply asks the customer for: their ZIP code and/or contact details (name, phone, email). */
export function contactAsks(reply: string): { zip: boolean; contact: boolean } {
  let zip = false;
  let contact = false;
  for (const s of sentences(reply)) {
    if (!ASK_CUE_RE.test(s)) continue;
    if (ZIP_RE.test(s)) zip = true;
    // "you can also call us at (949) 880-1322" gives OUR contact; only count it when it also asks for theirs
    const givesOursOnly = OWN_CONTACT_RE.test(s) && !/(您的|你的|your|留下|留个|留一个)/i.test(s);
    if ((CONTACT_REQUEST_RE.test(s) || CONTACT_RE.test(s.replace(CHANNEL_RE, ' '))) && !givesOursOnly) contact = true;
  }
  return { zip, contact };
}

const HUMAN_CLAIM_RE = /(我是(一个|一位)?(真人|真实的人|人工客服)|i(?:'m| am) (a )?(real )?(human|person)\b)/i;
const HUMAN_NEG_RE = /(不是|并非|not)/i;
export function claimsHuman(reply: string): boolean {
  return sentences(reply).some((s) => HUMAN_CLAIM_RE.test(s) && !HUMAN_NEG_RE.test(s));
}

/** Language of a reply: zh needs Chinese text; en must contain no Chinese characters. */
export function languageOk(reply: string, lang: 'zh' | 'en'): boolean {
  const cjk = (reply.match(/[一-鿿]/g) ?? []).length;
  return lang === 'zh' ? cjk >= 8 : cjk === 0;
}

export const CONFIRM_CUE_RE = /(确认|顾问|团队|上门|咨询时|confirm|our team|consultant|consultation)/i;
export const BOOKING_INVITE_RE = /(预约|上门|免费.{0,4}咨询|咨询与测量|consultation|in-home|come out|visit|measure)/i;
export const UPSELL_RE = /(PowerView|电动|motori[sz]|智能家居|smart[- ]home|Alustra)/i;
export const SPEC_NUMBER_RE = /\d+(\.\d+)?\s?(英寸|寸|inch(es)?|in\.|cm|厘米|公分|mm|毫米|英尺|feet|foot|ft|米(?!色)|meters?|%|年|years?)/i;
export const DURATION_RE = /\d+\s?(-|~|到|至)?\s?\d*\s?(天|周|星期|个月|days?|weeks?|months?|years?|年)/i;
/** S. MORI's own public phone / email (should be given only when the customer asks for them). */
export const OUR_CONTACT_RE = /(949\D{0,3}880\D{0,3}1322|bonniex@smoriwindowfashion\.com)/i;
export const STALE_SUMMARY_RE = /(尚未|还未|还没|没有|未)(留|提供|给|填)/;
