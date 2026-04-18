// Revision — a zero-build vanilla JS app.
// Multi-deck, two roles (answer / ask), speech practice with feedback.

// ---------- State ----------
const state = {
  data: null,           // { subject, testTitle, student, decks: [...] }
  deckId: null,         // currently selected deck id (null = deck picker)
  view: "home",         // home | deck | learn | speak | type | test | results | edit
  drill: null,          // { mode, order, idx, answers: [...] }
  voices: [],
  voicesReady: false,
  rate: 0.8,            // global TTS rate, persisted
  frVoiceURI: null,     // user-picked French voice (voiceURI), persisted
};

const LS_DATA_KEY = "revision.data.v2";
const LS_RATE_KEY = "revision.rate.v1";
const LS_FR_VOICE_KEY = "revision.frVoice.v1";

// Preferred French voices, in order. Matched by substring of voice.name.
const PREFERRED_FR_VOICES = [
  "Thomas (Premium)", "Audrey (Premium)", "Marie (Premium)", "Amelie (Premium)",
  "Thomas (Enhanced)", "Audrey (Enhanced)", "Marie (Enhanced)", "Amelie (Enhanced)",
  "Thomas", "Audrey", "Marie", "Amelie", "Virginie",
  "Google français",
];
const PREFERRED_EN_VOICES = [
  "Samantha (Premium)", "Kate (Premium)", "Daniel (Premium)",
  "Samantha (Enhanced)", "Kate (Enhanced)", "Daniel (Enhanced)",
  "Samantha", "Kate", "Daniel", "Serena",
  "Google UK English Female", "Google US English",
];

// ---------- Boot ----------
async function boot() {
  const stored = localStorage.getItem(LS_DATA_KEY);
  if (stored) {
    try { state.data = JSON.parse(stored); }
    catch { state.data = null; }
  }
  if (!state.data) {
    const res = await fetch("cards.json");
    state.data = await res.json();
  }
  const savedRate = parseFloat(localStorage.getItem(LS_RATE_KEY));
  if (!Number.isNaN(savedRate) && savedRate > 0) state.rate = savedRate;
  state.frVoiceURI = localStorage.getItem(LS_FR_VOICE_KEY) || null;
  primeVoices(() => render());
  render();
}

function setRate(r) {
  state.rate = r;
  localStorage.setItem(LS_RATE_KEY, String(r));
  render();
}

function setFrVoice(uri) {
  state.frVoiceURI = uri || null;
  if (uri) localStorage.setItem(LS_FR_VOICE_KEY, uri);
  else localStorage.removeItem(LS_FR_VOICE_KEY);
  render();
}

function currentDeck() {
  return state.data.decks.find(d => d.id === state.deckId) || null;
}

// ---------- Speech synthesis (TTS) ----------
function primeVoices(onChange) {
  const load = () => {
    state.voices = window.speechSynthesis.getVoices();
    state.voicesReady = state.voices.length > 0;
    if (state.voicesReady && onChange) onChange();
  };
  load();
  if ("onvoiceschanged" in window.speechSynthesis) {
    // iOS Safari fires this after voices finish loading — keep listening in case the list grows
    window.speechSynthesis.addEventListener("voiceschanged", load);
  }
}

function availableVoices(lang) {
  const voices = state.voices.length ? state.voices : window.speechSynthesis.getVoices();
  const prefix = (lang || "").slice(0, 2).toLowerCase();
  return voices.filter(v => v.lang && v.lang.toLowerCase().startsWith(prefix));
}

function pickVoice(lang) {
  const voices = state.voices.length ? state.voices : window.speechSynthesis.getVoices();
  const isFr = lang && lang.toLowerCase().startsWith("fr");
  const isEn = lang && lang.toLowerCase().startsWith("en");
  // Honour the user's explicit French voice selection
  if (isFr && state.frVoiceURI) {
    const chosen = voices.find(v => v.voiceURI === state.frVoiceURI);
    if (chosen) return chosen;
  }
  const pool = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
  if (!pool.length) return null;
  const preferred = isFr ? PREFERRED_FR_VOICES : isEn ? PREFERRED_EN_VOICES : [];
  for (const wanted of preferred) {
    const hit = pool.find(v => v.name && v.name.includes(wanted));
    if (hit) return hit;
  }
  return pool.find(v => v.lang === lang) || pool.find(v => v.localService) || pool[0];
}

