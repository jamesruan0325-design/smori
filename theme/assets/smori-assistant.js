/* SMORI website assistant widget. Talks to /apps/assistant/* (Shopify App Proxy -> SMORI app). */
(function () {
  var root = document.getElementById('smori-assistant');
  if (!root || root.dataset.init) return;
  root.dataset.init = '1';
  var endpoint = (root.dataset.endpoint || '/apps/assistant').replace(/\/$/, '');
  var phone = root.dataset.phone || '';
  var email = root.dataset.email || '';
  var lang = /^zh/i.test(root.dataset.locale || '') || /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  /* "sales" = AI Sales Agent (needs discovery, consultation booking, lead stages); "assistant" = original Q&A assistant */
  var mode = root.dataset.mode === 'sales' ? 'sales' : 'assistant';
  var T = {
    zh: { name: root.dataset.nameZh || 'SMORI 智能顾问', sub: 'AI 助手', greeting: root.dataset.greetingZh, placeholder: '输入您的问题…', send: '发送', human: '转人工', close: '关闭', typing: '正在输入…',
          foot: 'AI 助手回答仅供参考；价格、交期、保修以顾问确认为准。', offline: '智能助手暂时无法连接。请致电 ' + phone + ' 或发邮件至 ' + email + '。',
          chips: ['卧室怎么做到完全遮光？', '白天有隐私、晚上呢？', '电动窗帘能用手机控制吗？', '你们上门测量吗？', '我想预约顾问'],
          formTitle: '留下联系方式，顾问会联系您', nameL: '姓名', phoneL: '电话', emailL: '邮箱', wechat: '微信号', need: '您的需求（房间、窗户数量、想了解的产品）', submit: '提交', cancel: '取消', contactReq: '请至少留一个电话、邮箱或微信号。', sent: '已收到，顾问会在营业时间内联系您。', handoffHint: '也可以直接致电 ' + phone + '。',
          salesSub: 'AI 窗饰顾问', salesGreeting: root.dataset.salesGreetingZh, book: '预约咨询', cta: '预约免费上门咨询', bookTitle: '预约免费上门咨询：顾问会联系您确认时间', zip: 'ZIP 邮编', time: '方便的时间（如 周六上午）', bookNeed: '想做的房间和需求（可不填）', bookReq: '请留下电话或邮箱，方便顾问联系您确认时间。', booked: '预约申请已收到，顾问会在营业时间内联系您确认时间。',
          salesFoot: 'AI 顾问不提供报价；价格由顾问上门测量后提供。交期、保修以顾问确认为准。',
          salesChips: ['主卧想要遮光，有什么方案？', '客厅大落地窗怎么兼顾采光和隐私？', '想把家里窗帘换成电动的', '怎么收费？', '我想预约上门咨询'] },
    en: { name: root.dataset.nameEn || 'SMORI Assistant', sub: 'AI assistant', greeting: root.dataset.greetingEn, placeholder: 'Type your question…', send: 'Send', human: 'Talk to a person', close: 'Close', typing: 'Typing…',
          foot: 'AI answers are for guidance; prices, lead times and warranty are confirmed by our team.', offline: 'The assistant is unavailable right now. Please call ' + phone + ' or email ' + email + '.',
          chips: ['How do I get full blackout in a bedroom?', 'Privacy during the day and at night?', 'Can motorized shades be controlled from my phone?', 'Do you measure and install?', 'Book a consultation'],
          formTitle: 'Leave your details and a team member will contact you', nameL: 'Name', phoneL: 'Phone', emailL: 'Email', wechat: 'WeChat ID', need: 'What you need (rooms, number of windows, products)', submit: 'Submit', cancel: 'Cancel', contactReq: 'Please leave a phone number, email or WeChat ID.', sent: 'Received. A team member will contact you during business hours.', handoffHint: 'You can also call ' + phone + '.',
          salesSub: 'AI design consultant', salesGreeting: root.dataset.salesGreetingEn, book: 'Book consultation', cta: 'Book a free in-home consultation', bookTitle: 'Free in-home consultation: a team member will contact you to confirm a time', zip: 'ZIP code', time: 'Preferred time (e.g. Saturday morning)', bookNeed: 'Rooms and needs (optional)', bookReq: 'Please leave a phone number or email so we can confirm a time.', booked: 'Request received. A team member will contact you during business hours to confirm a time.',
          salesFoot: 'The AI consultant does not quote prices; pricing comes from our team after the in-home measurement. Lead times and warranty are confirmed by our team.',
          salesChips: ['Blackout options for a bedroom?', 'Light and privacy for a large living-room window?', 'I want to motorize my shades', 'How does pricing work?', 'Book an in-home consultation'] }
  };
  var state = { id: null, messages: [], online: null };
  try { var saved = JSON.parse(sessionStorage.getItem('smori_chat') || 'null'); if (saved && saved.id) state = saved; } catch (e) {}
  if (!state.id) state.id = 'c' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  function save() { try { sessionStorage.setItem('smori_chat', JSON.stringify({ id: state.id, messages: state.messages.slice(-40), ctaShown: !!state.ctaShown, booked: !!state.booked, utm: state.utm })); } catch (e) {} }
  function t(k) {
    if (mode === 'sales') { var sk = { sub: 'salesSub', greeting: 'salesGreeting', foot: 'salesFoot', chips: 'salesChips' }[k]; if (sk && T[lang][sk]) return T[lang][sk]; }
    return T[lang][k];
  }
  /* first-touch UTM parameters for lead attribution (sales mode only; nothing else from the URL is sent) */
  if (mode === 'sales' && !state.utm) {
    try { var qs = new URLSearchParams(location.search), utm = {}; ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) { if (qs.get(k)) utm[k] = qs.get(k).slice(0, 100); }); state.utm = utm; } catch (e) { state.utm = {}; }
  }
  function pageContext() { return { url: location.origin + location.pathname, referrer: document.referrer || '', utm: state.utm || {} }; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function linkify(s) { return esc(s).replace(/\(?\b\d{3}\)?[ -]?\d{3}-\d{4}\b/g, function (m) { return '<a href="tel:' + m.replace(/\D/g, '') + '">' + m + '</a>'; }).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, function (m) { return '<a href="mailto:' + m + '">' + m + '</a>'; }); }

  root.className = 'sma-root';
  root.setAttribute('data-position', root.dataset.position || 'right');
  root.innerHTML =
    '<button class="sma-bubble" type="button" aria-label="Chat"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.2-4.2A8 8 0 1 1 21 12z"/></svg></button>' +
    '<div class="sma-panel" role="dialog" aria-label="Chat">' +
      '<div class="sma-head"><div class="sma-title"><small class="sma-sub"></small><span class="sma-name"></span></div><div class="sma-head-actions"><button type="button" class="sma-book" style="display:none"></button><button type="button" class="sma-human"></button><button type="button" class="sma-close"></button></div></div>' +
      '<div class="sma-messages"></div><div class="sma-chips"></div>' +
      '<form class="sma-form" style="display:none"></form>' +
      '<div class="sma-input"><textarea rows="1"></textarea><button type="button" class="sma-send"></button></div>' +
      '<div class="sma-foot"></div></div>';
  var $ = function (s) { return root.querySelector(s); };
  var msgs = $('.sma-messages'), input = $('.sma-input textarea'), sendBtn = $('.sma-send'), form = $('.sma-form'), chips = $('.sma-chips');

  function applyLang() {
    $('.sma-name').textContent = t('name'); $('.sma-sub').textContent = t('sub'); $('.sma-human').textContent = t('human'); $('.sma-close').textContent = t('close');
    if (mode === 'sales') { $('.sma-book').style.display = ''; $('.sma-book').textContent = t('book'); }
    input.placeholder = t('placeholder'); sendBtn.textContent = t('send'); $('.sma-foot').textContent = t('foot');
    chips.innerHTML = state.messages.length ? '' : t('chips').map(function (c) { return '<button type="button">' + esc(c) + '</button>'; }).join('');
    chips.querySelectorAll('button').forEach(function (b) { b.onclick = function () { send(b.textContent); }; });
  }
  function add(role, text) { var d = document.createElement('div'); d.className = 'sma-msg ' + role; d.innerHTML = role === 'user' ? esc(text) : linkify(text); msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; }
  function render() { msgs.innerHTML = ''; if (!state.messages.length) add('bot', t('greeting') || ''); state.messages.forEach(function (m) { add(m.role === 'user' ? 'user' : 'bot', m.content); }); }

  function open() { root.classList.add('is-open'); applyLang(); render(); input.focus(); if (state.online === null) ping(); }
  function close() { root.classList.remove('is-open'); }
  $('.sma-bubble').onclick = function () { root.classList.contains('is-open') ? close() : open(); };
  $('.sma-close').onclick = close;

  function ping() {
    fetch(endpoint + '/ping', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (j) { state.online = !!(j && j.ok && j.assistant); if (!state.online) add('sys', t('offline')); })
      .catch(function () { state.online = false; add('sys', t('offline')); });
  }

  var busy = false;
  function send(text) {
    text = (text || input.value).trim();
    if (!text || busy) return;
    input.value = '';
    var detected = /[㐀-鿿]/.test(text) ? 'zh' : (/[A-Za-z]{3,}/.test(text) ? 'en' : lang);
    /* sales mode: a bare ZIP / phone / email / one or two words keeps the current language */
    if (mode === 'sales' && detected === 'en' && (text.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, ' ').match(/[A-Za-z]{3,}/g) || []).length < 3) detected = lang;
    if (detected !== lang) { lang = detected; applyLang(); }
    state.messages.push({ role: 'user', content: text }); save(); add('user', text); chips.innerHTML = '';
    if (state.online === false) { add('sys', t('offline')); return; }
    busy = true; sendBtn.disabled = true;
    var typing = document.createElement('div'); typing.className = 'sma-typing'; typing.textContent = t('typing'); msgs.appendChild(typing); msgs.scrollTop = msgs.scrollHeight;
    fetch(endpoint + '/chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mode === 'sales' ? { conversationId: state.id, messages: state.messages.slice(-20), agent: 'sales', page: pageContext() } : { conversationId: state.id, messages: state.messages.slice(-20) }) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (x) {
        typing.remove();
        var j = x.j || {};
        if (j.conversationId) state.id = j.conversationId;
        if (j.reply) { state.messages.push({ role: 'assistant', content: j.reply }); save(); add('bot', j.reply); }
        else { add('sys', j.error || t('offline')); }
        if (j.error === 'assistant_unavailable') state.online = false;
        if (mode === 'sales') salesCta(j);
        else if (j.handoff && !j.leadSaved && x.status === 200) add('sys', t('handoffHint'));
      })
      .catch(function () { typing.remove(); add('sys', t('offline')); })
      .then(function () { busy = false; sendBtn.disabled = false; input.focus(); });
  }
  sendBtn.onclick = function () { send(); };
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  /* sales mode: inline "book a consultation" button, shown once per conversation when the agent sees buying intent */
  function salesCta(j) {
    if (j.cta === 'booked' || j.cta === 'human_sent') { state.booked = true; save(); return; }
    if (j.cta === 'human_form') { if (j.handoff && !j.leadSaved) add('sys', t('handoffHint')); openForm('human'); return; }
    if (j.cta === 'consultation' && !state.ctaShown && !state.booked) {
      state.ctaShown = true; save();
      var d = document.createElement('div'); d.className = 'sma-cta';
      d.innerHTML = '<button type="button">' + esc(t('cta')) + '</button>';
      d.querySelector('button').onclick = function () { openForm('consultation'); };
      msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight;
    }
  }

  var formKind = null;
  function openForm(kind) {
    if (form.style.display !== 'none' && formKind === kind) { form.style.display = 'none'; return; }
    formKind = kind; form.style.display = 'flex';
    var book = kind === 'consultation';
    form.innerHTML = '<div style="color:#fff;font-size:13px">' + esc(t(book ? 'bookTitle' : 'formTitle')) + '</div>' +
      '<input name="name" placeholder="' + esc(t('nameL')) + '" autocomplete="name">' +
      '<div class="row"><input name="phone" placeholder="' + esc(t('phoneL')) + '" inputmode="tel" autocomplete="tel"><input name="email" placeholder="' + esc(t('emailL')) + '" inputmode="email" autocomplete="email"></div>' +
      (book
        ? '<div class="row"><input name="zip" placeholder="' + esc(t('zip')) + '" inputmode="numeric" maxlength="10" autocomplete="postal-code"><input name="preferred_time" placeholder="' + esc(t('time')) + '"></div>' +
          '<textarea name="notes" placeholder="' + esc(t('bookNeed')) + '"></textarea>'
        : '<input name="wechat" placeholder="' + esc(t('wechat')) + '">' +
          '<textarea name="notes" placeholder="' + esc(t('need')) + '"></textarea>') +
      '<div class="err" style="display:none"></div>' +
      '<div class="actions"><button type="button" class="cancel">' + esc(t('cancel')) + '</button><button type="submit" class="primary">' + esc(t('submit')) + '</button></div>';
    form.querySelector('.cancel').onclick = function () { form.style.display = 'none'; };
    form.onsubmit = function (e) {
      e.preventDefault();
      var f = new FormData(form), body = { conversationId: state.id, language: lang }, er = form.querySelector('.err');
      ['name', 'phone', 'email', 'wechat', 'notes', 'zip', 'preferred_time'].forEach(function (k) { if (f.has(k)) body[k] = (f.get(k) || '').toString().trim(); });
      if (book ? (!body.phone && !body.email) : (!body.phone && !body.email && !body.wechat)) { er.textContent = t(book ? 'bookReq' : 'contactReq'); er.style.display = 'block'; return; }
      var last = state.messages.filter(function (m) { return m.role === 'user'; }).slice(-3).map(function (m) { return m.content; }).join(' / ');
      if (last) body.interest = last.slice(0, 300);
      if (mode === 'sales') { body.agent = 'sales'; body.kind = kind; body.page = pageContext(); }
      fetch(endpoint + '/lead', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) {
          if (x.ok) { form.style.display = 'none'; if (book) { state.booked = true; save(); } add('sys', (x.j && x.j.message) || t(book ? 'booked' : 'sent')); }
          else { er.textContent = (x.j && x.j.error) || t('offline'); er.style.display = 'block'; }
        })
        .catch(function () { er.textContent = t('offline'); er.style.display = 'block'; });
    };
    var first = form.querySelector('input[name="name"]'); if (first) first.focus();
  }
  $('.sma-human').onclick = function () { openForm('human'); };
  $('.sma-book').onclick = function () { openForm('consultation'); };
  applyLang();
})();
