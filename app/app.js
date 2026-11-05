'use strict';
/* 我的單字冊 — 查字典、收進單字冊、依記憶科學安排複習 */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now();
const DAY = FSRS.DAY, MIN = FSRS.MIN;
const ROLL = 4 * 36e5; // 一天從凌晨 4 點開始算
const dayKey = ts => { const d = new Date(ts - ROLL); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const endOfDay = () => { const d = new Date(now() - ROLL); d.setHours(0, 0, 0, 0); return d.getTime() + DAY + ROLL; };
const TYPES = { rec: '認字', lis: '聽力', pro: '拼寫' };

/* ---------- 儲存（IndexedDB） ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('wordbook', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  get(k) {
    return new Promise((res, rej) => {
      const r = this.db.transaction('kv').objectStore('kv').get(k);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  set(k, v) {
    return new Promise((res, rej) => {
      const t = this.db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(v, k);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }
};

const DEFAULT_SETTINGS = {
  newPerDay: 15, retention: 0.9, walkPause: 3, rate: 0.9, walkSentence: true, walkZh: true,
  theme: 'auto', enVoice: '', zhVoice: '', autoSpeak: true
};
let S = { words: {}, settings: { ...DEFAULT_SETTINGS }, log: [], daily: {}, recent: [], lastSource: '', deleted: {}, sync: null };
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => DB.set('state', S).catch(e => toast('儲存失敗：' + e.message)), 250); }
// 單字有變動：記下時間（同步時用來判斷哪邊比較新），並安排同步
function touch(item) { item.mod = now(); scheduleSync(); }

/* ---------- 離線字典 ---------- */
let DICT = null, KEYS = null;
async function loadDict() {
  const r = await fetch('dict.json?v=2'); // 字典更新時改這個版本號
  DICT = await r.json();
  KEYS = Object.keys(DICT.e).sort();
}
function norm(q) {
  return q.toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”".,!?;:()]/g, ' ').replace(/\s+/g, ' ').trim();
}
function entryOf(w) {
  const e = DICT && DICT.e[w];
  if (!e) return null;
  return { word: w, phon: e[0], zh: e[1], rank: e[2], collins: e[3] };
}
// 找字：原字 → 變化形還原（went → go）→ 片語第一個字還原（figured out → figure out）
function lookupLocal(q) {
  const w = norm(q);
  if (!w || !DICT) return { w, entry: null };
  let entry = entryOf(w), lemma = DICT.f[w] || null;
  if (!entry && w.includes(' ')) {
    const parts = w.split(' ');
    const base = DICT.f[parts[0]];
    if (base) { const alt = [base, ...parts.slice(1)].join(' '); if (DICT.e[alt]) { lemma = alt; } }
  }
  if (!entry && !lemma) {
    for (const suf of ["'s", "s'", 's']) if (w.endsWith(suf) && DICT.e[w.slice(0, -suf.length)]) { lemma = w.slice(0, -suf.length); break; }
  }
  return { w, entry, lemma };
}
function prefixSearch(p, n = 8) {
  if (!KEYS || !p) return [];
  let lo = 0, hi = KEYS.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (KEYS[m] < p) lo = m + 1; else hi = m; }
  const out = [];
  for (let i = lo; i < KEYS.length && out.length < 40 && KEYS[i].startsWith(p); i++) out.push(KEYS[i]);
  // 常用的排前面，單字優先於片語
  out.sort((a, b) => (a.includes(' ') - b.includes(' ')) || (rk(a) - rk(b)) || a.length - b.length);
  return out.slice(0, n);
}
const rk = w => { const r = DICT.e[w][2]; return r > 0 ? r : 1e6; };
function editDist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // 含「相鄰字母對調」（recieve → receive 算一步）
  let pp = null, prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (pp && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], pp[j - 2] + 1);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    pp = prev; prev = cur;
  }
  return prev[b.length];
}
function fuzzy(w) {
  if (!KEYS || w.length < 3 || w.includes(' ')) return [];
  const max = w.length > 6 ? 2 : 1, res = [];
  for (const k of KEYS) {
    if (k.includes(' ') || Math.abs(k.length - w.length) > max) continue;
    const d = editDist(w, k, max);
    if (d <= max) res.push([d, rk(k), k]);
  }
  return res.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, 6).map(x => x[2]);
}
function level(rank) {
  if (!rank) return '';
  if (rank <= 2000) return '基礎字';
  if (rank <= 5000) return '常用字';
  if (rank <= 10000) return '中階字';
  if (rank <= 20000) return '進階字';
  return '少見字';
}
// 取一段短的中文意思（給語音、卡片用）
function shortZh(zh, n = 3) {
  if (!zh) return '';
  const lines = zh.split('\n').filter(l => !/^\[(網路|网络)\]/.test(l));
  const parts = [];
  for (const l of (lines.length ? lines : zh.split('\n'))) {
    const body = l.replace(/^[a-z]+\.\s*/i, '').replace(/^\[[^\]]+\]\s*/, '').replace(/[（(][^）)]*[）)]/g, '');
    for (const p of body.split(/[,，；;、]/)) { const t = p.trim(); if (t && !parts.includes(t)) parts.push(t); if (parts.length >= n) break; }
    if (parts.length >= n) break;
  }
  return parts.join('、');
}

// 把字典解釋拆成一個個意思，給「這句的意思」點選
function senseList(zh) {
  const out = [];
  for (const l of (zh || '').split('\n')) {
    const m = l.match(/^([a-z]+\.)\s*(.*)$/i);
    const pos = m ? m[1] : '', body = (m ? m[2] : l).trim();
    if (/^\[[^\]]+\]/.test(body)) continue;
    for (const p of body.split(/[,，；;]/)) { const t = p.trim(); if (t && !out.some(o => o.t === t)) out.push({ pos, t }); }
  }
  return out;
}
// 跟中文字幕有共同字的意思，先幫你選起來（只是猜測，可以改）
function guessSenses(senses, sub) {
  if (!sub) return [];
  const sc = senses.map((s, i) => [i, [...new Set(s.t.replace(/[^一-鿿]/g, ''))].filter(ch => sub.includes(ch)).length]);
  const best = Math.max(0, ...sc.map(x => x[1]));
  return best >= 1 ? sc.filter(x => x[1] === best && x[1] >= Math.min(2, [...senses[x[0]].t].length)).map(x => x[0]).slice(0, 2) : [];
}
// 這個字「我要記的意思」：有選過就用選的，沒選過用字典前幾個
const meaningOf = (it, n = 3) => it.meaning || shortZh(it.zh, n);
// 列出字典全部意思，把「這句用到的」標顏色；自己寫、字典沒有的意思另外列在最上面
function sensesHtml(zh, meaning) {
  const chosen = (meaning || '').split('、').map(s => s.trim()).filter(Boolean);
  const used = new Set();
  const lines = (zh || '').split('\n').map(l => {
    const m = l.match(/^([a-z]+\.)\s*(.*)$/i);
    const pos = m ? m[1] : '', body = m ? m[2] : l;
    const items = body.split(/,\s*/).map(t => {
      const hit = chosen.includes(t.trim());
      if (hit) used.add(t.trim());
      return hit ? `<mark class="hit">${esc(t)}</mark>` : esc(t);
    });
    return `<div>${pos ? `<span class="pos">${esc(pos)}</span> ` : ''}${items.join(', ')}</div>`;
  });
  const extra = chosen.filter(c => !used.has(c));
  return `<div class="senses">${extra.length ? `<div><span class="pos">這句</span> ${extra.map(x => `<mark class="hit">${esc(x)}</mark>`).join(', ')}</div>` : ''}${lines.join('')}</div>`;
}
function refreshMeaning(it) {
  const all = [];
  for (const c of it.contexts) for (const s of (c.sense || '').split('、')) if (s && !all.includes(s)) all.push(s);
  if (all.length) it.meaning = all.join('、');
}

/* ---------- 線上資料：英英解釋、真人發音 ---------- */
const enCache = new Map();
async function fetchEnglish(word) {
  if (enCache.has(word)) return enCache.get(word);
  const p = (async () => {
    const r = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
    if (!r.ok) return null;
    const data = await r.json();
    const out = { phon: '', audio: '', meanings: [] };
    for (const ent of data) {
      if (!out.phon && ent.phonetic) out.phon = ent.phonetic;
      for (const ph of ent.phonetics || []) {
        if (ph.audio && (!out.audio || /-us\.mp3$/.test(ph.audio))) out.audio = ph.audio;
        if (!out.phon && ph.text) out.phon = ph.text;
      }
      for (const m of ent.meanings || []) {
        let g = out.meanings.find(x => x.pos === m.partOfSpeech);
        if (!g) { g = { pos: m.partOfSpeech, defs: [], syn: [] }; out.meanings.push(g); }
        for (const d of m.definitions || []) if (g.defs.length < 4) g.defs.push({ def: d.definition, ex: d.example || '' });
        for (const s of (m.synonyms || []).slice(0, 5)) if (!g.syn.includes(s)) g.syn.push(s);
      }
    }
    return out.meanings.length ? out : null;
  })().catch(() => null);
  enCache.set(word, p);
  return p;
}
async function fetchZhOnline(word) {
  try {
    const r = await fetch('https://api.mymemory.translated.net/get?langpair=en|zh-TW&q=' + encodeURIComponent(word));
    const j = await r.json();
    const t = j && j.responseData && j.responseData.translatedText;
    return t && t.toLowerCase() !== word.toLowerCase() ? t : '';
  } catch { return ''; }
}

/* ---------- 語音 ---------- */
let VOICES = [];
function loadVoices() { VOICES = speechSynthesis.getVoices(); }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = () => { loadVoices(); if (currentView === 'settings') renderSettings(); }; }
function pickVoice(lang) {
  const key = lang === 'en' ? 'enVoice' : 'zhVoice';
  if (S.settings[key]) { const v = VOICES.find(v => v.voiceURI === S.settings[key]); if (v) return v; }
  const prefs = lang === 'en' ? ['en-US', 'en-GB', 'en'] : ['zh-TW', 'zh-HK', 'zh-CN', 'zh'];
  for (const p of prefs) { const v = VOICES.find(v => v.lang.replace('_', '-').startsWith(p)); if (v) return v; }
  return null;
}
function speak(text, lang = 'en', rate) {
  return new Promise(res => {
    if (!('speechSynthesis' in window) || !text) return res();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.lang = v ? v.lang : (lang === 'en' ? 'en-US' : 'zh-TW');
    u.rate = rate || S.settings.rate;
    let done = false; const fin = () => { if (!done) { done = true; res(); } };
    u.onend = fin; u.onerror = fin;
    setTimeout(fin, 4000 + text.length * 250); // 保險：iOS 偶爾不觸發 onend
    speechSynthesis.speak(u);
  });
}
function say(text, lang) { if ('speechSynthesis' in window) speechSynthesis.cancel(); return speak(text, lang); }

