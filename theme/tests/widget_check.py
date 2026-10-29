"""Layout and form checks for the chat widget (theme/assets/smori-assistant.{js,css}), offline.

Renders the widget with the production section settings on a blank page, mocks the
/apps/assistant/* endpoints (nothing reaches a server), and checks at desktop and phone sizes:
  - the booking / 转人工 form's submit button and its phone / email / WeChat fields are visible without
    scrolling, before and after chatting (on short landscape screens: the submit button)
  - while a form is being sent it cannot be cancelled or replaced
  - a double click on submit sends the form once
  - phone, email or WeChat alone is accepted; a preferred method needs its field
  - the privacy notice is shown under the chat (and the privacy link only when configured)
  - once booked (form or chat), the inline booking button is removed; the header button stays

Usage: python3 theme/tests/widget_check.py [assets_dir] [screenshot_dir]
Needs Playwright for Python with Chromium (set PW_CHROMIUM to a chromium binary if it is not the bundled one).
Exit code 1 when a check fails.
"""
import json, os, sys, time
from playwright.sync_api import sync_playwright

ASSETS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'assets')
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
ORIGIN = 'https://shop.test'
ATTRS = {  # production settings (smoriwindowfashion.com, theme "SMORI 正式 2026-10")
    'data-mode': 'sales', 'data-endpoint': '/apps/assistant', 'data-locale': 'en',
    'data-name-en': 'SMORI Assistant', 'data-name-zh': 'SMORI 智能顾问',
    'data-sales-greeting-en': "Hi, I'm the SMORI AI design consultant. Tell me about the room and what you'd like to improve (darkness, privacy, light, insulation or style), and I'll suggest options. Pricing is provided by our team after a free in-home consultation.",
    'data-sales-greeting-zh': '您好，我是 SMORI 的 AI 窗饰顾问。告诉我是哪个房间、想改善什么（遮光、隐私、采光、隔热或装饰），我来帮您推荐合适的方案。具体价格由顾问免费上门测量后提供。',
    'data-phone': '(949) 880-1322', 'data-email': 'BonnieX@smoriwindowfashion.com', 'data-position': 'right',
}

def page_html(extra=None):
    attrs = dict(ATTRS, **(extra or {}))
    a = ' '.join(f'{k}="{v}"' for k, v in attrs.items())
    return (f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">'
            f'<link rel="stylesheet" href="/assets/smori-assistant.css"></head><body style="margin:0;background:#222;height:2000px">'
            f'<div id="smori-assistant" {a}></div><script src="/assets/smori-assistant.js"></script></body></html>')

failures = []
LEAD_DELAY = [0.6]
HELD = []  # when HOLD[0] is set, /lead requests wait here until the test releases them
HOLD = [False]
CHAT_CTA = ['consultation']  # the cta the mocked chat reply carries
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f'  ({detail})' if detail and not ok else ''))
    if not ok: failures.append(name)

VISIBLE_JS = """sel => { const P = document.querySelector('.sma-panel').getBoundingClientRect();
  const el = document.querySelector(sel); if (!el) return {visible: false, why: 'missing'};
  const r = el.getBoundingClientRect(); const vh = window.innerHeight, vw = window.innerWidth;
  const inside = r.height > 0 && r.top >= P.top - 1 && r.bottom <= P.bottom + 1 && r.bottom <= vh + 1 && r.top >= 0 && r.right <= vw + 1;
  const hit = inside && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {visible: !!(inside && hit && (hit === el || el.contains(hit))), top: Math.round(r.top), bottom: Math.round(r.bottom), panelBottom: Math.round(P.bottom), vh}; }"""

