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

const PRICE_RE = /(\$\s?\d[\d,.]*k?|\d[\d,.]*\s?(美元|美金|元|块钱|块|刀|dollars?|usd)|\d+\s?%\s?(off|折扣|优惠)|\d(\.\d)?\s?折|几百|几千|上千|上万|hundreds of dollars|thousands of dollars|per (window|square (foot|feet)|sq\.?\s?ft))/gi;

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

const REFUSAL_RE = /(不服务|无法服务|不提供.{0,6}服务|不在.{0,8}服务(范围|区域)|超出.{0,8}服务(范围|区域)|服务不到|outside (of )?our service area|do(?:n't| not) (serve|cover|service)|not (in|within) our service area|can(?:'t|not) serve)/i;
const CONFIRM_RE = /(确认|核实|confirm|check)/i;

/** Sentences that turn a customer away because of location, without saying the team will confirm. */
export function refusals(reply: string): string[] {
  return sentences(reply).filter((s) => REFUSAL_RE.test(s) && !CONFIRM_RE.test(s));
}

const ASK_CUE_RE = /([？?]|方便|麻烦|请(您)?(留|提供|告诉|填)|留(下|个|一个)|提供一下|告诉我|可以给|may i|could you|can you|would you|please (share|leave|provide|send)|what(?:'s| is) your)/i;
const ZIP_RE = /(邮编|ZIP|zip code|postal code)/i;
const CONTACT_RE = /(电话|手机号|联系方式|邮箱|e-?mail|phone|contact (info|details)|称呼|姓名|名字|your name|how (should|may) (we|i) (address|call) you)/i;
const OWN_CONTACT_RE = /(949.?880.?1322|BonnieX@|致电|call us|打电话给我们|拨打)/i;

/** What the reply asks the customer for: their ZIP code and/or contact details (name, phone, email). */
export function contactAsks(reply: string): { zip: boolean; contact: boolean } {
  let zip = false;
  let contact = false;
  for (const s of sentences(reply)) {
    if (!ASK_CUE_RE.test(s)) continue;
    if (ZIP_RE.test(s)) zip = true;
    // "you can also call us at (949) 880-1322" gives OUR contact; only count it when it also asks for theirs
    const givesOursOnly = OWN_CONTACT_RE.test(s) && !/(您的|你的|your|留下|留个|留一个)/i.test(s);
    if (CONTACT_RE.test(s) && !givesOursOnly) contact = true;
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
export const STALE_SUMMARY_RE = /(尚未|还未|还没|没有|未)(留|提供|给|填)/;