/* ---------- 單字冊資料 ---------- */
function getWord(w) { return S.words[w]; }
function addWord(w, entry, extra) {
  const t = now();
  const item = {
    word: w, phon: entry?.phon || '', zh: entry?.zh || '', rank: entry?.rank || 0,
    contexts: [], note: '', added: t, lastLookup: t, lookups: 1,
    cards: { rec: FSRS.newCard() }
  };
  S.words[w] = item;
  delete S.deleted[w];
  if (extra) addContext(item, extra);
  touch(item);
  save();
  return item;
}
function addContext(item, { sentence, zh, source, ep, note, nf, url, t, sense }) {
  touch(item);
  if (sentence || source || ep || zh || sense) {
    const c = { sentence: (sentence || '').trim(), zh: (zh || '').trim(), source: (source || '').trim(), ep: (ep || '').trim(), sense: (sense || '').trim(), at: now() };
    if (nf) { c.nf = String(nf); c.t = Math.max(0, Math.floor(t || 0) - 3); } // Netflix 影片編號與秒數，可跳回那一幕
    else if (url) { c.url = url; if (t) c.t = Math.max(0, Math.floor(t) - 3); }  // 網頁／YouTube 出處
    item.contexts.push(c);
    refreshMeaning(item);
  }
  if (note) item.note = item.note ? item.note + '\n' + note : note;
  if (source) S.lastSource = source.trim();
  if (ep) S.lastEp = ep.trim();
}
// 認字卡穩定到 3 天以上，才解鎖「聽力」與「拼寫」：從看得懂 → 聽得懂 → 寫得出
function unlockCards(item) {
  const r = item.cards.rec;
  if (r.state === 'review' && r.s >= 3) {
    if (!item.cards.lis) item.cards.lis = { ...FSRS.newCard(), unlocked: now() };
    if (!item.cards.pro) item.cards.pro = { ...FSRS.newCard(), unlocked: now() };
  }
}
function cardTier(c) {
  if (!c || c.state === 'new') return 0;
  if (c.state !== 'review') return 1;
  if (c.s >= 21) return 3;
  if (c.s >= 7) return 2;
  return 1;
}
function wordStatus(item) {
  const c = item.cards;
  if (c.rec.state === 'new') return 'new';
  const tiers = ['rec', 'lis', 'pro'].map(k => cardTier(c[k]));
  if (tiers.every(t => t === 3)) return 'mastered';
  if (tiers[0] >= 2) return 'familiar';
  return 'learning';
}
const STATUS_ZH = { new: '新字', learning: '學習中', familiar: '熟悉', mastered: '熟記' };
const lapsesOf = item => Object.values(item.cards).reduce((a, c) => a + (c.lapses || 0), 0);
function dotsHtml(item) {
  return '<span class="dots">' + ['rec', 'lis', 'pro'].map(k => { const t = cardTier(item.cards[k]); return `<i class="${t ? 'on' + t : ''}" title="${TYPES[k]}"></i>`; }).join('') + '</span>';
}
function nextDueOf(item) {
  let m = Infinity;
  for (const c of Object.values(item.cards)) if (c.state !== 'new' && c.due < m) m = c.due;
  return m;
}
// 再查一次 = 之前沒記住：把它拉回來盡快複習
function relookup(item) {
  const t = now();
  const gap = t - (item.lastLookup || item.added);
  item.lookups = (item.lookups || 1) + 1;
  item.lastLookup = t;
  touch(item);
  let msg = '';
  if (gap > 6 * 36e5) {
    const r = item.cards.rec;
    if (r.state === 'review') {
      item.cards.rec = FSRS.review(r, 1, t, S.settings.retention);
      msg = `這是你第 ${item.lookups} 次查這個字。已把它排回今天的複習。`;
    } else {
      msg = `這是你第 ${item.lookups} 次查這個字，它已經在你的複習清單裡。`;
    }
  }
  save();
  return msg;
}

/* ---------- 共用 UI ---------- */
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2600); }
function openSheet(html, onMount) {
  $('#sheet-body').innerHTML = html; $('#sheet').hidden = false;
  onMount && onMount($('#sheet-body'));
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet-body').innerHTML = ''; }
$('#sheet .sheet-bg').onclick = closeSheet;
function highlight(sentence, word) {
  const s = esc(sentence);
  if (!word) return s;
  const parts = word.split(' ').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const stem = parts.map(p => p.length > 3 ? p.replace(/e$|y$/, '') + "[a-z']*" : p + "[a-z']*").join('\\s+(?:\\w+\\s+)?');
  try { return s.replace(new RegExp('\\b(' + stem + ')', 'ig'), '<em>$1</em>'); } catch { return s; }
}
function sceneLink(c) {
  if (!c) return '';
  const mmss = t => Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  if (c.nf) return ` <a class="link" target="_blank" rel="noopener" href="https://www.netflix.com/watch/${encodeURIComponent(c.nf)}?t=${c.t || 0}">▶︎ 回到這一幕 ${mmss(c.t || 0)}</a>`;
  if (c.url && /^https?:\/\//.test(c.url)) {
    const yt = /youtube\.com\/watch/.test(c.url);
    const href = yt && c.t ? c.url + '&t=' + c.t + 's' : c.url;
    return ` <a class="link" target="_blank" rel="noopener" href="${esc(href)}">${yt ? '▶︎ 回到這一幕 ' + mmss(c.t || 0) : '↗ 回到原文'}</a>`;
  }
  return '';
}
function clozeOf(sentence, word) {
  const html = highlight(sentence, word);
  return html.includes('<em>') ? html.replace(/<em>([^<]*)<\/em>/g, (_, m) => '<em>' + m.split(/\s+/).map(() => '＿＿＿').join(' ') + '</em>') : '';
}

let currentView = 'search';
const TITLES = { search: '查詢', book: '單字冊', review: '複習', walk: '邊走邊背', settings: '設定' };
function show(v) {
  if (currentView === 'walk' && v !== 'walk') walkStop();
  currentView = v;
  $$('.view').forEach(x => x.classList.toggle('active', x.id === 'view-' + v));
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('#title').textContent = TITLES[v];
  $('#topright').innerHTML = '';
  if (v === 'book') renderBook();
  if (v === 'review') renderReviewHome();
  if (v === 'walk') renderWalkHome();
  if (v === 'settings') renderSettings();
  if (v === 'search') renderRecent();
  window.scrollTo(0, 0);
}
$$('#tabs button').forEach(b => b.onclick = () => show(b.dataset.v));

/* ---------- 查詢 ---------- */
const qEl = $('#q');
let sugTimer;
qEl.addEventListener('input', () => {
  clearTimeout(sugTimer);
  $('#qclear').style.visibility = qEl.value ? 'visible' : 'hidden';
  if (isSentence(qEl.value)) { const v = qEl.value; qEl.value = ''; setSentence(v); return; }
  sugTimer = setTimeout(renderSuggest, 80);
});
// 貼上時直接讀剪貼簿原文（搜尋框會吃掉換行，英中兩行會黏在一起）
qEl.addEventListener('paste', e => {
  const raw = e.clipboardData && e.clipboardData.getData('text');
  if (raw && isSentence(raw)) { e.preventDefault(); qEl.value = ''; setSentence(raw); }
});
qEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doLookup(qEl.value); qEl.blur(); } });
$('#qclear').onclick = () => { qEl.value = ''; $('#suggest').innerHTML = ''; $('#result').innerHTML = ''; $('#sentence').innerHTML = ''; curSentence = null; $('#search-empty').hidden = false; $('#qclear').style.visibility = 'hidden'; renderRecent(); qEl.focus(); };

