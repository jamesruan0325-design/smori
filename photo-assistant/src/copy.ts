import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { config, CATEGORIES, PRODUCTS } from './config.js';
import { forClaude } from './images.js';
import { photoPath, type Project, type GeneratedCopy, type PhotoScreen } from './store.js';

const Block = z.object({
  type: z.enum(['heading', 'paragraph', 'list']),
  text: z.string().optional(),
  items: z.array(z.string()).optional(),
});

const CopySchema = z.object({
  title: z.string().describe('English title, 3-7 words, e.g. "Coastal Light in Newport Beach"'),
  title_zh: z.string().describe('中文标题，8-16 字'),
  subtitle: z.string().describe('English subtitle naming the product and room, e.g. "Silhouette shadings in a coastal living room"'),
  subtitle_zh: z.string(),
  summary: z.string().describe('English, 1-2 sentences (max 45 words) for the card and page intro'),
  summary_zh: z.string().describe('中文，1-2 句（60 字以内）'),
  description: z.array(Block).describe('English project story: 2-4 short sections. Use heading blocks like "The brief", "Our solution", "The result"; paragraphs of 2-4 sentences; at most one list.'),
  description_zh: z.array(Block).describe('中文项目介绍，结构同英文，不是逐句翻译，要符合中文阅读习惯'),
  room_observed: z.string().describe('Room type as visible in the photos (e.g. "Living Room"). Empty string if unclear. Only a suggestion for staff.'),
  room_observed_zh: z.string(),
  photo_captions: z.array(z.object({ index: z.number(), caption: z.string(), caption_zh: z.string() })).describe('One short alt-text caption per photo, index = photo number starting at 1'),
  cover_index: z.number().describe('1-based index of the photo that best represents the project'),
  xhs_title: z.string().describe('小红书标题，20 字以内，可带 1 个 emoji'),
  xhs_body: z.string().describe('小红书正文，200-400 字，口语化但不浮夸，结尾 3-6 个话题标签，如 #窗帘 #尔湾 #HunterDouglas'),
  warnings: z.array(z.string()).describe('Anything staff should check before publishing: visible faces, house numbers, mismatch between the stated product and what is visible, low-quality photos. Empty if none.'),
});

export type CopyOutput = z.infer<typeof CopySchema>;

const BRAND = `You write website case studies for S. MORI Window Fashion (smoriwindowfashion.com), a luxury window-treatment studio in Irvine, California (showroom: 23 Mauchly Suite 106, Irvine, CA 92618) serving Southern California. S. MORI curates Hunter Douglas products and custom drapery, offers in-home consultation, precise measurement, custom fabrication and white-glove installation.

Voice: refined, calm, confident. Short sentences. Concrete details about light, privacy, fabric, hardware and how the room feels. No superlatives ("best", "amazing"), no exclamation marks, no prices, no delivery promises, no invented client names or quotes, no claims about energy savings percentages.

Chinese copy: 用简体中文，面向南加州华人业主，语气高端克制；专有名词（Silhouette、Duette、PowerView 等）保留英文；不要逐句直译英文。`;

const RULES = `HARD RULES
1. The product name, category and location below were confirmed by staff. They are facts. Use them exactly; never replace the product with another product you think you see, and never mention a different Hunter Douglas product as the installed product.
2. Do not guess the city or neighbourhood from the photos; use only the given location.
3. Describe only what is actually visible in the photos (window shapes, light, colours, furniture style). If a detail is not visible, leave it out rather than invent it.
4. If what is visible seems to contradict the stated product, still write the copy using the stated product and add a warning.
5. Do not describe or mention people, faces, house numbers or personal items.`;

const ScreenSchema = z.object({
  is_installation: z.boolean().describe('true only if the photo shows a window treatment (shades, blinds, shutters, drapery) installed in a room or building — not a screenshot, document, person, pet, food, street, product box or showroom sample book'),
  installation_confidence: z.number().min(0).max(1),
  product: z.enum(['Silhouette', 'Luminette', 'Duette', 'Pirouette', 'Vignette', 'PowerView', 'Designer Roller', 'Alustra', 'Custom Drapery', 'shutters', 'other', 'unknown']).describe('Which product line is most likely installed. Use "unknown" when the treatment is not clearly visible.'),
  product_confidence: z.number().min(0).max(1).describe('How sure you are about the product. Be conservative: Silhouette vs Pirouette vs Vignette can look alike.'),
  category: z.enum(['sheer', 'blackout', 'signature', 'motorized', 'drapery', 'shutters', 'commercial']),
  room: z.string().describe('Room type in English, e.g. "Living Room"; empty if unclear'),
  room_zh: z.string(),
  notes: z.string().describe('One short sentence: the visual cue that led to the product decision'),
});

