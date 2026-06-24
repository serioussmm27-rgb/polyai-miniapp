/* ============================================================
   Свайп-Прогноз — логика игры (Telegram Mini App).

   Идея: показываем вопрос рынка предсказаний, игрок свайпает
   «Сбудется» (вправо) или «Не сбудется» (влево), НЕ видя вероятности.
   Затем раскрываем, во что верит рынок. Совпал с рынком — очки и серия,
   ошибся — теряешь жизнь. Данные берём с публичного Gamma API Polymarket,
   а если сети нет — из встроенного запасного набора вопросов.
   ============================================================ */

(function () {
  "use strict";

  // --- Telegram WebApp (может отсутствовать, если открыто в браузере) ---
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  // ---------- Параметры игры ----------
  const START_LIVES = 3;
  const SWIPE_THRESHOLD = 90;      // px — порог уверенного свайпа
  const BASE_POINTS = 10;          // очки за угаданное направление
  const STREAK_BONUS_CAP = 20;     // потолок бонуса за серию
  const BRAVE_BONUS = 5;           // бонус за угаданный «спорный» рынок (45–55%)
  const PRICE_MIN = 0.12;          // отсекаем слишком очевидные рынки
  const PRICE_MAX = 0.88;

  // ---------- Состояние ----------
  const state = {
    deck: [],          // оставшиеся карточки
    index: 0,
    score: 0,
    streak: 0,
    bestStreak: 0,
    lives: START_LIVES,
    correct: 0,
    total: 0,
    busy: false,       // блок ввода во время анимаций/вердикта
  };

  // ---------- Элементы ----------
  const el = {
    screens: {
      start: document.getElementById("screen-start"),
      game: document.getElementById("screen-game"),
      over: document.getElementById("screen-over"),
    },
    startBest: document.getElementById("start-best"),
    loadingHint: document.getElementById("loading-hint"),
    btnPlay: document.getElementById("btn-play"),
    deck: document.getElementById("deck"),
    hudScore: document.getElementById("hud-score"),
    hudStreak: document.getElementById("hud-streak"),
    hudLives: document.getElementById("hud-lives"),
    verdict: document.getElementById("verdict"),
    verdictEmoji: document.getElementById("verdict-emoji"),
    verdictTitle: document.getElementById("verdict-title"),
    verdictMarket: document.getElementById("verdict-market"),
    verdictPoints: document.getElementById("verdict-points"),
    btnNo: document.getElementById("btn-no"),
    btnYes: document.getElementById("btn-yes"),
    btnSkip: document.getElementById("btn-skip"),
    resultEmoji: document.getElementById("result-emoji"),
    resultScore: document.getElementById("result-score"),
    resultNewbest: document.getElementById("result-newbest"),
    resultCorrect: document.getElementById("result-correct"),
    resultTotal: document.getElementById("result-total"),
    resultAcc: document.getElementById("result-acc"),
    resultBeststreak: document.getElementById("result-beststreak"),
    btnAgain: document.getElementById("btn-again"),
    btnShare: document.getElementById("btn-share"),
    btnClose: document.getElementById("btn-close"),
  };

  // ============================================================
  //  Запасной набор вопросов (если живые данные недоступны)
  //  p — вероятность «Да» по версии «рынка» (0..1).
  // ============================================================
  const FALLBACK = [
    { q: "Биткоин превысит $100 000 до конца года?", p: 0.58, cat: "Крипта" },
    { q: "ИИ-модель пройдёт строгий тест Тьюринга в этом году?", p: 0.22, cat: "Технологии" },
    { q: "Сборная Бразилии выиграет ЧМ-2026 по футболу?", p: 0.18, cat: "Спорт" },
    { q: "Цена на нефть Brent опустится ниже $60 в этом квартале?", p: 0.35, cat: "Экономика" },
    { q: "Apple выпустит складной iPhone в этом году?", p: 0.15, cat: "Технологии" },
    { q: "Эфириум обгонит биткоин по капитализации до конца года?", p: 0.08, cat: "Крипта" },
    { q: "Инфляция в США опустится ниже 2% к концу года?", p: 0.41, cat: "Экономика" },
    { q: "SpaceX отправит корабль Starship на орбиту в этом году?", p: 0.72, cat: "Космос" },
    { q: "Tesla продаст более 2 млн авто за год?", p: 0.46, cat: "Бизнес" },
    { q: "В этом году выйдет GTA VI?", p: 0.55, cat: "Игры" },
    { q: "Северное сияние увидят в Москве этой зимой?", p: 0.3, cat: "Природа" },
    { q: "Курс доллара опустится ниже 80 рублей в этом году?", p: 0.27, cat: "Экономика" },
    { q: "Новый рекорд температуры будет установлен этим летом?", p: 0.63, cat: "Климат" },
    { q: "Нобелевку по литературе получит писатель из Азии?", p: 0.33, cat: "Культура" },
    { q: "Золото обновит исторический максимум в этом году?", p: 0.6, cat: "Рынки" },
    { q: "Человечество объявит о контакте с внеземной жизнью в этом году?", p: 0.04, cat: "Наука" },
  ];

  // ============================================================
  //  Утилиты
  // ============================================================
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function lsGet(key, def) {
    try { const v = localStorage.getItem(key); return v === null ? def : v; }
    catch (e) { return def; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (e) { /* приватный режим */ }
  }

  function getBest() { return parseInt(lsGet("swipe_best", "0"), 10) || 0; }
  function setBest(v) { lsSet("swipe_best", v); }

  function haptic(kind) {
    if (!tg || !tg.HapticFeedback) return;
    try {
      if (kind === "light") tg.HapticFeedback.impactOccurred("light");
      else if (kind === "good") tg.HapticFeedback.notificationOccurred("success");
      else if (kind === "bad") tg.HapticFeedback.notificationOccurred("error");
    } catch (e) { /* не критично */ }
  }

  function fmtVolume(v) {
    if (!v || v < 1000) return "";
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(1) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return "$" + Math.round(v / 1e3) + "K";
    return "$" + Math.round(v);
  }

  function showScreen(name) {
    Object.values(el.screens).forEach((s) => s.classList.remove("is-active"));
    el.screens[name].classList.add("is-active");
  }

  // ============================================================
  //  Загрузка живых рынков с Polymarket (Gamma API)
  // ============================================================
  async function loadMarkets() {
    const params = new URLSearchParams({
      active: "true", closed: "false", archived: "false",
      limit: "80", order: "volume24hr", ascending: "false",
    });
    const url = "https://gamma-api.polymarket.com/markets?" + params.toString();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      const list = Array.isArray(data) ? data : (data.data || []);
      const cards = [];
      for (const raw of list) {
        const card = normalize(raw);
        if (card) cards.push(card);
      }
      if (cards.length >= 8) return shuffle(cards);
      throw new Error("слишком мало рынков");
    } catch (e) {
      clearTimeout(timer);
      console.warn("Не удалось загрузить рынки, использую запасной набор:", e.message);
      return null;
    }
  }

  function parseMaybeJson(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === "string") { try { return JSON.parse(v); } catch (e) { return null; } }
    return null;
  }

  function normalize(raw) {
    const outcomes = parseMaybeJson(raw.outcomes);
    const prices = parseMaybeJson(raw.outcomePrices);
    if (!outcomes || !prices || outcomes.length !== 2 || prices.length !== 2) return null;

    const pYes = parseFloat(prices[0]);
    if (!isFinite(pYes) || pYes < PRICE_MIN || pYes > PRICE_MAX) return null;

    const q = (raw.question || "").trim();
    if (q.length < 8) return null;

    const vol = parseFloat(raw.volume24hr || raw.volumeNum || raw.volume || 0);
    return {
      q: q,
      p: pYes,
      cat: (raw.category || "").trim() || "Прогноз",
      vol: fmtVolume(vol),
    };
  }

  // ============================================================
  //  Игровой цикл
  // ============================================================
  async function startGame() {
    el.btnPlay.disabled = true;
    el.loadingHint.textContent = "Загружаю свежие рынки…";

    let deck = await loadMarkets();
    if (!deck) {
      deck = shuffle(FALLBACK.map((x) => ({ ...x, vol: "" })));
      el.loadingHint.textContent = "Играем на встроенном наборе (нет сети).";
    }

    state.deck = deck;
    state.index = 0;
    state.score = 0;
    state.streak = 0;
    state.bestStreak = 0;
    state.lives = START_LIVES;
    state.correct = 0;
    state.total = 0;
    state.busy = false;

    el.btnPlay.disabled = false;
    updateHud();
    showScreen("game");
    if (tg && tg.BackButton) { try { tg.BackButton.hide(); } catch (e) {} }
    renderDeck();
  }

  function updateHud() {
    el.hudScore.textContent = state.score;
    el.hudStreak.textContent = state.streak;
    el.hudLives.textContent = state.lives > 0 ? "❤️".repeat(state.lives) : "💔";
  }

  // Текущая и следующая карточка (эффект стопки)
  function renderDeck() {
    el.deck.innerHTML = "";
    const cur = state.deck[state.index];
    const next = state.deck[state.index + 1];

    if (next) {
      const back = buildCard(next);
      back.style.transform = "scale(.94) translateY(10px)";
      back.style.opacity = "0.6";
      el.deck.appendChild(back);
    }
    if (cur) {
      const front = buildCard(cur);
      el.deck.appendChild(front);
      attachSwipe(front, cur);
    }
  }

  function buildCard(data) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      '<div class="card__top">' +
        '<span class="card__cat">' + escapeHtml(data.cat) + "</span>" +
        '<span class="card__vol">' + (data.vol ? "💧 " + data.vol : "") + "</span>" +
      "</div>" +
      '<div class="card__q">' + escapeHtml(data.q) + "</div>" +
      '<div class="card__foot">Свайпни: 👈 нет · да 👉</div>' +
      '<div class="stamp stamp--yes">ДА</div>' +
      '<div class="stamp stamp--no">НЕТ</div>';
    return card;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- Свайп-механика (pointer events) ----------
  function attachSwipe(card, data) {
    const stampYes = card.querySelector(".stamp--yes");
    const stampNo = card.querySelector(".stamp--no");
    let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;

    function onDown(e) {
      if (state.busy) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      card.setPointerCapture && card.setPointerCapture(e.pointerId);
      card.style.transition = "none";
    }
    function onMove(e) {
      if (!dragging) return;
      dx = e.clientX - startX;
      dy = e.clientY - startY;
      card.style.transform = "translate(" + dx + "px," + dy * 0.25 + "px) rotate(" + dx / 22 + "deg)";
      const k = Math.min(Math.abs(dx) / SWIPE_THRESHOLD, 1);
      stampYes.style.opacity = dx > 0 ? k : 0;
      stampNo.style.opacity = dx < 0 ? k : 0;
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      card.style.transition = "transform .3s ease, opacity .3s ease";
      if (dx > SWIPE_THRESHOLD) flyAway(card, 1, () => answer(true, data));
      else if (dx < -SWIPE_THRESHOLD) flyAway(card, -1, () => answer(false, data));
      else {
        card.style.transform = "";
        stampYes.style.opacity = 0;
        stampNo.style.opacity = 0;
      }
      dx = 0; dy = 0;
    }

    card.addEventListener("pointerdown", onDown);
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerup", onUp);
    card.addEventListener("pointercancel", onUp);
  }

  function flyAway(card, dir, done) {
    state.busy = true;
    haptic("light");
    card.style.transform =
      "translate(" + dir * window.innerWidth * 1.2 + "px,-40px) rotate(" + dir * 25 + "deg)";
    card.style.opacity = "0";
    setTimeout(done, 280);
  }

  // Программный «улёт» при нажатии кнопок
  function buttonAnswer(yes) {
    if (state.busy) return;
    const card = el.deck.querySelector(".card:last-child");
    const data = state.deck[state.index];
    if (!card || !data) return;
    const stamp = card.querySelector(yes ? ".stamp--yes" : ".stamp--no");
    if (stamp) stamp.style.opacity = 1;
    card.style.transition = "transform .3s ease, opacity .3s ease";
    flyAway(card, yes ? 1 : -1, () => answer(yes, data));
  }

  // ---------- Обработка ответа ----------
  function answer(playerYes, data) {
    const marketYes = data.p >= 0.5;
    const correct = playerYes === marketYes;
    state.total += 1;

    let gained = 0;
    if (correct) {
      state.correct += 1;
      state.streak += 1;
      state.bestStreak = Math.max(state.bestStreak, state.streak);
      const streakBonus = Math.min(state.streak * 2, STREAK_BONUS_CAP);
      const brave = data.p >= 0.45 && data.p <= 0.55 ? BRAVE_BONUS : 0;
      gained = BASE_POINTS + streakBonus + brave;
      state.score += gained;
      haptic("good");
    } else {
      state.streak = 0;
      state.lives -= 1;
      haptic("bad");
      el.screens.game.classList.add("shake");
      setTimeout(() => el.screens.game.classList.remove("shake"), 400);
    }

    updateHud();
    showVerdict(correct, data, gained);

    setTimeout(() => {
      hideVerdict();
      state.index += 1;
      if (state.lives <= 0) { endGame(false); return; }
      if (state.index >= state.deck.length) { endGame(true); return; }
      state.busy = false;
      renderDeck();
    }, 1150);
  }

  function showVerdict(correct, data, gained) {
    const pct = Math.round(data.p * 100);
    const side = data.p >= 0.5 ? "«Да» " + pct + "%" : "«Нет» " + (100 - pct) + "%";
    el.verdict.classList.remove("verdict--good", "verdict--bad");
    el.verdict.classList.add(correct ? "verdict--good" : "verdict--bad");
    el.verdictEmoji.textContent = correct ? "✅" : "❌";
    el.verdictTitle.textContent = correct ? "Совпало!" : "Мимо";
    el.verdictMarket.textContent = "Рынок: " + side;
    el.verdictPoints.textContent = correct ? "+" + gained : "−1 ❤️";
    el.verdict.classList.add("show");
  }
  function hideVerdict() { el.verdict.classList.remove("show"); }

  // ---------- Конец игры ----------
  function endGame(deckCleared) {
    state.busy = true;
    const best = getBest();
    const isNewBest = state.score > best;
    if (isNewBest) setBest(state.score);

    el.resultEmoji.textContent = deckCleared ? "🎉" : (state.score >= 100 ? "🔥" : "🏁");
    el.resultScore.textContent = state.score;
    el.resultNewbest.hidden = !isNewBest;
    el.resultCorrect.textContent = state.correct;
    el.resultTotal.textContent = state.total;
    const acc = state.total ? Math.round((state.correct / state.total) * 100) : 0;
    el.resultAcc.textContent = acc + "%";
    el.resultBeststreak.textContent = state.bestStreak;

    showScreen("over");
    if (tg && tg.BackButton) { try { tg.BackButton.hide(); } catch (e) {} }
    // Результат отдаётся боту по кнопке «Закрыть» (sendData закрывает
    // мини-апп, поэтому здесь его не вызываем — иначе экран результата
    // мелькнул бы и сразу закрылся).
  }

  function buildShareText() {
    const acc = state.total ? Math.round((state.correct / state.total) * 100) : 0;
    return (
      "🔮 Свайп-Прогноз: я набрал " + state.score + " очков!\n" +
      "🎯 Точность " + acc + "% · серия " + state.bestStreak + ".\n" +
      "Сможешь больше?"
    );
  }

  // ============================================================
  //  Обработчики кнопок
  // ============================================================
  el.btnPlay.addEventListener("click", startGame);
  el.btnAgain.addEventListener("click", startGame);
  el.btnYes.addEventListener("click", () => buttonAnswer(true));
  el.btnNo.addEventListener("click", () => buttonAnswer(false));
  el.btnSkip.addEventListener("click", () => {
    if (state.busy) return;
    const card = el.deck.querySelector(".card:last-child");
    if (!card) return;
    state.busy = true;
    card.style.transition = "transform .3s ease, opacity .3s ease";
    card.style.transform = "translateY(120%)";
    card.style.opacity = "0";
    setTimeout(() => {
      state.index += 1;
      if (state.index >= state.deck.length) { endGame(true); return; }
      state.busy = false;
      renderDeck();
    }, 260);
  });

  el.btnShare.addEventListener("click", () => {
    const text = buildShareText();
    if (tg && typeof tg.openTelegramLink === "function") {
      const url = "https://t.me/share/url?url=" +
        encodeURIComponent("https://t.me/") + "&text=" + encodeURIComponent(text);
      tg.openTelegramLink(url);
    } else if (navigator.share) {
      navigator.share({ text: text }).catch(() => {});
    } else {
      alert(text);
    }
  });

  el.btnClose.addEventListener("click", () => {
    // Если можем — отдаём результат боту (он сохранит рекорд) и закрываемся.
    const payload = JSON.stringify({
      type: "swipe_result",
      score: state.score,
      correct: state.correct,
      total: state.total,
      best_streak: state.bestStreak,
    });
    if (tg && typeof tg.sendData === "function") {
      try { tg.sendData(payload); return; } catch (e) { /* inline-режим */ }
    }
    if (tg && typeof tg.close === "function") tg.close();
  });

  // ============================================================
  //  Инициализация Telegram + темы
  // ============================================================
  function applyTheme() {
    if (!tg || !tg.themeParams) return;
    const p = tg.themeParams;
    const root = document.documentElement.style;
    const map = {
      "--tg-theme-bg-color": p.bg_color,
      "--tg-theme-secondary-bg-color": p.secondary_bg_color,
      "--tg-theme-text-color": p.text_color,
      "--tg-theme-hint-color": p.hint_color,
      "--tg-theme-link-color": p.link_color,
      "--tg-theme-button-color": p.button_color,
      "--tg-theme-button-text-color": p.button_text_color,
    };
    for (const k in map) { if (map[k]) root.setProperty(k, map[k]); }
  }

  function init() {
    el.startBest.textContent = getBest();
    el.loadingHint.textContent = "";

    if (tg) {
      try {
        tg.ready();
        tg.expand();
        applyTheme();
        tg.onEvent("themeChanged", applyTheme);
        if (tg.setHeaderColor) tg.setHeaderColor("bg_color");
      } catch (e) { console.warn("Telegram init:", e); }
    }
  }

  init();
})();