/* ---------- 貼上整句字幕 ---------- */
let curSentence = null; // { en, zh, tokens }
const CJK = /[　-〿㐀-鿿＀-￯]/;
function isSentence(t) {
  t = (t || '').trim();
  if (!t) return false;
  if (CJK.test(t) && /[a-z]/i.test(t)) return true;
  if (/\n/.test(t)) return true;
  return t.split(/\s+/).length >= 4;
}
function parseSubtitle(raw) {
  const en = [], zh = [];
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim(); if (!line) continue;
    // 同一行裡英中混在一起時，把中文段落拆出來
    const zhPart = (line.match(/[　-〿㐀-鿿＀-￯][　-〿㐀-鿿＀-￯\s\d，。！？、…a-zA-Z]*/g) || []);
    let enPart = line;
    if (zhPart.length) { for (const z of zhPart) enPart = enPart.replace(z, ' '); }
    enPart = enPart.replace(/^\s*[-–—]\s*/, '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (enPart && /[a-z]/i.test(enPart)) en.push(enPart);
    const z = zhPart.join('').trim(); if (z) zh.push(z);
  }
  return { en: en.join(' ').replace(/\s+/g, ' '), zh: zh.join(' ') };
}
function setSentence(raw) {
  const { en, zh } = parseSubtitle(raw);
  if (!en) { toast('沒有找到英文句子'); return; }
  // 斷成單字和標點；I'm / don't 這類縮寫保持完整
  const tokens = en.match(/[A-Za-z]+(?:['’][A-Za-z]+)*|[^A-Za-z]+/g) || [];
  curSentence = { en, zh, tokens };
  $('#suggest').innerHTML = ''; $('#result').innerHTML = ''; $('#search-empty').hidden = true;
  $('#qclear').style.visibility = 'visible';
  renderSentence();
}
function renderSentence(active) {
  const s = curSentence; if (!s) { $('#sentence').innerHTML = ''; return; }
  let wi = 0;
  const html = s.tokens.map((t, i) => /[A-Za-z]/.test(t)
    ? `<button class="tok ${active === i ? 'on' : ''} ${getWord(t.toLowerCase()) ? 'known' : ''}" data-i="${i}">${esc(t)}</button>`
    : `<span>${esc(t)}</span>`).join('');
  $('#sentence').innerHTML = `<div class="card sent">
      <div class="sent-en">${html}</div>
      ${s.zh ? `<div class="sent-zh">${esc(s.zh)}</div>` : ''}
      <div class="sent-bar"><span class="muted">點不懂的字查詢</span><button class="link" id="sent-say">🔊 念整句</button></div>
      <div id="phr"></div>
    </div>`;
  $$('#sentence .tok').forEach(b => b.onclick = () => tapToken(+b.dataset.i));
  $('#sent-say').onclick = () => say(s.en, 'en');
}
// 點一個字：查這個字，並找出句子裡包含它的片語（例如 figure it out → figure out）
function tapToken(i) {
  const s = curSentence;
  const words = []; const idx = [];
  s.tokens.forEach((t, j) => { if (/[A-Za-z]/.test(t)) { words.push(norm(t.replace(/’/g, "'"))); idx.push(j); } });
  const k = idx.indexOf(i); if (k < 0) return;
  const lem = w => DICT.f[w] || w;
  const found = [];
  const tryP = arr => { for (const v of [arr.join(' '), [lem(arr[0]), ...arr.slice(1)].join(' ')]) if (DICT.e[v] && v.includes(' ') && !found.includes(v)) found.push(v); };
  for (let a = Math.max(0, k - 2); a <= k; a++) for (let b = k; b <= Math.min(words.length - 1, a + 3); b++) if (b > a) tryP(words.slice(a, b + 1));
  // 中間夾一個字的片語：figure it out、pick him up
  if (k + 2 < words.length) tryP([words[k], words[k + 2]]);
  if (k >= 2) tryP([words[k - 2], words[k]]);
  renderSentence(i);
  $('#phr').innerHTML = found.length ? `<div class="sec-t" style="margin-top:12px">句子裡的片語</div><div class="tags">${found.slice(0, 5).map(p => `<button class="tag lv" data-p="${esc(p)}">${esc(p)}</button>`).join('')}</div>` : '';
  $$('#phr [data-p]').forEach(b => b.onclick = () => doLookup(b.dataset.p, { keepSentence: true }));
  doLookup(words[k], { keepSentence: true });
}
$('#qclear').style.visibility = 'hidden';
// 📋 一鍵貼上剪貼簿：整句 → 句子模式；一個字 → 直接查
$('#qpaste').onclick = async () => {
  let t = '';
  try { t = await navigator.clipboard.readText(); } catch { toast('沒辦法讀剪貼簿，請長按輸入框貼上'); return; }
  t = (t || '').trim();
  if (!t) { toast('剪貼簿是空的'); return; }
  if (isSentence(t)) { qEl.value = ''; setSentence(t); }
  else doLookup(t);
};

function renderSuggest() {
  const p = norm(qEl.value);
  const list = prefixSearch(p);
  $('#suggest').innerHTML = list.map(w => `<li data-w="${esc(w)}"><b>${esc(w)}</b><span>${esc(shortZh(DICT.e[w][1], 3))}</span></li>`).join('');
  $$('#suggest li').forEach(li => li.onclick = () => { qEl.value = li.dataset.w; doLookup(li.dataset.w); });
  if (p) { $('#search-empty').hidden = true; }
}

async function doLookup(q, opts = {}) {
  const { w, entry, lemma } = lookupLocal(q);
  if (!w) return;
  if (!opts.keepSentence) { curSentence = null; $('#sentence').innerHTML = ''; }
  $('#suggest').innerHTML = '';
  $('#search-empty').hidden = true;
  qEl.value = w;
  $('#qclear').style.visibility = 'visible';
  // 最近查過
  S.recent = [w, ...S.recent.filter(x => x !== w)].slice(0, 30);
  let banner = '';
  const existing = getWord(w);
  if (existing && !opts.silent) banner = relookup(existing);
  save();

  const e = entry || (existing ? { word: w, phon: existing.phon, zh: existing.zh, rank: existing.rank } : null);
  const res = $('#result');
  if (!e && !lemma) {
    const fz = fuzzy(w);
    res.innerHTML = `<div class="card"><div class="word-h"><h2>${esc(w)}</h2><button class="speak" data-say="${esc(w)}">🔊</button></div>
      <p class="muted" id="zh-online">離線字典沒有這個字，正在線上查…</p>
      ${fz.length ? `<div class="sec-t">你是不是要找</div><div class="tags">${fz.map(x => `<a class="link tag" data-go="${esc(x)}">${esc(x)}</a>`).join('')}</div>` : ''}
      <div id="en-area"></div>
      <div style="margin-top:16px" id="add-area"></div></div>`;
    bindResult(w, { word: w, phon: '', zh: '', rank: 0 });
    fetchZhOnline(w).then(zh => {
      const el = $('#zh-online'); if (!el || qEl.value !== w) return;
      if (zh) { el.className = 'zh'; el.textContent = zh + '（線上翻譯）'; res._entry.zh = zh; }
      else el.textContent = '線上也找不到中文翻譯，可能拼錯了，或是專有名詞。';
    });
    return;
  }
  if (!e && lemma) { return doLookup(lemma, { ...opts, from: w }); }

  const lv = level(e.rank);
  res.innerHTML = `
    ${banner ? `<div class="banner">${esc(banner)}</div>` : ''}
    <div class="card">
      <div class="word-h"><h2>${esc(w)}</h2><button class="speak" data-say="${esc(w)}" aria-label="發音">🔊</button></div>
      <div class="phon" id="phon">${e.phon ? '/' + esc(e.phon) + '/' : ''}</div>
      <div class="tags">
        ${lv ? `<span class="tag lv">${lv}</span>` : ''}
        ${e.collins ? `<span class="tag">柯林斯 ${'★'.repeat(e.collins)}</span>` : ''}
        ${existing ? `<span class="tag lv">單字冊・${STATUS_ZH[wordStatus(existing)]}</span>` : ''}
      </div>
      ${lemma && lemma !== w ? `<div class="lemma-note">${esc(w)} 是 <a class="link" data-go="${esc(lemma)}">${esc(lemma)}</a> 的變化形</div>` : ''}
      ${opts.from ? `<div class="lemma-note">你查的「${esc(opts.from)}」是 ${esc(w)} 的變化形（過去式、複數、-ing 等）</div>` : ''}
      <div class="zh">${sensesHtml(e.zh, existing?.meaning)}</div>
      <div id="en-area"><div class="sec-t">英英解釋</div><p class="muted">載入中…</p></div>
      <div style="margin-top:16px" id="add-area"></div>
    </div>`;
  bindResult(w, e);
  if (S.settings.autoSpeak && !opts.silent) say(w, 'en');
}

function bindResult(w, e) {
  const res = $('#result');
  res._entry = e;
  res.querySelectorAll('[data-say]').forEach(b => b.onclick = () => say(b.dataset.say, 'en'));
  res.querySelectorAll('[data-go]').forEach(a => a.onclick = () => doLookup(a.dataset.go));
  renderAddArea(w);
  fetchEnglish(w).then(en => {
    const area = $('#en-area'); if (!area || qEl.value !== w) return;
    if (!en) { area.innerHTML = navigator.onLine ? '<div class="sec-t">英英解釋</div><p class="muted">沒有找到英英解釋。</p>' : '<div class="sec-t">英英解釋</div><p class="muted">離線中，連上網路後可看英英解釋和例句。</p>'; return; }
    if (!e.phon && en.phon) { $('#phon') && ($('#phon').textContent = en.phon); e.phon = en.phon.replace(/^\/|\/$/g, ''); }
    area.innerHTML = `<div class="sec-t">英英解釋 ${en.audio ? `<button class="link" id="realaudio" style="margin-left:6px">▶︎ 真人發音</button>` : ''}</div>
      <ul class="en-def">${en.meanings.map(m => m.defs.map((d, i) => `<li>${i === 0 ? `<span class="pos">${esc(m.pos)}</span>` : ''}${esc(d.def)}${d.ex ? `<div class="ex">“${esc(d.ex)}”</div>` : ''}</li>`).join('') + (m.syn.length ? `<li class="muted">同義：${m.syn.map(esc).join(', ')}</li>` : '')).join('')}</ul>`;
    const ra = $('#realaudio'); if (ra) ra.onclick = () => new Audio(en.audio).play();
    const item = getWord(w); if (item && !item.en) { item.en = en.meanings.slice(0, 3); save(); }
  });
}

function renderAddArea(w) {
  const area = $('#add-area'); if (!area) return;
  const item = getWord(w);
  if (item) {
    area.innerHTML = `<div class="row"><button class="btn ghost" id="addctx">＋ 記下這次的出處</button><button class="btn plain" id="openword">看單字卡</button></div>`;
    $('#addctx').onclick = () => openAddSheet(w, true);
    $('#openword').onclick = () => openWordSheet(w);
  } else {
    area.innerHTML = `<button class="btn block" id="addbtn">⭐ 加入單字冊</button>`;
    $('#addbtn').onclick = () => openAddSheet(w, false);
  }
}

function openAddSheet(w, existing) {
  const zhAll = existing ? getWord(w).zh : ($('#result')._entry?.zh || '');
  const senses = senseList(zhAll);
  const picked = new Set(guessSenses(senses, curSentence?.zh));
  openSheet(`
    <h3 style="margin:0 0 4px">${existing ? '再記一筆出處' : '加入單字冊'}：${esc(w)}</h3>
    <p class="muted" style="margin:0 0 12px">記下在哪裡看到、原本那句台詞。有「情境」的字比單獨背的字好記很多。全部都可以不填。</p>
    ${curSentence?.en ? `<div class="ctx-item">${highlight(curSentence.en, w)}${curSentence.zh ? `<div class="ctx-zh">${esc(curSentence.zh)}</div>` : ''}</div>` : ''}
    <div class="field"><label>在這句裡是什麼意思？（點選，可多選；卡片只會考你選的）</label>
      <div class="tags" id="f-senses">${senses.map((s, i) => `<button type="button" class="tag sense ${picked.has(i) ? 'on' : ''}" data-i="${i}"><small>${esc(s.pos)}</small> ${esc(s.t)}</button>`).join('') || '<span class="muted">字典沒有中文解釋，請自己寫</span>'}</div>
      <input id="f-sense" style="margin-top:8px" placeholder="或自己寫，例如：論點、理由" value="${esc([...picked].map(i => senses[i].t).join('、'))}">
    </div>
    <div class="row">
      <div class="field" style="flex:2"><label>影集／來源</label><input id="f-src" list="srclist" value="${esc(curSentence?.src || S.lastSource || '')}" placeholder="例如 Friends"></div>
      <div class="field" style="flex:1"><label>集數</label><input id="f-ep" value="${esc(curSentence?.ep || S.lastEp || '')}" placeholder="S01E03"></div>
    </div>
    <datalist id="srclist">${[...new Set(Object.values(S.words).flatMap(x => x.contexts.map(c => c.source)).filter(Boolean))].map(s => `<option value="${esc(s)}">`).join('')}</datalist>
    <div class="field"><label>原句（台詞）</label><textarea id="f-sent" placeholder="把那句英文貼上或打下來">${esc(curSentence?.en || '')}</textarea></div>
    <div class="field"><label>中文字幕（這句在劇裡的意思）</label><input id="f-zh" value="${esc(curSentence?.zh || '')}" placeholder="選填"></div>
    <div class="field"><label>我的筆記</label><input id="f-note" placeholder="自己的理解、聯想、造句…"></div>
    <button class="btn block" id="f-save">${existing ? '儲存' : '加入'}</button>
    <button class="btn block plain" style="margin-top:8px" id="f-cancel">取消</button>`, body => {
    body.querySelector('#f-cancel').onclick = closeSheet;
    body.querySelectorAll('#f-senses .sense').forEach(b => b.onclick = () => {
      const i = +b.dataset.i;
      picked.has(i) ? picked.delete(i) : picked.add(i);
      b.classList.toggle('on', picked.has(i));
      $('#f-sense').value = [...picked].sort((a, c) => a - c).map(k => senses[k].t).join('、');
    });
    body.querySelector('#f-save').onclick = () => {
      const sense = $('#f-sense').value.replace(/[,，;；]/g, '、').replace(/\s*、\s*/g, '、').trim();
      const extra = { source: $('#f-src').value, ep: $('#f-ep').value, sentence: $('#f-sent').value, zh: $('#f-zh').value, note: $('#f-note').value, nf: curSentence?.nf, url: curSentence?.url, t: curSentence?.t, sense };
      if (existing) { addContext(getWord(w), extra); save(); toast('已記下'); }
      else {
        const item = addWord(w, $('#result')._entry, extra);
        fetchEnglish(w).then(en => { if (en) { item.en = en.meanings.slice(0, 3); save(); } });
        toast('已加入單字冊，今天就會開始複習');
      }
      closeSheet(); renderAddArea(w); updateBadge();
    };
  });
}

function renderRecent() {
  const el = $('#recent'); if (!el) return;
  const list = S.recent.slice(0, 10);
  el.innerHTML = list.length ? `<div class="sec-t">最近查過</div><ul class="wordlist">${list.map(w => {
    const e = DICT?.e[w], it = getWord(w);
    return `<li data-w="${esc(w)}"><div class="w"><b>${esc(w)}</b><div>${esc(shortZh(e ? e[1] : it?.zh || '', 3))}</div></div>${it ? dotsHtml(it) : ''}</li>`;
  }).join('')}</ul>` : '';
  el.querySelectorAll('li').forEach(li => li.onclick = () => doLookup(li.dataset.w, { silent: true }));
}

/* ---------- 單字卡詳細 ---------- */
function openWordSheet(w) {
  const it = getWord(w); if (!it) return;
  const t = now();
  const cardRows = ['rec', 'lis', 'pro'].map(k => {
    const c = it.cards[k];
    if (!c) return `<div class="set-row"><label>${TYPES[k]}</label><span class="muted">認字穩定後解鎖</span></div>`;
    const st = c.state === 'new' ? '還沒學' : c.state === 'review' ? `記憶可撐約 ${FSRS.fmtDelay(c.s * DAY)}` : '短期練習中';
    const due = c.state === 'new' ? '' : (c.due <= t ? '現在該複習' : FSRS.fmtDelay(c.due - t) + '後複習');
    return `<div class="set-row"><label>${TYPES[k]}<small>${st}${c.lapses ? `・忘過 ${c.lapses} 次` : ''}</small></label><span class="muted">${due}</span></div>`;
  }).join('');
  openSheet(`
    <div class="word-h"><h2 style="font-size:28px">${esc(w)}</h2><button class="speak" id="ws-say">🔊</button><span class="tag lv">${STATUS_ZH[wordStatus(it)]}</span></div>
    ${it.phon ? `<div class="phon">/${esc(it.phon)}/</div>` : ''}
    <div class="field" style="margin-top:12px"><label>我要記的意思（卡片考這個）</label><input id="ws-meaning" value="${esc(it.meaning || '')}" placeholder="${esc(shortZh(it.zh, 3))}"></div>
    <div class="zh">${sensesHtml(it.zh, it.meaning)}</div>
    ${it.en ? `<div class="sec-t">英英</div><ul class="en-def">${it.en.map(m => `<li><span class="pos">${esc(m.pos)}</span>${esc(m.defs[0]?.def || '')}${m.defs[0]?.ex ? `<div class="ex">“${esc(m.defs[0].ex)}”</div>` : ''}</li>`).join('')}</ul>` : ''}
    <div class="sec-t">在哪裡看到</div>
    ${it.contexts.length ? it.contexts.map((c, i) => `<div class="ctx-item">${c.sentence ? highlight(c.sentence, w) : '<span class="muted">（沒有記原句）</span>'}${c.zh ? `<div class="ctx-zh">${esc(c.zh)}</div>` : ''}<div class="src">${esc([c.source, c.ep].filter(Boolean).join(' ・ '))}${c.sentence ? ` <button class="link" data-sayctx="${i}">🔊</button>` : ''}${sceneLink(c)}</div></div>`).join('') : '<p class="muted">還沒有記錄。</p>'}
    <div class="field" style="margin-top:12px"><label>我的筆記</label><textarea id="ws-note">${esc(it.note)}</textarea></div>
    <div class="sec-t">記憶狀態</div>
    <div class="set-group" style="box-shadow:none;background:var(--bg)">${cardRows}</div>
    <p class="muted">查了 ${it.lookups || 1} 次・加入於 ${new Date(it.added).toLocaleDateString('zh-TW')}</p>
    <div class="row"><button class="btn ghost" id="ws-ctx">＋ 出處</button><button class="btn plain" id="ws-close">完成</button></div>
    <button class="btn block danger" style="margin-top:10px" id="ws-del">從單字冊刪除</button>`, body => {
    body.querySelector('#ws-say').onclick = () => say(w, 'en');
    body.querySelectorAll('[data-sayctx]').forEach(b => b.onclick = () => say(it.contexts[+b.dataset.sayctx].sentence, 'en'));
    const saveNote = () => {
      let dirty = false;
      if (it.note !== $('#ws-note').value) { it.note = $('#ws-note').value; dirty = true; }
      const mv = $('#ws-meaning').value.replace(/[,，;；]/g, '、').trim();
      if ((it.meaning || '') !== mv) { it.meaning = mv; dirty = true; }
      if (dirty) { touch(it); save(); }
    };
    body.querySelector('#ws-meaning').onchange = saveNote;
    body.querySelector('#ws-note').onchange = saveNote;
    body.querySelector('#ws-close').onclick = () => { saveNote(); closeSheet(); if (currentView === 'book') renderBook(); };
    body.querySelector('#ws-ctx').onclick = () => { saveNote(); openAddSheet(w, true); };
    body.querySelector('#ws-del').onclick = () => {
      if (!confirm(`確定要刪除「${w}」和它的複習紀錄嗎？`)) return;
      delete S.words[w]; S.deleted[w] = now(); scheduleSync(); save(); closeSheet(); toast('已刪除'); if (currentView === 'book') renderBook(); else renderAddArea(w); updateBadge();
    };
  });
}

/* ---------- 單字冊列表 ---------- */
let bookFilter = 'all';
$$('#bookfilter button').forEach(b => b.onclick = () => { bookFilter = b.dataset.f; $$('#bookfilter button').forEach(x => x.classList.toggle('on', x === b)); renderBook(); });
$('#booksort').onchange = renderBook;
$('#bookq').oninput = renderBook;

function streak() {
  const days = new Set(S.log.map(l => dayKey(l.t)));
  let n = 0, t = now();
  if (!days.has(dayKey(t))) t -= DAY;
  while (days.has(dayKey(t))) { n++; t -= DAY; }
  return n;
}
function renderBook() {
  const words = Object.values(S.words);
  const q = queueInfo();
  $('#bookstats').innerHTML = `
    <div class="stat"><b>${words.length}</b><span>單字</span></div>
    <div class="stat"><b>${q.due + q.newAvail}</b><span>今天要練</span></div>
    <div class="stat"><b>${words.filter(w => wordStatus(w) === 'mastered').length}</b><span>熟記</span></div>
    <div class="stat"><b>${streak()}</b><span>連續天數</span></div>`;
  const kw = norm($('#bookq').value);
  let list = words.filter(it => {
    if (kw && !it.word.includes(kw) && !(it.zh || '').includes(kw) && !it.contexts.some(c => (c.source || '').toLowerCase().includes(kw))) return false;
    if (bookFilter === 'all') return true;
    if (bookFilter === 'hard') return lapsesOf(it) >= 2 || (it.lookups || 1) >= 3;
    return wordStatus(it) === bookFilter;
  });
  const sort = $('#booksort').value;
  const cmp = {
    added: (a, b) => b.added - a.added,
    due: (a, b) => nextDueOf(a) - nextDueOf(b),
    lapses: (a, b) => (lapsesOf(b) + (b.lookups || 1)) - (lapsesOf(a) + (a.lookups || 1)),
    alpha: (a, b) => a.word.localeCompare(b.word),
    source: (a, b) => (a.contexts[0]?.source || '~').localeCompare(b.contexts[0]?.source || '~') || b.added - a.added
  }[sort];
  list.sort(cmp);
  document.querySelector('.book-empty')?.remove();
  if (!words.length) {
    $('#booklist').innerHTML = '';
    $('#booklist').insertAdjacentHTML('afterend', '<div class="empty book-empty"><p class="big">單字冊還是空的</p><p>到「查詢」查一個字，按「加入單字冊」就會出現在這裡。</p></div>');
    return;
  }
  const t = now();
  let html = '', lastSrc = null;
  for (const it of list) {
    if (sort === 'source') {
      const src = it.contexts[0]?.source || '沒有記來源';
      if (src !== lastSrc) { html += `<li class="group-h">${esc(src)}</li>`; lastSrc = src; }
    }
    const nd = nextDueOf(it);
    const sub = sort === 'due' ? (it.cards.rec.state === 'new' ? '新字' : nd <= t ? '現在該複習' : FSRS.fmtDelay(nd - t) + '後') : meaningOf(it);
    html += `<li data-w="${esc(it.word)}"><div class="w"><b>${esc(it.word)}</b><div>${esc(sub)}</div></div>${dotsHtml(it)}</li>`;
  }
  $('#booklist').innerHTML = html || '<li class="muted">沒有符合的字</li>';
  $$('#booklist li[data-w]').forEach(li => li.onclick = () => openWordSheet(li.dataset.w));
}

/* ---------- 複習 ---------- */
function todayStat() { const k = dayKey(now()); return S.daily[k] || (S.daily[k] = { newRec: 0, newExtra: 0, reviews: 0 }); }
function allCards() {
  const out = [];
  for (const it of Object.values(S.words)) for (const k of Object.keys(it.cards)) out.push({ it, k, c: it.cards[k] });
  return out;
}
function queueInfo() {
  const eod = endOfDay(), ts = todayStat();
  let due = 0, newRec = 0, newExtra = 0;
  for (const { k, c } of allCards()) {
    if (c.state === 'new') { if (k === 'rec') newRec++; else newExtra++; }
    else if (c.due < eod) due++;
  }
  const lim = S.settings.newPerDay;
  const newAvail = Math.min(newRec, Math.max(0, lim - ts.newRec)) + Math.min(newExtra, Math.max(0, lim - ts.newExtra));
  return { due, newAvail, newRec, newExtra };
}
function updateBadge() {
  const q = queueInfo(), n = q.due + q.newAvail, b = $('#duebadge');
  b.hidden = !n; b.textContent = n > 99 ? '99+' : n;
}

let session = null;
function renderReviewHome() {
  $('#review-card').hidden = true;
  const home = $('#review-home'); home.hidden = false;
  const q = queueInfo(), ts = todayStat(), total = q.due + q.newAvail;
  const words = Object.keys(S.words).length;
  if (!words) { home.innerHTML = `<div class="empty"><p class="big">還沒有單字</p><p>先到「查詢」把看劇遇到的字加進來。</p></div>`; return; }
  const t = now();
  const upcoming = allCards().filter(x => x.c.state !== 'new' && x.c.due >= endOfDay()).sort((a, b) => a.c.due - b.c.due)[0];
  home.innerHTML = `
    <div class="card" style="text-align:center">
      ${total ? `<div class="big-num">${total}</div><div class="muted">張卡片等你練</div>` : `<div class="big-num">✓</div><div class="muted">今天的份做完了${ts.reviews ? `（練了 ${ts.reviews} 張）` : ''}</div>`}
      <div class="review-sum">
        <div><b>${q.due}</b><br><span>到期複習</span></div>
        <div><b>${q.newAvail}</b><br><span>新卡片</span></div>
        <div><b>${ts.reviews}</b><br><span>今天已練</span></div>
      </div>
      ${total ? `<button class="btn block" id="startrev">開始複習</button>` : (upcoming ? `<p class="muted">下一張在 ${FSRS.fmtDelay(upcoming.c.due - t)}後到期</p>` : '')}
      ${!total && (q.newRec || q.newExtra) ? `<button class="btn block ghost" id="morenew" style="margin-top:8px">再多學 5 張新卡</button>` : ''}
    </div>
    <div class="card how">
      <b>這裡怎麼幫你記住</b>
      <ol>
        <li><b>先回想再看答案</b>：自己想一次，比重看十次更有效（提取練習）。</li>
        <li><b>照記憶曲線排時間</b>：快忘掉的時候才出現，記得越牢，間隔越長；忘了就從短間隔重來。</li>
        <li><b>三種卡片</b>：先能「看懂」，穩定後才解鎖「聽懂」和「拼出來」。三種都牢固，這個字才算熟記。</li>
        <li><b>帶著台詞記</b>：拼寫卡會用你記下的原句挖空，把字跟劇情連在一起。</li>
      </ol>
      <span class="muted">按「忘了／困難」不用怕，誠實回答，排程才會準。</span>
    </div>`;
  const sb = $('#startrev'); if (sb) sb.onclick = () => startSession();
  const mn = $('#morenew'); if (mn) mn.onclick = () => { ts.newRec = Math.max(0, ts.newRec - 5); ts.newExtra = Math.max(0, ts.newExtra - 5); save(); startSession(); };
}

function startSession() {
  const eod = endOfDay(), ts = todayStat(), lim = S.settings.newPerDay;
  const due = [], newRec = [], newExtra = [];
  for (const x of allCards()) {
    if (x.c.state === 'new') (x.k === 'rec' ? newRec : newExtra).push(x);
    else if (x.c.due < eod) due.push(x);
  }
  newRec.sort((a, b) => a.it.added - b.it.added);
  newExtra.sort((a, b) => (a.c.unlocked || 0) - (b.c.unlocked || 0));
  const news = [...newRec.slice(0, Math.max(0, lim - ts.newRec)), ...newExtra.slice(0, Math.max(0, lim - ts.newExtra))];
  // 打散順序（交錯練習），同一個字的不同卡片盡量不要連著出現
  shuffle(due); shuffle(news);
  session = { keys: [...due, ...news].map(x => x.it.word + '|' + x.k), done: 0, startTotal: due.length + news.length, lastWord: '', again: 0 };
  if (!session.keys.length) { renderReviewHome(); return; }
  $('#review-home').hidden = true; $('#review-card').hidden = false;
  nextCard();
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function pickNext() {
  const t = now();
  const items = session.keys.map(key => { const [w, k] = key.split('|'); const it = S.words[w]; return it && it.cards[k] ? { key, it, k, c: it.cards[k] } : null; }).filter(Boolean);
  session.keys = items.map(x => x.key);
  if (!items.length) return null;
  const learningNow = items.filter(x => (x.c.state === 'learning' || x.c.state === 'relearning') && x.c.due <= t).sort((a, b) => a.c.due - b.c.due);
  const notSame = arr => arr.find(x => x.it.word !== session.lastWord) || arr[0];
  if (learningNow.length) return notSame(learningNow);
  const rest = items.filter(x => x.c.state === 'new' || x.c.state === 'review');
  if (rest.length) {
    // 大約每 3 張複習插 1 張新卡
    const rev = rest.filter(x => x.c.state === 'review'), nw = rest.filter(x => x.c.state === 'new');
    const wantNew = nw.length && (!rev.length || session.done % 4 === 3);
    return notSame(wantNew ? nw : rev);
  }
  // 只剩短期練習中的卡：20 分鐘內到期的就提前練
  const soon = items.filter(x => x.c.due - t < 20 * MIN).sort((a, b) => a.c.due - b.c.due);
  return soon[0] || null;
}

function nextCard() {
  const x = pickNext();
  if (!x) { finishSession(); return; }
  session.cur = x;
  session.lastWord = x.it.word;
  renderCard(x, false);
}

function finishSession() {
  const s = session; session = null;
  $('#review-card').innerHTML = `<div class="card" style="text-align:center;padding:30px 18px">
    <div class="big-num">🎉</div><h2 style="margin:10px 0 4px">這一輪完成了</h2>
    <p class="muted">練了 ${s.done} 張${s.again ? `，其中 ${s.again} 次忘了（之後會再出現）` : ''}。</p>
    <button class="btn block" id="backhome">回到複習</button></div>`;
  $('#backhome').onclick = renderReviewHome;
  updateBadge();
}

function renderCard(x, revealed) {
  const { it, k, c } = x;
  const w = it.word;
  const ctx = it.contexts.find(cx => cx.sentence);
  const total = session.done + session.keys.length;
  const pct = total ? session.done / total * 100 : 0;
  let prompt = '', answer = '';
  const zhShort = meaningOf(it, 4) || it.zh;
  const fullAnswer = `
    <div class="word-h" style="justify-content:center"><h2 style="font-size:30px">${esc(w)}</h2><button class="speak" data-say="${esc(w)}">🔊</button></div>
    ${it.phon ? `<div class="phon" style="text-align:center">/${esc(it.phon)}/</div>` : ''}
    <div class="zh" style="text-align:center">${sensesHtml(it.zh, it.meaning)}</div>
    ${it.en && it.en[0] ? `<p class="muted" style="text-align:center">${esc(it.en[0].defs[0]?.def || '')}</p>` : ''}
    ${ctx ? `<div class="ctx">${highlight(ctx.sentence, w)}${ctx.zh ? `<div class="ctx-zh">${esc(ctx.zh)}</div>` : ''}<div class="muted" style="font-size:12px">${esc([ctx.source, ctx.ep].filter(Boolean).join(' ・ '))}${sceneLink(ctx)}</div></div>` : ''}
    ${it.note ? `<p class="muted">📝 ${esc(it.note)}</p>` : ''}`;

  if (k === 'rec') {
    prompt = `<h2>${esc(w)}</h2>${it.phon ? `<div class="phon">/${esc(it.phon)}/</div>` : ''}
      ${ctx ? `<div class="ctx">${highlight(ctx.sentence, w)}</div>` : ''}
      <div class="hint">這個字是什麼意思？先在心裡回答</div>`;
  } else if (k === 'lis') {
    prompt = `<div style="font-size:54px">🎧</div><button class="btn ghost" id="replay">再聽一次</button> <button class="btn plain" id="slow">慢速</button>
      <div class="hint">聽到的是哪個字？什麼意思？</div>`;
  } else {
    const cz = ctx ? clozeOf(ctx.sentence, w) : '';
    prompt = `<div class="q">${esc(zhShort)}</div>
      ${cz ? `<div class="ctx">${cz}</div>` : ''}
      <input class="typein" id="typein" placeholder="拼出英文" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" ${revealed ? 'disabled' : ''}>
      <div class="hint">${w.length > 1 ? `提示：${esc(w[0])}${'＿'.repeat(Math.min(w.replace(/ /g, '').length - 1, 12))}（${w.length} 個字元）` : ''}</div>`;
  }
  if (revealed) answer = `<div class="answer">${fullAnswer}</div>`;

  const t = now();
  const gradesHtml = revealed ? `<div class="grades">${[1, 2, 3, 4].map(g => {
    const n = FSRS.review(c, g, t, S.settings.retention);
    return `<button class="g${g}" data-g="${g}">${['忘了', '困難', '記得', '簡單'][g - 1]}<small>${FSRS.fmtDelay(n.due - t)}</small></button>`;
  }).join('')}</div>` : `<button class="btn block" id="reveal" style="margin-top:14px">顯示答案</button>`;

  $('#review-card').innerHTML = `
    <div class="rc-top"><span class="rc-type">${TYPES[k]}</span><span>${c.state === 'new' ? '新卡' : c.state === 'review' ? '複習' : '再練一次'}・還有 ${session.keys.length} 張</span><button class="link" id="quit">結束</button></div>
    <div class="progress"><i style="width:${pct}%"></i></div>
    <div class="card flash"><div class="prompt">${prompt}</div>${answer}</div>
    ${gradesHtml}`;
  const root = $('#review-card');
  root.querySelectorAll('[data-say]').forEach(b => b.onclick = () => say(b.dataset.say, 'en'));
  $('#quit').onclick = () => { session = null; renderReviewHome(); updateBadge(); };
  if (k === 'lis') {
    $('#replay').onclick = () => say(w, 'en');
    $('#slow').onclick = () => { speechSynthesis.cancel(); speak(w, 'en', 0.55); };
    if (!revealed) say(w, 'en');
  }
  let suggested = 0;
  if (k === 'pro') {
    const inp = $('#typein');
    if (revealed) {
      inp.value = session.typed || '';
      const ok = norm(inp.value) === norm(w);
      inp.classList.add(inp.value ? (ok ? 'ok' : 'bad') : 'x');
      suggested = inp.value ? (ok ? 3 : 1) : 0;
    } else {
      session.typed = '';
      setTimeout(() => inp.focus(), 50);
      inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); session.typed = inp.value; renderCard(x, true); } };
    }
  }
  if (!revealed) {
    $('#reveal').onclick = () => { if (k === 'pro') session.typed = $('#typein').value; renderCard(x, true); if (k !== 'lis') say(w, 'en'); };
  } else {
    if (suggested) root.querySelector(`[data-g="${suggested}"]`)?.classList.add('suggested');
    root.querySelectorAll('[data-g]').forEach(b => b.onclick = () => grade(x, +b.dataset.g));
  }
}

function grade(x, g) {
  const { it, k, c } = x;
  const t = now(), ts = todayStat();
  if (c.state === 'new') { if (k === 'rec') ts.newRec++; else ts.newExtra++; }
  const n = FSRS.review(c, g, t, S.settings.retention);
  it.cards[k] = n;
  touch(it);
  if (n.unlocked === undefined && c.unlocked) n.unlocked = c.unlocked;
  S.log.push({ t, w: it.word, k, g });
  if (S.log.length > 20000) S.log = S.log.slice(-15000);
  ts.reviews++;
  session.done++;
  if (g === 1) session.again++;
  const before = Object.keys(it.cards).length;
  unlockCards(it);
  if (Object.keys(it.cards).length > before) toast(`「${it.word}」解鎖了聽力和拼寫卡`);
  // 還在短期練習、今天會再出現的留在佇列裡
  if (!((n.state === 'learning' || n.state === 'relearning') && n.due < endOfDay())) session.keys = session.keys.filter(key => key !== it.word + '|' + k);
  save(); updateBadge();
  nextCard();
}

/* ---------- 邊走邊背 ---------- */
let walk = null, wakeLock = null;
function walkPool(kind) {
  const words = Object.values(S.words), t = now(), eod = endOfDay();
  switch (kind) {
    case 'due': return words.filter(it => Object.values(it.cards).some(c => c.state === 'new' || c.due < eod));
    case 'recent': return words.filter(it => t - it.added < 7 * DAY);
    case 'learning': return words.filter(it => ['new', 'learning'].includes(wordStatus(it)));
    case 'hard': return words.filter(it => lapsesOf(it) >= 1 || (it.lookups || 1) >= 2);
    default: return words;
  }
}
function renderWalkHome() {
  if (walk && walk.list) { renderWalkStage(); return; }
  const kinds = [['due', '今天要練的字'], ['recent', '最近 7 天加入的'], ['learning', '新字＋學習中'], ['hard', '常忘、查過很多次的'], ['all', '全部單字']];
  const sel = (walk && walk.kind) || 'due';
  $('#walk').innerHTML = `
    <div class="card">
      <p style="margin-top:0">把手機放口袋、戴上耳機。App 會念<b>英文</b> → <b>停幾秒讓你自己想</b> → 念<b>中文</b>${S.settings.walkSentence ? ' → 念你記下的<b>台詞</b>' : ''}。</p>
      <div class="field"><label>要聽哪些字</label><select id="walkkind">${kinds.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}（${walkPool(v).length}）</option>`).join('')}</select></div>
      <div class="field"><label>想的時間：<span id="pausev">${S.settings.walkPause}</span> 秒</label><input type="range" id="walkpause" min="1" max="8" step="1" value="${S.settings.walkPause}" style="width:100%"></div>
      <button class="btn block" id="walkstart">▶︎ 開始</button>
    </div>
    <div class="card how">
      <b>小提醒</b>
      <ol>
        <li>iPhone 的網頁 App <b>鎖螢幕後會停止念</b>。播放時 App 會盡量讓螢幕保持亮著，可以把亮度調低再放進口袋。</li>
        <li>聽到不熟的字，按大大的「<b>這個不熟</b>」，它會被排進今天的複習卡片。</li>
        <li>走路背是幫你「多接觸」，真正確認記住要靠「複習」裡的回想測驗。</li>
      </ol>
    </div>`;
  $('#walkpause').oninput = e => { S.settings.walkPause = +e.target.value; $('#pausev').textContent = e.target.value; save(); };
  $('#walkstart').onclick = () => {
    const kind = $('#walkkind').value;
    const list = shuffle(walkPool(kind).map(it => it.word));
    if (!list.length) { toast('這個範圍沒有單字'); return; }
    walk = { kind, list, i: 0, playing: false, token: 0, forgot: new Set() };
    renderWalkStage();
    walkPlay(); // 必須在點擊當下開始念，iOS 才允許語音
  };
}
function renderWalkStage() {
  const w = walk.list[walk.i], it = S.words[w];
  $('#walk').innerHTML = `
    <div class="muted" style="text-align:center">${walk.i + 1} / ${walk.list.length}</div>
    <div class="walk-stage">
      <div class="ww" id="ww">${esc(w)}</div>
      <div class="wz" id="wz"></div>
      <div class="wc" id="wc"></div>
    </div>
    <div class="walk-ctrl">
      <button id="wprev" aria-label="上一個">⏮</button>
      <button class="play" id="wplay" aria-label="播放/暫停">${walk.playing ? '⏸' : '▶︎'}</button>
      <button id="wnext" aria-label="下一個">⏭</button>
    </div>
    <button class="forgot ${walk.forgot.has(w) ? 'done' : ''}" id="wforgot">${walk.forgot.has(w) ? '✓ 已排進複習' : '這個不熟'}</button>
    <button class="btn block plain" style="margin-top:12px" id="wend">結束</button>`;
  $('#wplay').onclick = () => walk.playing ? walkPause() : walkPlay();
  $('#wprev').onclick = () => { walk.i = (walk.i - 1 + walk.list.length) % walk.list.length; walkRestart(); };
  $('#wnext').onclick = () => { walk.i = (walk.i + 1) % walk.list.length; walkRestart(); };
  $('#wforgot').onclick = () => walkForgot(w);
  $('#wend').onclick = () => { walkStop(); walk = null; renderWalkHome(); };
  if (it && !walk.playing) { $('#wz').textContent = meaningOf(it); }
}
function walkForgot(w) {
  const it = S.words[w]; if (!it || walk.forgot.has(w)) return;
  walk.forgot.add(w);
  // 排進今天的複習：已在長期複習的卡，提前到現在
  for (const c of Object.values(it.cards)) if (c.state === 'review' && c.due > now()) c.due = now();
  it.walkFlags = (it.walkFlags || 0) + 1;
  touch(it);
  save(); updateBadge();
  const b = $('#wforgot'); if (b) { b.classList.add('done'); b.textContent = '✓ 已排進複習'; }
}
async function requestWake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => wakeLock = null); } } catch { }
}
function releaseWake() { try { wakeLock && wakeLock.release(); } catch { } wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && walk && walk.playing) requestWake(); });
const sleep = (ms, tok) => new Promise(r => setTimeout(() => r(walk && walk.token === tok), ms));
function walkPlay() { walk.playing = true; requestWake(); walkLoop(); const b = $('#wplay'); if (b) b.textContent = '⏸'; }
function walkPause() { walk.playing = false; walk.token++; speechSynthesis.cancel(); releaseWake(); const b = $('#wplay'); if (b) b.textContent = '▶︎'; }
function walkStop() { if (walk) { walk.playing = false; walk.token++; } if ('speechSynthesis' in window) speechSynthesis.cancel(); releaseWake(); }
function walkRestart() { const was = walk.playing; walk.token++; speechSynthesis.cancel(); renderWalkStage(); if (was) { walk.playing = true; walkLoop(); } }
async function walkLoop() {
  const tok = ++walk.token;
  while (walk && walk.playing && walk.token === tok) {
    const w = walk.list[walk.i], it = S.words[w];
    if (!it) { walk.i = (walk.i + 1) % walk.list.length; continue; }
    renderWalkStage();
    const ctx = it.contexts.find(c => c.sentence);
    $('#wz').textContent = ''; $('#wc').textContent = '想想看…';
    await speak(w, 'en'); if (walk?.token !== tok) return;
    if (!(await sleep(700, tok))) return;
    await speak(w, 'en', Math.max(0.5, S.settings.rate - 0.2)); if (walk?.token !== tok) return;
    if (!(await sleep(S.settings.walkPause * 1000, tok))) return;
    const zh = meaningOf(it);
    $('#wz').textContent = zh; $('#wc').textContent = '';
    if (S.settings.walkZh) { await speak(zh, 'zh', 1.0); if (walk?.token !== tok) return; }
    if (S.settings.walkSentence && ctx) {
      $('#wc').innerHTML = highlight(ctx.sentence, w);
      if (!(await sleep(500, tok))) return;
      await speak(ctx.sentence, 'en'); if (walk?.token !== tok) return;
    }
    if (!(await sleep(1500, tok))) return;
    walk.i++;
    if (walk.i >= walk.list.length) { walk.i = 0; shuffle(walk.list); toast('一輪聽完了，重新洗牌再來一次'); }
  }
}

/* ---------- 設定 ---------- */
function renderSettings() {
  const st = S.settings;
  const enV = VOICES.filter(v => /^en/i.test(v.lang)), zhV = VOICES.filter(v => /^zh/i.test(v.lang));
  const vopts = (list, cur) => `<option value="">自動</option>` + list.map(v => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === cur ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('');
  const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#settings').innerHTML = `
    ${isStandalone ? '' : `<div class="card how"><b>加入主畫面（iPhone）</b><ol><li>用 <b>Safari</b> 打開這個網址</li><li>點下方的「分享」按鈕 <span style="font-size:18px">⎋</span></li><li>選「<b>加入主畫面</b>」</li></ol>之後從主畫面圖示打開，就像一般 App，也可以離線查字。</div>`}
    <div class="set-h">雲端同步（電腦 ↔ 手機）</div>
    <div class="set-group">
      ${S.sync && S.sync.gistId ? `
        <div class="set-row"><label>已連接 GitHub<small id="sync-status"></small></label><button class="btn ghost" id="s-sync" style="padding:6px 12px">立即同步</button></div>
        <div class="set-row"><label>中斷連接<small>只會移除這台裝置上的金鑰，雲端資料保留</small></label><button class="btn danger" id="s-unsync" style="padding:6px 12px">中斷</button></div>`
      : `<div class="how" style="padding:12px 0">
          單字冊會存一份到你 GitHub 帳號裡的<b>私人</b>檔案（Gist），電腦和手機各連一次就會自動同步。
          <ol>
            <li>打開 <a class="link" href="https://github.com/settings/tokens/new?scopes=gist&description=%E5%96%AE%E5%AD%97%E5%86%8A%E5%90%8C%E6%AD%A5" target="_blank" rel="noopener">GitHub 產生金鑰頁面</a>（已幫你勾好 <b>gist</b> 權限）</li>
            <li>Expiration 選 <b>No expiration</b>（或你想要的期限），按最下面 <b>Generate token</b></li>
            <li>複製 ghp_ 開頭的金鑰，貼到下面。<b>電腦和手機都要各貼一次</b></li>
          </ol>
          <span class="muted">金鑰只存在這台裝置，不會出現在備份檔裡。這把金鑰只能讀寫 Gist，不能動你的程式碼。</span>
        </div>
        <div class="set-row"><input type="password" id="s-token" placeholder="貼上金鑰 ghp_…" style="flex:1;border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:8px 10px;font-size:15px" autocomplete="off"><button class="btn" id="s-connect" style="padding:8px 14px">連接</button></div>`}
    </div>
    ${matchMedia('(pointer: fine)').matches ? `
    <div class="set-h">一鍵收藏書籤（電腦）</div>
    <div class="set-group"><div class="how" style="padding:12px 0">
      把這個按鈕<b>拖曳到 Chrome 的書籤列</b>：<br>
      <a class="btn ghost" id="s-bm" style="margin:10px 0;cursor:grab" href="#">⭐ 收藏字幕</a><br>
      <b>Netflix</b>（開著雙語字幕）：遇到不懂的字按一下書籤，影片會暫停，這裡跳出整句英文＋中文字幕，劇名、集數、時間點都自動記好。<br>
      <b>YouTube</b>：打開 CC 字幕後按書籤，抓當下那句字幕和時間點。<br>
      <b>其他網頁</b>：先選取一句英文（或只選一個字，會自動抓整句）再按書籤，網頁標題和網址會一起記下，之後可以回到原文。
      <div class="muted">書籤列沒出現的話，按 Ctrl+Shift+B 打開。</div>
    </div></div>` : ''}
    <div class="set-h">複習</div>
    <div class="set-group">
      <div class="set-row"><label>每天新卡片上限<small>每種卡各算一次。看劇查很多字時，可以避免複習量爆炸</small></label><input type="number" id="s-new" min="1" max="100" value="${st.newPerDay}"></div>
      <div class="set-row"><label>目標記憶率<small>越高 → 複習越頻繁、越不容易忘</small></label>
        <select id="s-ret">${[[0.85, '85%（輕鬆）'], [0.9, '90%（建議）'], [0.95, '95%（考前衝刺）']].map(([v, l]) => `<option value="${v}" ${st.retention === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="set-row"><label>查字時自動發音</label><input type="checkbox" id="s-auto" ${st.autoSpeak ? 'checked' : ''}></div>
    </div>
    <div class="set-h">語音</div>
    <div class="set-group">
      <div class="set-row"><label>語速 <span id="ratev">${st.rate.toFixed(1)}</span></label><input type="range" id="s-rate" min="0.5" max="1.2" step="0.1" value="${st.rate}"></div>
      <div class="set-row"><label>英文聲音</label><select id="s-env">${vopts(enV, st.enVoice)}</select></div>
      <div class="set-row"><label>中文聲音</label><select id="s-zhv">${vopts(zhV, st.zhVoice)}</select></div>
      <div class="set-row"><label>走路背：念中文意思</label><input type="checkbox" id="s-wzh" ${st.walkZh ? 'checked' : ''}></div>
      <div class="set-row"><label>走路背：念記下的台詞</label><input type="checkbox" id="s-wsent" ${st.walkSentence ? 'checked' : ''}></div>
      <div class="set-row"><label>試聽</label><button class="btn ghost" id="s-test" style="padding:6px 12px">▶︎ 試聽</button></div>
    </div>
    <div class="set-h">外觀</div>
    <div class="set-group">
      <div class="set-row"><label>主題</label><select id="s-theme">${[['auto', '跟隨系統'], ['light', '淺色'], ['dark', '深色']].map(([v, l]) => `<option value="${v}" ${st.theme === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="set-h">備份</div>
    <div class="set-group">
      <div class="set-row"><label>匯出備份<small>資料只存在這支手機。換手機前、或每隔一陣子，記得匯出一份</small></label><button class="btn ghost" id="s-exp" style="padding:6px 12px">匯出</button></div>
      <div class="set-row"><label>從備份還原<small>會和現有單字合併</small></label><button class="btn ghost" id="s-imp" style="padding:6px 12px">匯入</button></div>
      <div class="set-row"><label>匯出成表格 (CSV)<small>可以用 Excel／Numbers 打開</small></label><button class="btn ghost" id="s-csv" style="padding:6px 12px">CSV</button></div>
    </div>
    <input type="file" id="s-file" accept=".json,application/json" hidden>
    <p class="muted" style="text-align:center">字典資料：ECDICT（MIT 授權）・英英解釋：Free Dictionary API<br>單字 ${Object.keys(S.words).length} 個・離線字典 ${KEYS ? KEYS.length.toLocaleString() : '載入中'} 筆</p>`;
  const set = (k, v) => { st[k] = v; save(); };
  const bm = $('#s-bm');
  if (bm) { bm.setAttribute('href', bookmarkletCode()); bm.onclick = e => { e.preventDefault(); toast('請用拖曳的，把它拉到書籤列'); }; }
  if ($('#s-connect')) $('#s-connect').onclick = () => { $('#s-connect').disabled = true; $('#s-connect').textContent = '連接中…'; syncConnect($('#s-token').value); };
  if ($('#s-sync')) { $('#s-sync').onclick = () => syncNow(true); renderSyncStatus(); }
  if ($('#s-unsync')) $('#s-unsync').onclick = () => { if (confirm('確定要中斷這台裝置的同步嗎？')) { S.sync = null; save(); renderSettings(); } };
  $('#s-new').onchange = e => set('newPerDay', Math.max(1, Math.min(100, +e.target.value || 15)));
  $('#s-ret').onchange = e => set('retention', +e.target.value);
  $('#s-auto').onchange = e => set('autoSpeak', e.target.checked);
  $('#s-rate').oninput = e => { set('rate', +e.target.value); $('#ratev').textContent = (+e.target.value).toFixed(1); };
  $('#s-env').onchange = e => set('enVoice', e.target.value);
  $('#s-zhv').onchange = e => set('zhVoice', e.target.value);
  $('#s-wzh').onchange = e => set('walkZh', e.target.checked);
  $('#s-wsent').onchange = e => set('walkSentence', e.target.checked);
  $('#s-test').onclick = async () => { speechSynthesis.cancel(); await speak("I can't figure out what he's talking about.", 'en'); await speak('我搞不懂他在說什麼。', 'zh', 1); };
  $('#s-theme').onchange = e => { set('theme', e.target.value); applyTheme(); };
  $('#s-exp').onclick = exportJSON;
  $('#s-csv').onclick = exportCSV;
  $('#s-imp').onclick = () => $('#s-file').click();
  $('#s-file').onchange = importJSON;
}
function applyTheme() {
  const t = S.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
}
async function shareOrDownload(name, text, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportJSON() {
  const data = JSON.stringify({ app: 'wordbook', version: 1, exported: new Date().toISOString(), ...S, sync: undefined });
  shareOrDownload(`單字冊備份-${dayKey(now())}.json`, data, 'application/json');
}
function exportCSV() {
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['單字', '音標', '中文', '狀態', '影集', '集數', '原句', '筆記', '查詢次數', '忘記次數', '加入日期']];
  for (const it of Object.values(S.words)) {
    const c = it.contexts[0] || {};
    rows.push([it.word, it.phon, it.zh.replace(/\n/g, ' '), STATUS_ZH[wordStatus(it)], c.source, c.ep, c.sentence, it.note, it.lookups || 1, lapsesOf(it), new Date(it.added).toLocaleDateString('zh-TW')]);
  }
  shareOrDownload(`單字冊-${dayKey(now())}.csv`, '﻿' + rows.map(r => r.map(q).join(',')).join('\n'), 'text/csv');
}
function importJSON(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d.words) throw new Error('不是單字冊的備份檔');
      let added = 0, kept = 0;
      for (const [w, it] of Object.entries(d.words)) {
        const cur = S.words[w];
        if (!cur) { S.words[w] = it; added++; continue; }
        // 兩邊都有：保留複習次數比較多的那份，合併出處
        const reps = x => Object.values(x.cards).reduce((a, c) => a + c.reps, 0);
        const base = reps(it) > reps(cur) ? it : cur, other = base === it ? cur : it;
        const seen = new Set(base.contexts.map(c => c.sentence + c.source));
        for (const c of other.contexts) if (!seen.has(c.sentence + c.source)) base.contexts.push(c);
        S.words[w] = base; kept++;
      }
      if (Array.isArray(d.log)) { const seen = new Set(S.log.map(l => l.t + l.w + l.k)); for (const l of d.log) if (!seen.has(l.t + l.w + l.k)) S.log.push(l); S.log.sort((a, b) => a.t - b.t); }
      save(); updateBadge(); toast(`還原完成：新增 ${added} 個、合併 ${kept} 個`); renderSettings();
    } catch (err) { toast('匯入失敗：' + err.message); }
  };
  r.readAsText(f);
  e.target.value = '';
}

/* ---------- Netflix 一鍵收藏（書籤小工具） ---------- */
// 在 Netflix 播放頁按書籤：讀出雙語字幕擴充功能畫的英／中字幕、劇名、秒數，傳到這裡
// 書籤本體：在 Netflix／YouTube／任何網頁上執行。不能用到外面的變數（會被轉成文字塞進書籤）
function captureFn(APP) {
  var txt = function (s) { return ((document.querySelector(s) || {}).innerText || '').trim(); };
  var v = document.querySelector('video');
  var send = function (d) { window.open(APP + '#cap=' + encodeURIComponent(JSON.stringify(d)), 'wordbook'); };
  var host = location.hostname;
  var sel = String(window.getSelection() || '').trim();
  /* Netflix：讀雙語字幕擴充功能的英／中字幕 */
  if (/netflix\.com$/.test(host) && /\/watch\//.test(location.pathname) && !sel) {
    var en = txt('#mainSub'), zh = txt('#secondSub');
    if (!en) en = txt('.player-timedtext');
    if (!en) { alert('現在畫面上沒有字幕'); return; }
    var m = location.pathname.match(/watch\/(\d+)/), src = '', ep = '';
    try {
      var id = +m[1], vd = netflix.appContext.state.playerApp.getState().videoPlayer.videoMetadata[id]._metadataObject.video;
      src = vd.title || '';
      (vd.seasons || []).forEach(function (s) { (s.episodes || []).forEach(function (e) { if ((e.id || e.episodeId) == id) ep = 'S' + String(s.seq).padStart(2, '0') + 'E' + String(e.seq).padStart(2, '0'); }); });
    } catch (x) { }
    if (v) v.pause();
    send({ en: en, zh: zh, src: src, ep: ep, nf: m ? m[1] : '', t: v ? Math.floor(v.currentTime) : 0 });
    return;
  }
  /* YouTube：讀 CC 字幕 */
  if (/(^|\.)youtube\.com$/.test(host) && !sel) {
    var segs = Array.prototype.map.call(document.querySelectorAll('.ytp-caption-segment'), function (e) { return e.innerText.trim(); });
    var cap = segs.join(' ').trim();
    if (!cap) { alert('現在畫面上沒有字幕（請先打開 YouTube 的 CC 字幕），或先選取一段文字'); return; }
    var vid = new URLSearchParams(location.search).get('v'), t = v ? Math.floor(v.currentTime) : 0;
    if (v) v.pause();
    send({ en: cap, src: txt('h1.ytd-watch-metadata') || document.title.replace(/\s*-\s*YouTube$/, ''), url: vid ? 'https://www.youtube.com/watch?v=' + vid : location.href.split('#')[0], t: t });
    return;
  }
  /* 其他網頁：用選取的文字；只選一個字時，抓它所在的整句 */
  if (!sel) { alert('請先選取一句英文（或一個字）再按書籤'); return; }
  var text = sel.replace(/\s+/g, ' '), hl = '';
  if (text.split(' ').length <= 3) {
    hl = text;
    try {
      var r = window.getSelection().getRangeAt(0);
      var el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
      el = el.closest('p,li,td,th,blockquote,dd,dt,figcaption,h1,h2,h3,h4,h5,h6') || el.parentElement || el;
      var full = (el.innerText || '').replace(/\s+/g, ' ');
      var i = full.indexOf(text);
      if (i >= 0) {
        var pre = full.slice(0, i), a = 0, re = /[.!?。！？]["”’)\]]*\s+/g, mm;
        while ((mm = re.exec(pre))) a = mm.index + mm[0].length;
        var post = full.slice(i + text.length), k = post.search(/[.!?。！？]["”’)\]]*(\s|$)/);
        var b = k < 0 ? full.length : i + text.length + k + (post.slice(k).match(/^[.!?。！？]["”’)\]]*/) || [''])[0].length;
        var s2 = full.slice(a, b).trim();
        if (s2.length <= 500) text = s2;
      }
    } catch (x) { }
  }
  var title = document.title.replace(/\s*[|\-–—:]\s*[^|\-–—:]{1,30}$/, '').trim() || host;
  send({ en: text.slice(0, 600), hl: hl, src: title.slice(0, 60), url: location.href.split('#')[0] });
}
function bookmarkletCode() {
  const app = location.origin + location.pathname;
  return 'javascript:' + encodeURIComponent('(' + captureFn.toString() + ')(' + JSON.stringify(app) + ')');
}
function parseNfTitle(ti) {
  if (!ti) return {};
  const m = ti.match(/^(.*?)\s*(第\s*\d+\s*季\s*)?第\s*(\d+)\s*集/);
  if (!m) return { src: ti.split(/[：:]/)[0].trim() };
  const season = m[2] ? m[2].match(/\d+/)[0] : '';
  return { src: m[1].trim(), ep: (season ? 'S' + season.padStart(2, '0') : '') + 'E' + m[3].padStart(2, '0') };
}
function handleCapture() {
  const h = location.hash;
  if (!h.startsWith('#cap=')) return;
  history.replaceState(null, '', location.pathname);
  let d; try { d = JSON.parse(decodeURIComponent(h.slice(5))); } catch { return; }
  if (!d.en) return;
  S.nfTitles = S.nfTitles || {};
  let meta = d.src ? { src: d.src, ep: d.ep || '' } : parseNfTitle(d.ti);
  if (d.nf) { if (meta.src) S.nfTitles[d.nf] = meta; else meta = S.nfTitles[d.nf] || {}; save(); }
  show('search');
  setSentence(d.en + '\n' + (d.zh || ''));
  if (!curSentence) return;
  const url = /^https?:\/\//.test(d.url || '') ? d.url : '';
  Object.assign(curSentence, { src: meta.src || '', ep: meta.ep || '', nf: /^\d+$/.test(d.nf || '') ? d.nf : '', url, t: +d.t || 0 });
  // 在網頁上只選了一個字：直接幫你查那個字
  if (d.hl) {
    const first = norm(d.hl).split(' ')[0];
    const idx = curSentence.tokens.findIndex(tk => norm(tk.replace(/’/g, "'")) === first);
    if (idx >= 0) tapToken(idx); else doLookup(d.hl, { keepSentence: true });
  }
  window.focus();
}
window.addEventListener('hashchange', handleCapture);

/* ---------- 雲端同步（GitHub 私人 Gist） ---------- */
const SYNC_FILE = 'wordbook.json';
let syncing = false, syncTimer = null;
function scheduleSync(delay = 8000) {
  if (!S.sync || !S.sync.gistId) return;
  clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(), delay);
}
async function gh(path, opts = {}) {
  const r = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + S.sync.token, Accept: 'application/vnd.github+json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }
  });
  if (r.status === 401) throw new Error('金鑰無效或已過期，請重新連接');
  if (r.status === 403 || r.status === 404) throw new Error('金鑰沒有 Gist 權限，或同步檔被刪除了');
  if (!r.ok) throw new Error('GitHub 回應錯誤 ' + r.status);
  return r.json();
}
function syncPayload() {
  const words = {};
  for (const [w, it] of Object.entries(S.words)) { const { en, ...rest } = it; words[w] = rest; } // 英英解釋可以重抓，不同步以節省空間
  return { app: 'wordbook', v: 2, at: now(), words, deleted: S.deleted, log: S.log, daily: S.daily, nfTitles: S.nfTitles || {} };
}
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0; return h + ':' + s.length; }
function ctxKey(c) { return (c.sentence || '') + '|' + (c.source || '') + '|' + (c.ep || ''); }
function mergeContexts(a, b) {
  const seen = new Set(a.map(ctxKey)), out = a.slice();
  for (const c of b || []) if (!seen.has(ctxKey(c))) { out.push(c); seen.add(ctxKey(c)); }
  return out.sort((x, y) => (x.at || 0) - (y.at || 0));
}
// 合併規則：同一個字取最後修改的那份（出處兩邊聯集）；刪除比修改晚才算數
function mergeRemote(r) {
  let changed = 0;
  for (const [w, t] of Object.entries(r.deleted || {})) if (t > (S.deleted[w] || 0)) S.deleted[w] = t;
  for (const [w, rw] of Object.entries(r.words || {})) {
    const lw = S.words[w];
    const rmod = rw.mod || rw.added || 0;
    if (!lw) { if (rmod > (S.deleted[w] || 0)) { S.words[w] = rw; changed++; } continue; }
    const lmod = lw.mod || lw.added || 0;
    if (rmod > lmod) { S.words[w] = { ...rw, en: lw.en, contexts: mergeContexts(rw.contexts || [], lw.contexts) }; changed++; }
    else lw.contexts = mergeContexts(lw.contexts, rw.contexts);
  }
  for (const [w, t] of Object.entries(S.deleted)) { const it = S.words[w]; if (it && t > (it.mod || it.added || 0)) { delete S.words[w]; changed++; } }
  if (Array.isArray(r.log)) {
    const seen = new Set(S.log.map(l => l.t + l.w + l.k));
    for (const l of r.log) if (!seen.has(l.t + l.w + l.k)) S.log.push(l);
    S.log.sort((a, b) => a.t - b.t);
  }
  for (const [k, v] of Object.entries(r.daily || {})) {
    const cur = S.daily[k] || (S.daily[k] = { newRec: 0, newExtra: 0, reviews: 0 });
    for (const f of ['newRec', 'newExtra', 'reviews']) cur[f] = Math.max(cur[f] || 0, v[f] || 0);
  }
  S.nfTitles = { ...(r.nfTitles || {}), ...(S.nfTitles || {}) };
  return changed;
}
async function syncNow(manual) {
  if (!S.sync || !S.sync.token || !S.sync.gistId || syncing) return;
  if (!navigator.onLine) { if (manual) toast('離線中，連上網路後會自動同步'); return; }
  syncing = true; renderSyncStatus();
  try {
    const g = await gh('/gists/' + S.sync.gistId);
    const f = g.files[SYNC_FILE];
    let txt = f && f.content;
    if (f && f.truncated) txt = await (await fetch(f.raw_url)).text();
    const changed = txt ? mergeRemote(JSON.parse(txt)) : 0;
    const payload = syncPayload();
    const h = hashStr(JSON.stringify({ ...payload, at: 0 }));
    if (h !== S.sync.lastHash || changed) { // 沒有變動就不上傳
      await gh('/gists/' + S.sync.gistId, { method: 'PATCH', body: JSON.stringify({ files: { [SYNC_FILE]: { content: JSON.stringify(payload) } } }) });
      S.sync.lastHash = h;
    }
    S.sync.last = now(); S.sync.error = '';
    save(); updateBadge();
    if (changed) { if (currentView === 'book') renderBook(); if (currentView === 'review' && !session) renderReviewHome(); }
    if (manual) toast(changed ? `同步完成，更新了 ${changed} 個字` : '同步完成');
  } catch (e) {
    S.sync.error = e.message; save();
    if (manual) toast('同步失敗：' + e.message);
  } finally { syncing = false; renderSyncStatus(); }
}
async function syncConnect(token) {
  token = token.trim();
  if (!token) return;
  S.sync = { token };
  try {
    let id = null;
    for (let page = 1; page <= 10 && !id; page++) {
      const list = await gh('/gists?per_page=100&page=' + page);
      if (!list.length) break;
      const hit = list.find(x => x.files && x.files[SYNC_FILE]);
      if (hit) id = hit.id;
    }
    if (!id) {
      const g = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: '我的單字冊 同步資料（請勿手動修改）', public: false, files: { [SYNC_FILE]: { content: JSON.stringify(syncPayload()) } } }) });
      id = g.id;
    }
    S.sync.gistId = id; save();
    await syncNow(true);
  } catch (e) { S.sync = null; save(); toast('連接失敗：' + e.message); }
  renderSettings();
}
function renderSyncStatus() {
  const el = $('#sync-status'); if (!el || !S.sync) return;
  el.textContent = syncing ? '同步中…' : S.sync.error ? '⚠︎ ' + S.sync.error : S.sync.last ? '上次同步：' + (now() - S.sync.last < 60e3 ? '剛剛' : FSRS.fmtDelay(now() - S.sync.last) + '前') : '尚未同步';
}
document.addEventListener('visibilitychange', () => {
  if (!S.sync || !S.sync.gistId) return;
  if (document.visibilityState === 'hidden') { clearTimeout(syncTimer); syncNow(); }
  else syncNow();
});

/* ---------- 啟動 ---------- */
(async function init() {
  try {
    await DB.open();
    const saved = await DB.get('state');
    if (saved) { S = { ...S, ...saved, settings: { ...DEFAULT_SETTINGS, ...saved.settings } }; }
  } catch (e) { toast('無法讀取資料：' + e.message); }
  applyTheme();
  updateBadge();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
  $('#search-empty').hidden = false;
  try {
    await loadDict();
    // 字典更新後，已收藏的字也換成新版解釋
    for (const it of Object.values(S.words)) { const e = DICT.e[it.word]; if (e && e[1] && it.zh !== e[1]) it.zh = e[1]; }
    save();
    renderRecent(); if (qEl.value) renderSuggest(); handleCapture(); }
  catch { toast('字典載入失敗，請連上網路後重開'); }
  updateBadge();
  syncNow();
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 5 * 60e3);
  setInterval(updateBadge, 60e3);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });
})();