const CUES = `Visual cues for product lines (Hunter Douglas unless noted):
- Silhouette: horizontal soft S-shaped fabric vanes suspended between two sheer layers; looks like floating horizontal slats behind a veil.
- Pirouette: soft horizontal fabric folds/vanes attached to a single sheer backing; folds are fuller and more three-dimensional than Silhouette.
- Luminette: VERTICAL sheer panels with rotating vertical fabric vanes; usually on sliding doors or very wide windows.
- Duette: honeycomb/cellular shade; the profile shows hexagonal cells; flat pleated look from the front.
- Vignette: Roman shade with consistent soft horizontal folds, no visible rear cords.
- Designer Roller: flat roller shade with a single sheet of fabric on a tube; clean, minimal.
- Alustra: luxury woven wood/textured fabric collection; only pick it when a distinctive woven texture is clearly visible.
- PowerView: only when motorization is evident (no cords, visible remote, motor headrail, or several shades at identical positions); combine with the treatment type in notes.
- Custom Drapery: fabric drapery panels or sheers hung on a rod or track.
- shutters: hinged louvered panels (plantation shutters).
- other: a treatment that is none of the above. unknown: cannot tell.
Category mapping: Silhouette/Luminette/Pirouette -> sheer; Duette/Designer Roller -> blackout; Vignette/Alustra -> signature; PowerView -> motorized; Custom Drapery -> drapery; shutters -> shutters; commercial spaces (office, store, restaurant) -> commercial.`;

export type Screener = (jpeg: Buffer) => Promise<PhotoScreen>;

/** Classifies one photo: installation or not, product line + confidence, room. Uses the cheaper screening model. */
export const claudeScreen: Screener = async (jpeg) => {
  if (!claudeConfigured()) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: config.screenModel,
    max_tokens: 2000,
    system: `You screen photos from an installer's phone for S. MORI Window Fashion (Irvine, CA). Decide whether a photo shows an installed window treatment and which product line it is. ${CUES}`,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
      { type: 'text', text: 'Classify this photo.' },
    ] }],
    output_config: { format: zodOutputFormat(ScreenSchema) },
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    return { is_installation: false, installation_confidence: 0, product: 'unknown', product_confidence: 0, category: 'sheer', room: '', room_zh: '', notes: `screening unavailable (${response.stop_reason})` };
  }
  return response.parsed_output;
};

export function claudeConfigured(): boolean {
  return config.hasAnthropicKey;
}

export async function generateCopy(project: Project, onLog: (m: string) => void = () => {}): Promise<GeneratedCopy> {
  if (!claudeConfigured()) throw new Error('ANTHROPIC_API_KEY is not set');
  if (!project.photos.length) throw new Error('add at least one photo first');

  const client = new Anthropic();
  const cat = CATEGORIES.find((c) => c.value === project.facts.category);
  const product = PRODUCTS.find((p) => p.name.toLowerCase() === project.facts.product_name.toLowerCase());

  const content: Anthropic.ContentBlockParam[] = [];
  const photos = project.photos.slice(0, 12);
  for (const [i, photo] of photos.entries()) {
    const data = (await forClaude(photoPath(project.id, 'web', photo.id + '.jpg'))).toString('base64');
    content.push({ type: 'text', text: `Photo ${i + 1} of ${photos.length}${photo.cover ? ' (current cover)' : ''}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
  }

  const facts = {
    product_name: project.facts.product_name,
    product_line_notes: product ? `${product.subtitle} — ${product.notes}` : '(not one of the standard lines; treat the name as given)',
    category: `${project.facts.category}${cat ? ` (${cat.label} / ${cat.zh})` : ''}`,
    location: project.facts.location,
    room: project.facts.room || '(not provided — you may suggest one in room_observed)',
    installed_on: project.facts.installed_on || '(not provided)',
    staff_notes: project.facts.notes || '(none)',
    how_product_was_determined: project.auto ? `identified from the photos by an automated screening step (confidence ${Math.round((project.auto.confidence ?? 0) * 100)}%); treat it as the fact to use` : 'confirmed by staff',
    working_title: project.facts.title || '(none)',
  };
  content.push({ type: 'text', text: `${RULES}\n\nCONFIRMED FACTS (JSON):\n${JSON.stringify(facts, null, 2)}\n\nProduct lines S. MORI sells, for reference only:\n${PRODUCTS.map((p) => `- ${p.name} (${p.subtitle}): ${p.notes}`).join('\n')}\n\nWrite the case study now.` });

  onLog(`asking ${config.claudeModel} with ${photos.length} photo(s)…`);
  const response = await client.messages.parse({
    model: config.claudeModel,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: BRAND,
    messages: [{ role: 'user', content }],
    output_config: { format: zodOutputFormat(CopySchema) },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`The model declined this request (${response.stop_details?.explanation ?? 'no explanation'}). Check the photos and try again.`);
  }
  const out = response.parsed_output;
  if (!out) throw new Error(`Could not parse the model output (stop_reason=${response.stop_reason})`);
  onLog(`done: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens`);

  // apply captions + cover suggestion to the project photos (staff can still change them)
  for (const c of out.photo_captions) {
    const p = photos[c.index - 1];
    if (p) { p.caption = c.caption; p.caption_zh = c.caption_zh; }
  }
  if (!project.photos.some((p) => p.cover) && photos[out.cover_index - 1]) {
    photos[out.cover_index - 1].cover = true;
  }

  return {
    title: out.title, title_zh: out.title_zh,
    subtitle: out.subtitle, subtitle_zh: out.subtitle_zh,
    summary: out.summary, summary_zh: out.summary_zh,
    description: out.description, description_zh: out.description_zh,
    room_observed: out.room_observed || undefined, room_observed_zh: out.room_observed_zh || undefined,
    xhs_title: out.xhs_title, xhs_body: out.xhs_body,
    warnings: out.warnings,
    model: response.model,
    generatedAt: new Date().toISOString(),
  };
}
