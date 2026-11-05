// 間隔重複排程：FSRS（Free Spaced Repetition Scheduler, v4.5 預設參數）
// 每張卡記錄「穩定度 S」（記憶能撐幾天）與「難度 D」（1–10），
// 依你每次的回想結果更新，算出記憶衰退到目標保留率前的最佳複習時間。
// 新字與忘掉的字，要先在短間隔（分鐘級）內成功回想，才進入長期排程。
(function () {
  const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
  const DECAY = -0.5, FACTOR = 19 / 81;
  const MIN = 60e3, DAY = 864e5;
  const LEARN_STEPS = [1, 10];     // 新字：1 分鐘、10 分鐘後再考
  const RELEARN_STEPS = [10];      // 忘掉的字：10 分鐘後再考
  const FIRST_MAX_DAYS = 4;        // 剛學會的字，第一次間隔最多 4 天，不會一次就放很久
  const MAX_DAYS = 365;

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const retr = (t, s) => Math.pow(1 + FACTOR * t / s, DECAY);
  const ivlDays = (s, r) => clamp(Math.round(s / FACTOR * (Math.pow(r, 1 / DECAY) - 1)), 1, MAX_DAYS);
  const d0 = g => clamp(W[4] - (g - 3) * W[5], 1, 10);
  const nextD = (d, g) => clamp(W[7] * d0(4) + (1 - W[7]) * (d - W[6] * (g - 3)), 1, 10);
  const sRecall = (d, s, r, g) => s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1));
  const sForget = (d, s, r) => Math.min(s, W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]));

  function newCard() {
    return { state: 'new', step: 0, due: 0, s: 0, d: 0, reps: 0, lapses: 0, last: 0 };
  }

  // g: 1 忘了 / 2 困難 / 3 記得 / 4 簡單；回傳新的卡片狀態（不改原物件）
  function review(card, g, now, retention) {
    const c = Object.assign({}, card);
    retention = retention || 0.9;
    c.reps++;
    const graduate = (first) => {
      let days = ivlDays(c.s, retention);
      if (first) days = Math.min(days, g === 4 ? FIRST_MAX_DAYS : Math.max(1, Math.min(days, FIRST_MAX_DAYS - 1)));
      c.state = 'review'; c.step = 0; c.due = now + days * DAY; c.ivl = days;
    };

    if (c.state === 'new') {
      c.d = d0(g); c.s = W[g - 1]; c.last = now;
      if (g === 4) { graduate(true); return c; }
      c.state = 'learning';
      c.step = g === 3 ? 1 : 0;
      const m = g === 2 ? (LEARN_STEPS[0] + LEARN_STEPS[1]) / 2 : LEARN_STEPS[c.step];
      c.due = now + m * MIN; c.ivl = 0;
      return c;
    }

    if (c.state === 'learning' || c.state === 'relearning') {
      const steps = c.state === 'learning' ? LEARN_STEPS : RELEARN_STEPS;
      const first = c.state === 'learning';
      c.d = nextD(c.d, g);
      c.last = now;
      if (g === 1) { c.step = 0; c.due = now + steps[0] * MIN; return c; }
      if (g === 2) { c.due = now + steps[Math.min(c.step, steps.length - 1)] * 1.5 * MIN; return c; }
      if (g === 4 || c.step + 1 >= steps.length) { graduate(first); return c; }
      c.step++; c.due = now + steps[c.step] * MIN;
      return c;
    }

    // review
    const t = Math.max(0, (now - c.last) / DAY);
    const r = retr(t, c.s);
    c.d = nextD(c.d, g);
    c.last = now;
    if (g === 1) {
      c.s = sForget(c.d, c.s, r);
      c.lapses++;
      c.state = 'relearning'; c.step = 0; c.due = now + RELEARN_STEPS[0] * MIN; c.ivl = 0;
      return c;
    }
    c.s = sRecall(c.d, card.s, r, g);
    let days = ivlDays(c.s, retention);
    const prev = card.ivl || 1;
    if (g === 2) days = Math.max(1, Math.min(days, Math.round(prev * 1.2)));
    if (g >= 3) days = Math.max(days, prev + 1);
    c.state = 'review'; c.due = now + days * DAY; c.ivl = days;
    return c;
  }

  function fmtDelay(ms) {
    if (ms < 60 * MIN) return Math.max(1, Math.round(ms / MIN)) + ' 分';
    if (ms < DAY) return Math.round(ms / 36e5) + ' 小時';
    const d = Math.round(ms / DAY);
    if (d < 31) return d + ' 天';
    if (d < 365) return (d / 30).toFixed(d < 60 ? 1 : 0).replace('.0', '') + ' 個月';
    return (d / 365).toFixed(1).replace('.0', '') + ' 年';
  }

  // 目前記得的機率（給統計用）
  function recall(card, now) {
    if (card.state === 'new' || !card.s) return 0;
    return retr(Math.max(0, (now - card.last) / DAY), card.s);
  }

  window.FSRS = { newCard, review, fmtDelay, recall, DAY, MIN };
})();