function speak(text, { rate, lang = "fr-FR" } = {}) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  const v = pickVoice(lang);
  if (v) u.voice = v;
  u.rate = typeof rate === "number" ? rate : state.rate;
  u.pitch = 1;
  window.speechSynthesis.speak(u);
}

// ---------- Speech recognition ----------
function getRecognition(lang = "fr-FR") {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = lang;
  r.interimResults = true;
  r.maxAlternatives = 3;
  r.continuous = false;
  return r;
}

// ---------- Answer matching ----------
function normalise(s) {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenise(s) {
  return normalise(s).split(/[\s'-]+/).filter(Boolean);
}

function matchAnswer(heard, expected) {
  const E = tokenise(expected);
  const H = tokenise(heard);
  const matchedInHeard = new Array(H.length).fill(false);
  const expectedResults = [];
  let hIdx = 0;
  for (let i = 0; i < E.length; i++) {
    const target = E[i];
    let found = -1;
    for (let j = hIdx; j < Math.min(hIdx + 4, H.length); j++) {
      if (!matchedInHeard[j] && (H[j] === target || levenshtein(H[j], target) <= 1)) { found = j; break; }
    }
    if (found === -1) {
      for (let j = hIdx; j < H.length; j++) {
        if (!matchedInHeard[j] && (H[j] === target || levenshtein(H[j], target) <= 1)) { found = j; break; }
      }
    }
    if (found !== -1) {
      matchedInHeard[found] = true;
      hIdx = found + 1;
      expectedResults.push({ word: target, state: "ok" });
    } else {
      expectedResults.push({ word: target, state: "miss" });
    }
  }
  const extras = H.map((w, i) => matchedInHeard[i] ? null : { word: w, state: "extra" }).filter(Boolean);
  const okCount = expectedResults.filter(r => r.state === "ok").length;
  const score = E.length === 0 ? 0 : okCount / E.length;
  let verdict;
  if (score >= 0.9 && extras.length <= 2) verdict = "correct";
  else if (score >= 0.6) verdict = "partial";
  else verdict = "wrong";
  return { score, verdict, expectedResults, extras };
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// ---------- Routing ----------
function go(view, opts = {}) {
  if (opts.deckId !== undefined) state.deckId = opts.deckId;
  state.view = view;
  if (view === "home") state.deckId = null;
  if (view === "home" || view === "deck") state.drill = null;
  render();
}

function startDrill(mode) {
  const deck = currentDeck();
  if (!deck) return;
  const n = deck.cards.length;
  const order = shuffle([...Array(n).keys()]);
  state.drill = { mode, order, idx: 0, answers: [] };
  state.view = mode;
  render();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- Rendering ----------
const app = document.getElementById("app");

function render() {
  app.innerHTML = "";
  const view = state.view;
  if (view === "home") renderHome();
  else if (view === "deck") renderDeck();
  else if (view === "learn") renderLearn();
  else if (view === "speak" || view === "type" || view === "test") renderDrill();
  else if (view === "results") renderResults();
  else if (view === "edit") renderEdit();
}

function topHeader(title, backTo) {
  const h = document.createElement("header");
  h.className = "top";
  h.innerHTML = `
    ${backTo ? `<button class="back" data-act="back">&larr;</button>` : `<span style="width:40px"></span>`}
    <h1>${escapeHtml(title)}</h1>
    <div class="speed-control" role="group" aria-label="Playback speed">
      ${speedBtn(0.6, "🐢", "Slow")}
      ${speedBtn(0.8, "🚶", "Normal")}
      ${speedBtn(1.0, "🏃", "Fast")}
    </div>
  `;
  h.querySelector("[data-act='back']")?.addEventListener("click", () => {
    if (backTo === "home") go("home");
    else if (backTo === "deck") go("deck");
  });
  h.querySelectorAll("[data-rate]").forEach(btn => {
    btn.addEventListener("click", () => setRate(parseFloat(btn.dataset.rate)));
  });
  return h;
}

function speedBtn(rate, icon, label) {
  const active = Math.abs(state.rate - rate) < 0.01;
  return `<button class="speed-btn ${active ? "active" : ""}" data-rate="${rate}" title="${label} (${rate}x)" aria-label="${label} speed ${rate}x">${icon}</button>`;
}

function rateLabel(r) {
  if (r <= 0.65) return "Slow";
  if (r <= 0.85) return "Normal";
  return "Fast";
}

function renderVoicePicker(host) {
  if (!host) return;
  const voices = availableVoices("fr");
  if (!voices.length) {
    host.innerHTML = `<div class="voice-row"><span class="voice-label">French voice</span><span class="voice-hint">Loading voices…</span></div>`;
    return;
  }
  // Sort: fr-FR first, then others
  voices.sort((a, b) => {
    const aFR = a.lang === "fr-FR" ? 0 : 1;
    const bFR = b.lang === "fr-FR" ? 0 : 1;
    if (aFR !== bFR) return aFR - bFR;
    return a.name.localeCompare(b.name);
  });
  const currentURI = state.frVoiceURI || (pickVoice("fr-FR")?.voiceURI || "");
  const options = voices.map(v =>
    `<option value="${escapeHtml(v.voiceURI)}" ${v.voiceURI === currentURI ? "selected" : ""}>${escapeHtml(v.name)} (${escapeHtml(v.lang)})</option>`
  ).join("");
  host.innerHTML = `
    <div class="voice-row">
      <label class="voice-label" for="voice-select">French voice</label>
      <select id="voice-select" class="voice-select">${options}</select>
      <button class="voice-test" data-act="test" title="Test this voice">🔊 Test</button>
    </div>
    <div class="voice-hint">${voices.length} French voice${voices.length === 1 ? "" : "s"} available. If none sound good, download an Enhanced voice in iOS: Settings → Accessibility → Read and Speak → Voices → French.</div>
  `;
  const sel = host.querySelector("#voice-select");
  sel.addEventListener("change", () => setFrVoice(sel.value));
  host.querySelector("[data-act='test']").addEventListener("click", () => {
    // Temporarily use the dropdown's current value even if not saved yet
    const tempURI = sel.value;
    const chosen = voices.find(v => v.voiceURI === tempURI);
    if (!chosen) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance("Bonjour, je m'appelle " + chosen.name.split(/[\s(]/)[0] + ". Ceci est ma voix.");
    u.voice = chosen;
    u.lang = chosen.lang;
    u.rate = state.rate;
    window.speechSynthesis.speak(u);
  });
}

// ---------- Home (deck picker) ----------
function renderHome() {
  const data = state.data;
  const el = document.createElement("div");
  el.innerHTML = `
    <header class="top">
      <button class="back" data-act="edit">Edit</button>
      <h1>${escapeHtml(data.student || "Revision")}</h1>
      <div class="speed-control" role="group" aria-label="Playback speed">
        ${speedBtn(0.6, "🐢", "Slow")}
        ${speedBtn(0.8, "🚶", "Normal")}
        ${speedBtn(1.0, "🏃", "Fast")}
      </div>
    </header>
    <div style="text-align:center; color:var(--muted); font-size:14px; margin-bottom:8px;">
      ${escapeHtml(data.subject || "")}${data.testTitle ? " · " + escapeHtml(data.testTitle) : ""}
    </div>
    <div style="text-align:center; color:var(--muted); font-size:12px; margin-bottom:12px;">
      Playback speed: <b style="color:var(--text)">${rateLabel(state.rate)}</b> · tap 🐢/🚶/🏃
    </div>
    <div id="voice-picker" style="margin-bottom:20px;"></div>
    <div style="color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:0.6px; margin-bottom:10px;">Choose a deck</div>
    <div class="home-grid" id="deck-grid"></div>
  `;
  renderVoicePicker(el.querySelector("#voice-picker"));
  const grid = el.querySelector("#deck-grid");
  data.decks.forEach((deck, i) => {
    const btn = document.createElement("button");
    btn.className = `home-card ${i === 0 ? "primary" : ""}`;
    btn.innerHTML = `
      <span>${deck.icon || "📘"} <b>${escapeHtml(deck.title)}</b><span class="desc">${escapeHtml(deck.subtitle || "")} · ${deck.cards.length} cards</span></span>
      <span>›</span>
    `;
    btn.addEventListener("click", () => go("deck", { deckId: deck.id }));
    grid.appendChild(btn);
  });
  el.querySelector("[data-act='edit']").addEventListener("click", () => go("edit"));
  el.querySelectorAll("[data-rate]").forEach(btn => {
    btn.addEventListener("click", () => setRate(parseFloat(btn.dataset.rate)));
  });
  app.appendChild(el);
}

// ---------- Deck view (mode picker for selected deck) ----------
function renderDeck() {
  const deck = currentDeck();
  if (!deck) { go("home"); return; }
  const el = document.createElement("div");
  el.appendChild(topHeader(deck.title, "home"));
  const sub = document.createElement("div");
  sub.style.cssText = "text-align:center; color:var(--muted); font-size:14px; margin-bottom:20px;";
  sub.textContent = deck.subtitle || "";
  el.appendChild(sub);
  const grid = document.createElement("div");
  grid.className = "home-grid";
  const isAsk = deck.role === "ask";
  const speakDesc = isAsk ? "See the cue, say the question aloud" : "Hear the question, say the answer aloud";
  const typeDesc  = isAsk ? "Type the French question" : "Type the answer in French";
  const learnDesc = isAsk ? "See each cue with the French question" : "See all Q&A, tap to hear spoken French";
  const testDesc  = `All ${deck.cards.length} at random`;
  const srOK = speechAvailable();
  const speakTile = srOK
    ? `<button class="home-card primary" data-act="speak"><span>🎤 <b>Speak drill</b><span class="desc">${speakDesc}</span></span><span>›</span></button>`
    : "";
  grid.innerHTML = `
    ${speakTile}
    <button class="home-card ${srOK ? "" : "primary"}" data-act="type">
      <span>⌨️ <b>Type mode</b><span class="desc">${typeDesc}</span></span><span>›</span>
    </button>
    <button class="home-card" data-act="learn">
      <span>📖 <b>Learn</b><span class="desc">${learnDesc}</span></span><span>›</span>
    </button>
    <button class="home-card" data-act="test">
      <span>✅ <b>Test run</b><span class="desc">${testDesc}</span></span><span>›</span>
    </button>
  `;
  if (srOK) grid.querySelector("[data-act='speak']").addEventListener("click", () => startDrill("speak"));
  grid.querySelector("[data-act='type']").addEventListener("click", () => startDrill("type"));
  grid.querySelector("[data-act='test']").addEventListener("click", () => startDrill("test"));
  grid.querySelector("[data-act='learn']").addEventListener("click", () => { state.view = "learn"; render(); });
  el.appendChild(grid);
  app.appendChild(el);
}

// ---------- Learn mode ----------
function renderLearn() {
  const deck = currentDeck();
  if (!deck) { go("home"); return; }
  const el = document.createElement("div");
  el.appendChild(topHeader("Learn", "deck"));
  const list = document.createElement("div");
  list.className = "learn-list";
  deck.cards.forEach((c, i) => {
    const item = document.createElement("div");
    item.className = "learn-item";
    const promptIsFr = (c.promptLang || "fr-FR").toLowerCase().startsWith("fr");
    const promptBtnLabel = promptIsFr ? "🔊 Hear French" : "🔊 Hear cue";
    const responseBtnLabel = "🔊 Hear French";
    item.innerHTML = `
      <div class="q">${i + 1} — ${escapeHtml(deck.labels.prompt)}</div>
      <div class="q-text">${escapeHtml(c.prompt)}</div>
      <div class="a">${escapeHtml(deck.labels.response)}</div>
      <div class="a-text">${escapeHtml(c.response)}</div>
      <div class="row">
        <button data-act="prompt">${promptBtnLabel}</button>
        <button data-act="response">${responseBtnLabel}</button>
        <button class="slow" data-act="slow">🐢 Slower</button>
      </div>
    `;
    item.querySelector("[data-act='prompt']").addEventListener("click", () => speak(c.prompt, { lang: c.promptLang || "fr-FR" }));
    item.querySelector("[data-act='response']").addEventListener("click", () => speak(c.response, { lang: c.responseLang || "fr-FR" }));
    item.querySelector("[data-act='slow']").addEventListener("click", () => speak(c.response, { lang: c.responseLang || "fr-FR", rate: 0.5 }));
    list.appendChild(item);
  });
  el.appendChild(list);
  app.appendChild(el);
}

// ---------- Drill (speak / type / test) ----------
function renderDrill() {
  const deck = currentDeck();
  if (!deck) { go("home"); return; }
  const mode = state.drill.mode;
  const titles = { speak: "Speak drill", type: "Type mode", test: "Test run" };
  const el = document.createElement("div");
  el.appendChild(topHeader(titles[mode], "deck"));

  const d = state.drill;
  const cardIdx = d.order[d.idx];
  const card = deck.cards[cardIdx];
  const total = d.order.length;

  const wrap = document.createElement("div");
  wrap.className = "drill";
  wrap.innerHTML = `
    <div class="progress-bar"><div class="fill" style="width:${((d.idx) / total) * 100}%"></div></div>
    <div class="prompt-card">
      <div class="label">${escapeHtml(deck.labels.prompt)} — ${d.idx + 1} of ${total}</div>
      <div class="prompt-text">${escapeHtml(card.prompt)}</div>
      <button class="replay" data-act="hearPrompt">🔊 Hear it${card.promptLang && !card.promptLang.startsWith("fr") ? " (English)" : ""}</button>
    </div>
  `;
  wrap.querySelector("[data-act='hearPrompt']").addEventListener("click", () => speak(card.prompt, { lang: card.promptLang || "fr-FR" }));
  el.appendChild(wrap);

  // Auto-play the prompt on entry (speak mode) — pronounced only after user has interacted.
  if (mode === "speak") {
    setTimeout(() => speak(card.prompt, { lang: card.promptLang || "fr-FR" }), 250);
  }

  const answer = document.createElement("div");
  answer.className = "answer-area";

  if (mode === "type" || (mode === "test" && !speechAvailable())) {
    renderTypeArea(answer, card, deck);
  } else if (mode === "speak") {
    if (!speechAvailable()) {
      const b = document.createElement("div");
      b.className = "warning-banner";
      b.textContent = "Speech recognition isn't available in this browser. Use Safari on iPhone, or Chrome on desktop. Falling back to typing.";
      answer.appendChild(b);
      renderTypeArea(answer, card, deck);
    } else {
      renderSpeakArea(answer, card, deck);
    }
  } else { // test mode with speech available → prefer speaking
    if (speechAvailable()) renderSpeakArea(answer, card, deck);
    else renderTypeArea(answer, card, deck);
  }
  el.appendChild(answer);
  app.appendChild(el);
}

function speechAvailable() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function renderTypeArea(host, card, deck) {
  const label = deck.role === "ask" ? "Type the French question" : "Type the answer in French";
  host.innerHTML = `
    <label for="ans" style="color:var(--muted);font-size:13px;">${label}</label>
    <textarea id="ans" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Tapez votre réponse..."></textarea>
    <div class="action-row">
      <button class="primary" data-act="submit">Check</button>
      <button class="secondary" data-act="skip">Skip</button>
    </div>
  `;
  const ta = host.querySelector("#ans");
  setTimeout(() => ta.focus(), 50);
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitAnswer(ta.value);
  });
  host.querySelector("[data-act='submit']").addEventListener("click", () => submitAnswer(ta.value));
  host.querySelector("[data-act='skip']").addEventListener("click", () => submitAnswer(""));
}

function renderSpeakArea(host, card, deck) {
  const lang = card.responseLang || "fr-FR";
  host.innerHTML = `
    <button class="mic-btn" data-act="mic">🎤 Tap to speak</button>
    <div class="heard" id="heard">Your answer will appear here…</div>
    <div class="action-row">
      <button class="secondary" data-act="skip">Skip</button>
    </div>
  `;
  const micBtn = host.querySelector("[data-act='mic']");
  const heardEl = host.querySelector("#heard");
  let recognition = null;
  let listening = false;
  let finalTranscript = "";
  let interimTranscript = "";

  micBtn.addEventListener("click", () => {
    if (listening) { recognition?.stop(); return; }
    recognition = getRecognition(lang);
    if (!recognition) return;
    finalTranscript = "";
    interimTranscript = "";
    heardEl.innerHTML = "<em>Listening…</em>";
    listening = true;
    micBtn.classList.add("listening");
    micBtn.textContent = "⏹ Stop listening";
    recognition.onresult = (ev) => {
      interimTranscript = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalTranscript += r[0].transcript + " ";
        else interimTranscript += r[0].transcript;
      }
      heardEl.innerHTML = `<strong>${escapeHtml((finalTranscript + interimTranscript).trim() || "…")}</strong>`;
    };
    recognition.onerror = (ev) => {
      heardEl.innerHTML = `<span style="color:var(--error)">Mic error: ${ev.error}. Try again or use Type mode.</span>`;
      listening = false;
      micBtn.classList.remove("listening");
      micBtn.textContent = "🎤 Tap to speak";
    };
    recognition.onend = () => {
      listening = false;
      micBtn.classList.remove("listening");
      micBtn.textContent = "🎤 Tap to speak";
      const said = (finalTranscript + interimTranscript).trim();
      if (said) submitAnswer(said);
    };
    try { recognition.start(); } catch (e) {
      heardEl.innerHTML = `<span style="color:var(--error)">Couldn't start mic: ${e.message}</span>`;
      listening = false;
      micBtn.classList.remove("listening");
      micBtn.textContent = "🎤 Tap to speak";
    }
  });
  host.querySelector("[data-act='skip']").addEventListener("click", () => submitAnswer(""));
}

function submitAnswer(heard) {
  const deck = currentDeck();
  const d = state.drill;
  const cardIdx = d.order[d.idx];
  const card = deck.cards[cardIdx];
  const result = matchAnswer(heard || "", card.response);
  d.answers.push({ cardIdx, heard, result });
  if (d.mode === "test") advance();
  else showFeedback(card, heard, result, deck);
}

function showFeedback(card, heard, result, deck) {
  const el = document.createElement("div");
  const titles = { speak: "Speak drill", type: "Type mode", test: "Test run" };
  el.appendChild(topHeader(titles[state.drill.mode], "deck"));
  const wrap = document.createElement("div");
  wrap.className = "drill";
  const verdictLabel = { correct: "Perfect!", partial: "Nearly there", wrong: "Let's try again" };
  const fb = document.createElement("div");
  fb.className = `feedback ${result.verdict}`;
  const diffHtml = result.expectedResults.map(r => {
    if (r.state === "ok") return `<span class="word-ok">${escapeHtml(r.word)}</span>`;
    return `<span class="word-miss">${escapeHtml(r.word)}</span>`;
  }).join(" ");
  const extrasHtml = result.extras.length
    ? `<div class="diff"><small style="color:var(--muted)">Extra words you said:</small> ${result.extras.map(e => `<span class="word-extra">${escapeHtml(e.word)}</span>`).join(" ")}</div>`
    : "";
  fb.innerHTML = `
    <div class="headline">${verdictLabel[result.verdict]} · ${(result.score * 100).toFixed(0)}% of words matched</div>
    <div class="diff">${diffHtml}</div>
    ${extrasHtml}
    <div class="expected">Expected: <b>${escapeHtml(card.response)}</b></div>
    ${heard ? `<div class="expected">You said: <b>${escapeHtml(heard)}</b></div>` : `<div class="expected">You skipped this one.</div>`}
  `;
  wrap.appendChild(fb);
  const row = document.createElement("div");
  row.className = "action-row";
  row.innerHTML = `
    <button class="secondary" data-act="hear">🔊 Hear correct answer</button>
    <button class="primary" data-act="next">${state.drill.idx + 1 === state.drill.order.length ? "Finish" : "Next →"}</button>
  `;
  row.querySelector("[data-act='hear']").addEventListener("click", () => speak(card.response, { lang: card.responseLang || "fr-FR" }));
  row.querySelector("[data-act='next']").addEventListener("click", advance);
  wrap.appendChild(row);
  el.appendChild(wrap);
  app.innerHTML = "";
  app.appendChild(el);
}

function advance() {
  const d = state.drill;
  d.idx += 1;
  if (d.idx >= d.order.length) {
    state.view = "results";
    render();
  } else {
    state.view = d.mode;
    render();
  }
}

function renderResults() {
  const deck = currentDeck();
  const d = state.drill;
  const correct = d.answers.filter(a => a.result.verdict === "correct").length;
  const partial = d.answers.filter(a => a.result.verdict === "partial").length;
  const wrong = d.answers.length - correct - partial;
  const pct = Math.round((correct / d.answers.length) * 100);
  const el = document.createElement("div");
  el.appendChild(topHeader("Results", "deck"));
  const results = document.createElement("div");
  results.className = "results";
  results.innerHTML = `
    <div class="score">${pct}%</div>
    <p><b>${correct}</b> perfect · <b>${partial}</b> nearly · <b>${wrong}</b> to revisit</p>
    <div class="action-row" style="max-width:360px; margin:24px auto;">
      <button class="secondary" data-act="again">Try again</button>
      <button class="primary" data-act="deck">Back to deck</button>
    </div>
  `;
  results.querySelector("[data-act='again']").addEventListener("click", () => startDrill(d.mode));
  results.querySelector("[data-act='deck']").addEventListener("click", () => go("deck"));
  el.appendChild(results);
  const list = document.createElement("div");
  list.className = "learn-list";
  list.style.marginTop = "24px";
  d.answers.forEach(a => {
    const card = deck.cards[a.cardIdx];
    const item = document.createElement("div");
    item.className = "learn-item";
    item.innerHTML = `
      <div class="q">${escapeHtml(deck.labels.prompt)} — ${a.result.verdict}</div>
      <div class="q-text">${escapeHtml(card.prompt)}</div>
      <div class="a">Expected</div>
      <div class="a-text">${escapeHtml(card.response)}</div>
      ${a.heard ? `<div class="a" style="margin-top:10px">You said</div><div class="a-text" style="color:var(--muted)">${escapeHtml(a.heard)}</div>` : ""}
      <div class="row">
        <button data-act="hear">🔊 Hear correct answer</button>
      </div>
    `;
    item.querySelector("[data-act='hear']").addEventListener("click", () => speak(card.response, { lang: card.responseLang || "fr-FR" }));
    list.appendChild(item);
  });
  el.appendChild(list);
  app.appendChild(el);
}

// ---------- Edit ----------
function renderEdit() {
  const el = document.createElement("div");
  el.appendChild(topHeader("Edit decks", "home"));
  const form = document.createElement("div");
  form.className = "settings-form";
  const current = JSON.stringify(state.data, null, 2);
  form.innerHTML = `
    <div class="hint">
      Advanced: paste the full deck JSON here. Back up before editing.<br>
      Reset restores the bundled decks shipped with the app.
    </div>
    <label for="raw">Deck JSON</label>
    <textarea id="raw" spellcheck="false">${escapeHtml(current)}</textarea>
    <div class="action-row">
      <button class="secondary" data-act="reset">Reset to bundled</button>
      <button class="primary" data-act="save">Save</button>
    </div>
  `;
  form.querySelector("[data-act='save']").addEventListener("click", () => {
    const raw = form.querySelector("#raw").value;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.decks || !Array.isArray(parsed.decks)) throw new Error("Missing decks[]");
      state.data = parsed;
      localStorage.setItem(LS_DATA_KEY, JSON.stringify(parsed));
      go("home");
    } catch (e) {
      alert("Couldn't parse JSON: " + e.message);
    }
  });
  form.querySelector("[data-act='reset']").addEventListener("click", async () => {
    if (!confirm("Reset to the bundled decks? This clears your edits.")) return;
    localStorage.removeItem(LS_DATA_KEY);
    const res = await fetch("cards.json?v=" + Date.now());
    state.data = await res.json();
    go("home");
  });
  el.appendChild(form);
  app.appendChild(el);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

boot();
