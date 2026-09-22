/* SMORI website assistant widget. Talks to /apps/assistant/* (Shopify App Proxy -> SMORI app). */
(function () {
  var root = document.getElementById('smori-assistant');
  if (!root || root.dataset.init) return;
  root.dataset.init = '1';
  var endpoint = (root.dataset.endpoint || '/apps/assistant').replace(/\/$/, '');
  var phone = root.dataset.phone || '';
  var email = root.dataset.email || '';
  var lang = /^zh/i.test(root.dataset.locale || '') || /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  var T = {
    zh: { name: root.dataset.nameZh || 'SMORI 智能顾问', sub: 'AI 助手', greeting: root.dataset.greetingZh, placeholder: '输入您的问题…', send: '发送', human: '转人工', close: '关闭', typing: '正在输入…',
          foot: 'AI 助手回答仅供参考；价格、交期、保修以顾问确认为准。', offline: '智能助手暂时无法连接。请致电 ' + phone + ' 或发邮件至 ' + email + '。',
          chips: ['卧室怎么做到完全遮光？', '白天有隐私、晚上呢？', '电动窗帘能用手机控制吗？', '你们上门测量吗？', '我想预约顾问'],
          formTitle: '留下联系方式，顾问会联系您', name: '姓名', phoneL: '电话', emailL: '邮箱', wechat: '微信号', need: '您的需求（房间、窗户数量、想了解的产品）', submit: '提交', cancel: '取消', contactReq: '请至少留一个电话、邮箱或微信号。', sent: '已收到，顾问会在营业时间内联系您。', handoffHint: '也可以直接致电 ' + phone + '。' },
    en: { name: root.dataset.nameEn || 'SMORI Assistant', sub: 'AI assistant', greeting: root.dataset.greetingEn, placeholder: 'Type your question…', send: 'Send', human: 'Talk to a person', close: 'Close', typing: 'Typing…',
          foot: 'AI answers are for guidance; prices, lead times and warranty are confirmed by our team.', offline: 'The assistant is unavailable right now. Please call ' + phone + ' or email ' + email + '.',
          chips: ['How do I get full blackout in a bedroom?', 'Privacy during the day and at night?', 'Can motorized shades be controlled from my phone?', 'Do you measure and install?', 'Book a consultation'],
          formTitle: 'Leave your details and a team member will contact you', name: 'Name', phoneL: 'Phone', emailL: 'Email', wechat: 'WeChat ID', need: 'What you need (rooms, number of windows, products)', submit: 'Submit', cancel: 'Cancel', contactReq: 'Please leave a phone number, email or WeChat ID.', sent: 'Received. A team member will contact you during business hours.', handoffHint: 'You can also call ' + phone + '.' }
  };
  var state = { id: null, messages: [], online: null };
  try { var saved = JSON.parse(sessionStorage.getItem('smori_chat') || 'null'); if (saved && saved.id) state = saved; } catch (e) {}
  if (!state.id) state.id = 'c' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  function save() { try { sessionStorage.setItem('smori_chat', JSON.stringify({ id: state.id, messages: state.messages.slice(-40) })); } catch (e) {} }
  function t(k) { return T[lang][k]; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function linkify(s) { return esc(s).replace(/\(?\b\d{3}\)?[ -]?\d{3}-\d{4}\b/g, function (m) { return '<a href="tel:' + m.replace(/\D/g, '') + '">' + m + '</a>'; }).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, function (m) { return '<a href="mailto:' + m + '">' + m + '</a>'; }); }

  root.className = 'sma-root';
  root.setAttribute('data-position', root.dataset.position || 'right');
  root.innerHTML =
    '<button class="sma-bubble" type="button" aria-label="Chat"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.2-4.2A8 8 0 1 1 21 12z"/></svg></button>' +
    '<div class="sma-panel" role="dialog" aria-label="Chat">' +
      '<div class="sma-head"><div class="sma-title"><small class="sma-sub"></small><span class="sma-name"></span></div><div class="sma-head-actions"><button type="button" class="sma-human"></button><button type="button" class="sma-close"></button></div></div>' +
      '<div class="sma-messages"></div><div class="sma-chips"></div>' +
      '<form class="sma-form" style="display:none"></form>' +
      '<div class="sma-input"><textarea rows="1"></textarea><button type="button" class="sma-send"></button></div>' +
      '<div class="sma-foot"></div></div>';
  var $ = function (s) { return root.querySelector(s); };
  var msgs = $('.sma-messages'), input = $('.sma-input textarea'), sendBtn = $('.sma-send'), form = $('.sma-form'), chips = $('.sma-chips');

  function applyLang() {
    $('.sma-name').textContent = t('name'); $('.sma-sub').textContent = t('sub'); $('.sma-human').textContent = t('human'); $('.sma-close').textContent = t('close');
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
    if (detected !== lang) { lang = detected; applyLang(); }
    state.messages.push({ role: 'user', content: text }); save(); add('user', text); chips.innerHTML = '';
    if (state.online === false) { add('sys', t('offline')); return; }
    busy = true; sendBtn.disabled = true;
    var typing = document.createElement('div'); typing.className = 'sma-typing'; typing.textContent = t('typing'); msgs.appendChild(typing); msgs.scrollTop = msgs.scrollHeight;
    fetch(endpoint + '/chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: state.id, messages: state.messages.slice(-20) }) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (x) {
        typing.remove();
        var j = x.j || {};
        if (j.conversationId) state.id = j.conversationId;
        if (j.reply) { state.messages.push({ role: 'assistant', content: j.reply }); save(); add('bot', j.reply); }
        else { add('sys', j.error || t('offline')); }
        if (j.error === 'assistant_unavailable') state.online = false;
        if (j.handoff && !j.leadSaved && x.status === 200) add('sys', t('handoffHint'));
      })
      .catch(function () { typing.remove(); add('sys', t('offline')); })
      .then(function () { busy = false; sendBtn.disabled = false; input.focus(); });
  }
  sendBtn.onclick = function () { send(); };
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  $('.sma-human').onclick = function () {
    form.style.display = form.style.display === 'none' ? 'flex' : 'none';
    if (form.style.display === 'none') return;
    form.innerHTML = '<div style="color:#fff;font-size:13px">' + esc(t('formTitle')) + '</div>' +
      '<input name="name" placeholder="' + esc(t('name')) + '">' +
      '<div class="row"><input name="phone" placeholder="' + esc(t('phoneL')) + '" inputmode="tel"><input name="email" placeholder="' + esc(t('emailL')) + '" inputmode="email"></div>' +
      '<input name="wechat" placeholder="' + esc(t('wechat')) + '">' +
      '<textarea name="notes" placeholder="' + esc(t('need')) + '"></textarea>' +
      '<div class="err" style="display:none"></div>' +
      '<div class="actions"><button type="button" class="cancel">' + esc(t('cancel')) + '</button><button type="submit" class="primary">' + esc(t('submit')) + '</button></div>';
    form.querySelector('.cancel').onclick = function () { form.style.display = 'none'; };
    form.onsubmit = function (e) {
      e.preventDefault();
      var f = new FormData(form), body = { conversationId: state.id, language: lang };
      ['name', 'phone', 'email', 'wechat', 'notes'].forEach(function (k) { body[k] = (f.get(k) || '').toString().trim(); });
      if (!body.phone && !body.email && !body.wechat) { var er = form.querySelector('.err'); er.textContent = t('contactReq'); er.style.display = 'block'; return; }
      var last = state.messages.filter(function (m) { return m.role === 'user'; }).slice(-3).map(function (m) { return m.content; }).join(' / ');
      if (last) body.interest = last.slice(0, 300);
      fetch(endpoint + '/lead', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) { if (x.ok) { form.style.display = 'none'; add('sys', (x.j && x.j.message) || t('sent')); } else { var er = form.querySelector('.err'); er.textContent = (x.j && x.j.error) || t('offline'); er.style.display = 'block'; } })
        .catch(function () { var er = form.querySelector('.err'); er.textContent = t('offline'); er.style.display = 'block'; });
    };
  };
  applyLang();
})();