def run(pw, chromium):
    b = pw.chromium.launch(**({'executable_path': chromium} if chromium else {}))
    def new_page(w, h, locale, mobile, extra=None):
        ctx = b.new_context(viewport={'width': w, 'height': h}, locale=locale, is_mobile=mobile, has_touch=mobile)
        posts = []
        def route(r):
            u = r.request.url
            if u == ORIGIN + '/': return r.fulfill(status=200, content_type='text/html; charset=utf-8', body=page_html(extra))
            if u.startswith(ORIGIN + '/assets/'):
                name = u.split('/assets/')[1].split('?')[0]
                return r.fulfill(status=200, content_type='text/css; charset=utf-8' if name.endswith('.css') else 'application/javascript; charset=utf-8', body=open(os.path.join(ASSETS, name), 'rb').read())
            if u.endswith('/apps/assistant/ping'): return r.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'assistant': True}))
            if u.endswith('/apps/assistant/chat'):
                return r.fulfill(status=200, content_type='application/json', body=json.dumps({'conversationId': 'cwidgettest01', 'reply': 'Duette in a room-darkening opacity would suit a bedroom. Which room is it for?', 'cta': CHAT_CTA[0]}))
            if u.endswith('/apps/assistant/lead'):
                posts.append(json.loads(r.request.post_data or '{}'))
                if HOLD[0]: HELD.append(r); return None
                time.sleep(LEAD_DELAY[0])
                return r.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'stage': 'consultation_requested', 'message': 'Received.'}))
            return r.abort()
        ctx.route('**/*', route)
        pg = ctx.new_page(); pg.goto(ORIGIN + '/'); pg.wait_for_selector('.sma-bubble')
        pg.click('.sma-bubble'); pg.wait_for_selector('.sma-panel', state='visible'); pg.wait_for_timeout(300)
        return ctx, pg, posts

    sizes = [(1366, 768, False), (1920, 1080, False), (1440, 760, False), (1280, 720, False), (375, 667, True), (360, 640, True), (390, 844, True)]
    short = [(667, 375, True), (844, 390, True), (740, 360, True), (568, 320, True), (320, 480, True)]
    for w, h, mobile in sizes + short:
        for locale in ('en-US', 'zh-CN'):
            for kind, btn in (('consultation', '.sma-book'), ('human', '.sma-human')):
                for chatted in (False, True):
                    ctx, pg, posts = new_page(w, h, locale, mobile)
                    if chatted:
                        pg.fill('.sma-input textarea', 'bedroom blackout'); pg.click('.sma-send'); pg.wait_for_selector('.sma-msg.bot >> nth=1')
                    pg.click(btn); pg.wait_for_selector('.sma-form', state='visible'); pg.wait_for_timeout(200)
                    tag = f'{w}x{h} {locale} {kind} {"after chat" if chatted else "before chat"}'
                    v = pg.evaluate(VISIBLE_JS, '.sma-form button[type="submit"]')
                    check(f'submit visible: {tag}', v['visible'], json.dumps(v))
                    if (w, h, mobile) in sizes:
                        check(f'consent visible: {tag}', pg.evaluate(VISIBLE_JS, '.sma-form .consent')['visible'])
                        for f in ('name', 'phone', 'email', 'wechat'):
                            check(f'{f} field visible: {tag}', pg.evaluate(VISIBLE_JS, f'.sma-form input[name="{f}"]')['visible'])
                    if SHOTS and not chatted and kind == 'consultation': pg.screenshot(path=os.path.join(SHOTS, f'form-{w}x{h}-{locale}.png'))
                    ctx.close()

    # footer notice, no privacy link unless configured
    ctx, pg, _ = new_page(1366, 768, 'zh-CN', False)
    foot = pg.inner_text('.sma-foot')
    check('chat notice shown (zh)', '对话由 AI 处理并会被保存' in foot, foot)
    check('no privacy link when not configured', pg.locator('.sma-foot a').count() == 0)
    ctx.close()
    ctx, pg, _ = new_page(1366, 768, 'en-US', False, {'data-privacy-url': '/policies/privacy-policy', 'data-notice-en': 'Custom notice.'})
    check('privacy link shown when configured', pg.get_attribute('.sma-foot a', 'href') == '/policies/privacy-policy')
    check('notice text from theme settings', 'Custom notice.' in pg.inner_text('.sma-foot'))
    ctx.close()
    ctx, pg, _ = new_page(1366, 768, 'en-US', False, {'data-privacy-url': 'javascript:alert(1)'})
    check('unsafe privacy link ignored', pg.locator('.sma-foot a').count() == 0)
    ctx.close()
    ctx, pg, _ = new_page(1366, 768, 'en-US', False, {'data-privacy-url': ' /policies/privacy-policy '})
    check('privacy link with surrounding spaces accepted', pg.get_attribute('.sma-foot a', 'href') == '/policies/privacy-policy')
    ctx.close()
    ctx, pg, _ = new_page(1366, 768, 'en-US', False, {'data-show-notice': 'false', 'data-show-consent': 'false'})
    check('notice can be switched off', 'saved' not in pg.inner_text('.sma-foot'))
    pg.click('.sma-book')
    check('consent line can be switched off', pg.locator('.sma-form .consent').count() == 0)
    ctx.close()
    # while a form is open the chat history steps aside; it comes back when the form closes
    ctx, pg, _ = new_page(1366, 768, 'en-US', False)
    pg.click('.sma-book')
    check('messages hidden while the form is open', not pg.locator('.sma-messages').is_visible())
    pg.click('.sma-form .cancel')
    check('messages back after cancel', pg.locator('.sma-messages').is_visible() and not pg.locator('.sma-form').is_visible())
    ctx.close()
    # while sending: cancel is disabled and the header buttons do not replace the form
    HOLD[0] = True
    ctx, pg, posts = new_page(1366, 768, 'en-US', False)
    pg.click('.sma-book'); pg.fill('.sma-form input[name="phone"]', '949-555-0100')
    pg.evaluate("() => document.querySelector('.sma-form').requestSubmit()")
    pg.wait_for_timeout(300)
    check('request held while testing', len(HELD) == 1)
    check('cancel disabled while sending', pg.locator('.sma-form .cancel').is_disabled())
    pg.evaluate("() => { document.querySelector('.sma-human').click(); document.querySelector('.sma-book').click(); document.querySelector('.sma-form .cancel').click(); }")
    check('form not replaced or closed while sending', pg.locator('.sma-form').is_visible() and pg.locator('.sma-form input[name="phone"]').input_value() == '949-555-0100')
    HOLD[0] = False
    HELD.pop().fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'stage': 'consultation_requested', 'message': 'Received.'}))
    pg.wait_for_timeout(500)
    check('confirmation shown after sending', len(posts) == 1 and not pg.locator('.sma-form').is_visible() and 'Received.' in pg.inner_text('.sma-messages'))
    ctx.close()

    # double submit sends once; WeChat alone is enough; a preferred method needs its field
    ctx, pg, posts = new_page(1366, 768, 'zh-CN', False)
    pg.click('.sma-book'); pg.fill('.sma-form input[name="name"]', '测试'); pg.fill('.sma-form input[name="phone"]', '949-555-0100')
    # a double click, then two more submit events in the same tick (the busy guard, not only the disabled button, must hold)
    pg.dblclick('.sma-form button[type="submit"]')
    pg.evaluate("() => { const f = document.querySelector('.sma-form'); if (f.style.display !== 'none') { f.requestSubmit(); f.requestSubmit(); } }")
    pg.wait_for_timeout(1500)
    check('double click submits once', len(posts) == 1, f'{len(posts)} posts')
    check('form closes after success', not pg.locator('.sma-form').is_visible())
    ctx.close()
    ctx, pg, posts = new_page(1366, 768, 'zh-CN', False)
    pg.click('.sma-book'); pg.fill('.sma-form input[name="name"]', '测试'); pg.fill('.sma-form input[name="wechat"]', 'wx_test88')
    pg.select_option('.sma-form select[name="contact_preference"]', 'wechat'); pg.click('.sma-form button[type="submit"]'); pg.wait_for_timeout(1000)
    check('WeChat alone books', len(posts) == 1 and posts[0].get('wechat') == 'wx_test88' and posts[0].get('contact_preference') == 'wechat', json.dumps(posts, ensure_ascii=False))
    ctx.close()
    ctx, pg, posts = new_page(1366, 768, 'en-US', False)
    pg.click('.sma-book'); pg.fill('.sma-form input[name="email"]', 'a@b.co'); pg.select_option('.sma-form select[name="contact_preference"]', 'sms')
    pg.click('.sma-form button[type="submit"]'); pg.wait_for_timeout(400)
    err = pg.inner_text('.sma-form .err') if pg.locator('.sma-form .err').is_visible() else ''
    check('text preference without a phone number is caught', len(posts) == 0 and 'phone number' in err, err)
    ctx.close()
    ctx, pg, posts = new_page(1366, 768, 'en-US', False)
    pg.click('.sma-book'); pg.click('.sma-form button[type="submit"]'); pg.wait_for_timeout(300)
    check('no contact at all is caught', len(posts) == 0 and 'WeChat' in pg.inner_text('.sma-form .err'))
    ctx.close()

    # once booked, the inline "book a free in-home consultation" button is removed; the header button stays
    ctx, pg, posts = new_page(1366, 768, 'zh-CN', False)
    pg.fill('.sma-input textarea', '我想预约上门测量'); pg.click('.sma-send'); pg.wait_for_selector('.sma-cta button')
    check('inline booking button shown on buying intent', pg.locator('.sma-cta').count() == 1)
    pg.click('.sma-cta button'); pg.fill('.sma-form input[name="phone"]', '949-555-0100'); pg.click('.sma-form button[type="submit"]'); pg.wait_for_timeout(1500)
    check('inline booking button removed after booking with the form', len(posts) == 1 and pg.locator('.sma-cta').count() == 0, f'{len(posts)} posts, {pg.locator(".sma-cta").count()} buttons')
    check('header booking button still there after booking', pg.locator('.sma-book').is_visible())
    pg.fill('.sma-input textarea', '还有别的问题'); pg.click('.sma-send'); pg.wait_for_timeout(800)
    check('no new inline booking button after booking', pg.locator('.sma-cta').count() == 0)
    ctx.close()
    ctx, pg, _ = new_page(1366, 768, 'en-US', False)
    pg.fill('.sma-input textarea', 'I want to book'); pg.click('.sma-send'); pg.wait_for_selector('.sma-cta button')
    CHAT_CTA[0] = 'booked'  # the agent booked it in the chat
    pg.fill('.sma-input textarea', 'Jane, 949-555-0100'); pg.click('.sma-send'); pg.wait_for_selector('.sma-msg.bot >> nth=2'); pg.wait_for_timeout(300)
    check('inline booking button removed when the agent books in the chat', pg.locator('.sma-cta').count() == 0)
    CHAT_CTA[0] = 'consultation'
    ctx.close()
    b.close()

with sync_playwright() as pw:
    run(pw, os.environ.get('PW_CHROMIUM'))
print(f'\n{len(failures)} failed' if failures else '\nall widget checks passed')
sys.exit(1 if failures else 0)
