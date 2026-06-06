import { useState, useEffect, useCallback, useRef } from "react";

// ============================================================
// SUPABASE CONFIG
// ============================================================
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ============================================================
// MASTERY CONFIG
// ============================================================
const MASTERY_THRESHOLD = 5;  // score needed to master a question
const SESSION_SIZE      = 10; // questions per round

// ============================================================
// SUPABASE SCORE STORE — reads/writes score column on gkgs table
// scores live in memory (scoreCache) after initial fetch;
// each correct/wrong answer fires a PATCH to Supabase in the background.
// ============================================================
const ScoreStore = {
  // In-memory cache: { [id]: score }
  _cache: {},

  // Seed the cache from already-loaded question objects (score field)
  seed(questions) {
    for (const q of questions) {
      this._cache[q.id] = q.score ?? 0;
    }
  },

  // Read from cache (synchronous, always up to date after seed)
  get(id) {
    return this._cache[id] ?? 0;
  },

  getAll(ids) {
    const map = {};
    for (const id of ids) map[id] = this.get(id);
    return map;
  },

  getMasteredCount(ids) {
    return ids.filter(id => this.get(id) >= MASTERY_THRESHOLD).length;
  },

  // Optimistically update cache, then PATCH Supabase
  async increment(id) {
    const cur = this.get(id);
    const nxt = Math.min(cur + 1, MASTERY_THRESHOLD);
    this._cache[id] = nxt;
    await _patchScore(id, nxt);
    return nxt;
  },

  async decrement(id) {
    const cur = this.get(id);
    const nxt = Math.max(cur - 1, 0);
    this._cache[id] = nxt;
    await _patchScore(id, nxt);
    return nxt;
  },

  async reset(ids) {
    for (const id of ids) this._cache[id] = 0;
    // Batch reset: fire individual PATCHes (Supabase REST has no batch update without RPC)
    await Promise.all(ids.map(id => _patchScore(id, 0)));
  },
};

// Helper: PATCH score for a single row by id (uuid)
async function _patchScore(id, score) {
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/gkgs?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ score }),
      }
    );
  } catch (err) {
    console.error("ScoreStore: failed to patch score", id, err);
  }
}

// ============================================================
// DATABASE LAYER
// ============================================================
const DB = {
  _h(extra = {}) {
    return {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      ...extra,
    };
  },

  async getSubjects() {
    const PAGE = 1000;
    let from = 0, allRows = [];
    while (true) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/gkgs?select=subject`, {
        headers: this._h({ Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" }),
      });
      if (!res.ok) break;
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      allRows = allRows.concat(rows);
      if (rows.length < PAGE) break;
      from += PAGE;
    }
    return [...new Set(allRows.map(r => r.subject).filter(Boolean))];
  },

  async getTopicsForSubject(subject) {
    const PAGE = 1000;
    let from = 0, allRows = [];
    while (true) {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/gkgs?select=file_name&subject=eq.${encodeURIComponent(subject)}&file_name=neq.__subject__`,
        { headers: this._h({ Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" }) }
      );
      if (!res.ok) break;
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      allRows = allRows.concat(rows);
      if (rows.length < PAGE) break;
      from += PAGE;
    }
    return [...new Set(allRows.map(r => r.file_name?.trim()).filter(Boolean))];
  },

  async getQuestionsForTopic(subject, fileName) {
    const PAGE = 1000;
    let from = 0, allRows = [];
    while (true) {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/gkgs?select=id,question,option_a,option_b,option_c,option_d,correct_answer,solution,score&subject=eq.${encodeURIComponent(subject)}&file_name=eq.${encodeURIComponent(fileName)}&order=id`,
        { headers: this._h({ Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" }) }
      );
      if (!res.ok) break;
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      allRows = allRows.concat(rows);
      if (rows.length < PAGE) break;
      from += PAGE;
    }
    return allRows.map(r => ({
      id: r.id,
      question: r.question,
      options: shuffle([r.option_a, r.option_b, r.option_c, r.option_d].filter(Boolean)),
      optionA: r.option_a, optionB: r.option_b, optionC: r.option_c, optionD: r.option_d,
      correct: r.correct_answer,
      solution: r.solution,
      score: r.score ?? 0,   // ← from DB
    }));
  },

  async addSubjectSeed(subject) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/gkgs`, {
      method: "POST",
      headers: this._h({ Prefer: "return=minimal" }),
      body: JSON.stringify([{
        file_name: "__subject__", subject,
        question: "__seed__", option_a: "", option_b: "", option_c: "", option_d: "",
        correct_answer: "", solution: null,
      }]),
    });
    return res.ok;
  },

  async upload(file, subject) {
    const text = await file.text();
    const fileName = file.name;
    await fetch(`${SUPABASE_URL}/rest/v1/gkgs?file_name=eq.${encodeURIComponent(fileName)}`, {
      method: "DELETE", headers: this._h(),
    });
    let rows = [];
    const lines = text.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const cols = parseCSVLine(line);
      if (cols.length < 6) continue;
      if (!cols[0] || cols[0].toLowerCase() === "question") continue;
      rows.push({
        file_name: fileName, subject: subject || "general",
        question: cols[0], option_a: cols[1] || "", option_b: cols[2] || "",
        option_c: cols[3] || "", option_d: cols[4] || "",
        correct_answer: cols[5] || "", solution: cols[6] || null,
      });
    }
    if (!rows.length) throw new Error("No valid rows found in CSV");
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/gkgs`, {
        method: "POST",
        headers: this._h({ Prefer: "return=minimal" }),
        body: JSON.stringify(rows.slice(i, i + CHUNK)),
      });
      if (!res.ok) throw new Error(await res.text());
    }
    return true;
  },

  async deleteTopic(fileName) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/gkgs?file_name=eq.${encodeURIComponent(fileName)}`, {
      method: "DELETE", headers: this._h(),
    });
    return res.ok;
  },
};

// ============================================================
// UTILS
// ============================================================
function parseCSVLine(line) {
  const result = []; let current = ""; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"' && inQuotes) { current += '"'; i++; }
    else if (char === '"') { inQuotes = !inQuotes; }
    else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ""; }
    else { current += char; }
  }
  result.push(current.trim());
  return result;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildSession(allQuestions) {
  // Scores come from ScoreStore cache (seeded from DB on topic load)
  const unmastered = allQuestions.filter(q => ScoreStore.get(q.id) < MASTERY_THRESHOLD);

  if (unmastered.length === 0) return { questions: [], allMastered: true };

  // Weight lower-score questions more heavily
  const weighted = [];
  for (const q of unmastered) {
    const remaining = MASTERY_THRESHOLD - ScoreStore.get(q.id);
    for (let i = 0; i < remaining; i++) weighted.push(q);
  }

  const pool = shuffle(weighted);
  const seen = new Set();
  const picked = [];
  for (const q of pool) {
    if (!seen.has(q.id)) {
      seen.add(q.id);
      picked.push({ ...q, options: shuffle([q.optionA, q.optionB, q.optionC, q.optionD].filter(Boolean)) });
    }
    if (picked.length === SESSION_SIZE) break;
  }
  // Pad with repeats if fewer than SESSION_SIZE unmastered questions exist
  if (picked.length < SESSION_SIZE && unmastered.length > 0) {
    const extra = shuffle(unmastered);
    for (const q of extra) {
      if (picked.length >= SESSION_SIZE) break;
      picked.push({ ...q, options: shuffle([q.optionA, q.optionB, q.optionC, q.optionD].filter(Boolean)) });
    }
  }
  return { questions: picked, allMastered: false };
}

// ============================================================
// TOAST
// ============================================================
function useToast() {
  const [toasts, setToasts] = useState([]);
  const add = useCallback((msg, type = "info") => {
    const id = Date.now();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3800);
  }, []);
  return { toasts, add };
}

// ============================================================
// STYLES
// ============================================================
const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=DM+Mono:wght@400;500&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:       #f4f1ec;
  --bg2:      #eceae3;
  --bg3:      #e3e0d8;
  --bg4:      #faf9f6;
  --ink:      #18150f;
  --ink2:     #383228;
  --muted:    #867c6a;
  --muted2:   #b3a892;
  --border:   rgba(24,21,15,0.09);
  --border2:  rgba(24,21,15,0.17);
  --red:      #c23b2e;
  --red-bg:   rgba(194,59,46,0.06);
  --red-bdr:  rgba(194,59,46,0.2);
  --green:    #1a7a4a;
  --green-bg: rgba(26,122,74,0.07);
  --green-bdr:rgba(26,122,74,0.22);
  --amber:    #9a6200;
  --amber-bg: rgba(154,98,0,0.07);
  --teal:     #0d7377;
  --teal-bg:  rgba(13,115,119,0.07);
  --teal-bdr: rgba(13,115,119,0.22);
  --gold:     #b8860b;
  --gold-bg:  rgba(184,134,11,0.08);
  --pip-empty:#d5d0c8;
  --shadow:   0 2px 24px rgba(24,21,15,0.08);
  font-size: 16px;
}
[data-theme="dark"] {
  --bg:       #0e1014;
  --bg2:      #151921;
  --bg3:      #1c2229;
  --bg4:      #1a1f27;
  --ink:      #eef0f3;
  --ink2:     #c4ccd6;
  --muted:    #8491a0;
  --muted2:   #5e6b7a;
  --border:   rgba(255,255,255,0.07);
  --border2:  rgba(255,255,255,0.14);
  --red:      #ff6b5b;
  --red-bg:   rgba(255,107,91,0.08);
  --red-bdr:  rgba(255,107,91,0.24);
  --green:    #3fb950;
  --green-bg: rgba(63,185,80,0.08);
  --green-bdr:rgba(63,185,80,0.24);
  --amber:    #e3b341;
  --amber-bg: rgba(227,179,65,0.08);
  --teal:     #2dd4bf;
  --teal-bg:  rgba(45,212,191,0.08);
  --teal-bdr: rgba(45,212,191,0.24);
  --gold:     #ffd700;
  --gold-bg:  rgba(255,215,0,0.08);
  --pip-empty:#2a3240;
  --shadow:   0 2px 24px rgba(0,0,0,0.25);
}

html { scroll-behavior: smooth; }
body {
  background: var(--bg);
  color: var(--ink);
  font-family: 'DM Sans', sans-serif;
  min-height: 100vh;
  overflow-x: hidden;
}

/* grid background */
body::before {
  content:''; position:fixed; inset:0; z-index:0; pointer-events:none;
  background-image:
    linear-gradient(var(--border) 1px, transparent 1px),
    linear-gradient(90deg, var(--border) 1px, transparent 1px);
  background-size: 40px 40px;
  opacity:0.45;
}
#root { position:relative; z-index:1; }

/* ── TOPBAR ── */
.topbar {
  height:60px; display:flex; align-items:center; justify-content:space-between;
  padding:0 2rem; border-bottom:1.5px solid var(--border2);
  background:rgba(244,241,236,0.93); backdrop-filter:blur(14px);
  position:sticky; top:0; z-index:300;
}
[data-theme="dark"] .topbar { background:rgba(14,16,20,0.93); }

.logo {
  font-family:'Syne',sans-serif; font-size:1.35rem; font-weight:800;
  color:var(--ink); letter-spacing:-0.03em; display:flex; align-items:center; gap:0.55rem;
}
.logo-dot {
  width:8px; height:8px; border-radius:50%; background:var(--red);
  display:inline-block; flex-shrink:0;
}
.logo-sub {
  font-size:0.68rem; font-family:'DM Mono',monospace; letter-spacing:0.1em;
  color:var(--muted); font-weight:400; margin-left:0.2rem;
  text-transform:uppercase;
}
.topbar-right { display:flex; align-items:center; gap:0.6rem; }
.status-pill {
  display:flex; align-items:center; gap:0.35rem;
  padding:0.22rem 0.7rem; border-radius:100px; font-size:0.66rem;
  font-family:'DM Mono',monospace; letter-spacing:0.06em;
  border:1px solid var(--green-bdr); background:var(--green-bg); color:var(--green);
}
.status-dot { width:5px; height:5px; border-radius:50%; background:var(--green); animation:blink 2s ease infinite; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }

/* ── BREADCRUMB NAV ── */
.breadcrumb {
  display:flex; align-items:center; gap:0.4rem; padding:0.75rem 2rem;
  background:var(--bg4); border-bottom:1px solid var(--border);
  font-size:0.76rem; font-family:'DM Mono',monospace; color:var(--muted);
  position:sticky; top:60px; z-index:290; flex-wrap:wrap;
}
.bc-item { color:var(--muted); }
.bc-item.active { color:var(--ink); font-weight:500; }
.bc-item.clickable { cursor:pointer; color:var(--red); }
.bc-item.clickable:hover { text-decoration:underline; }
.bc-sep { color:var(--muted2); }

/* ── PAGE WRAPPER ── */
.page { max-width:1100px; margin:0 auto; padding:2.5rem 2rem 6rem; }

/* ── SECTION HEADER ── */
.sect-head {
  display:flex; align-items:center; gap:0.75rem; margin-bottom:1.5rem;
}
.sect-line {
  flex:1; height:1.5px; background:var(--border2);
}
.sect-label {
  font-family:'DM Mono',monospace; font-size:0.62rem; letter-spacing:0.22em;
  text-transform:uppercase; color:var(--muted); white-space:nowrap;
}
.sect-badge {
  padding:0.1rem 0.55rem; border-radius:100px; font-size:0.6rem;
  font-family:'DM Mono',monospace;
  background:var(--red-bg); color:var(--red); border:1px solid var(--red-bdr);
}
.sect-badge.green { background:var(--green-bg); color:var(--green); border-color:var(--green-bdr); }
.sect-badge.teal  { background:var(--teal-bg);  color:var(--teal);  border-color:var(--teal-bdr);  }

/* ── SUBJECT GRID ── */
.subj-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:1rem; }
.subj-card {
  background:var(--bg4); border:1.5px solid var(--border2); border-radius:16px;
  padding:1.6rem 1.4rem; cursor:pointer; transition:all 0.2s; position:relative; overflow:hidden;
}
.subj-card::before {
  content:''; position:absolute; left:0; top:0; bottom:0; width:3px;
  background:var(--red); border-radius:16px 0 0 16px; transform:scaleY(0); transition:transform 0.2s;
}
.subj-card:hover { transform:translateY(-3px); box-shadow:0 12px 40px rgba(24,21,15,0.1); border-color:var(--red); }
.subj-card:hover::before { transform:scaleY(1); }
.subj-icon { font-size:2rem; margin-bottom:0.75rem; }
.subj-name { font-family:'Syne',sans-serif; font-size:1.15rem; font-weight:700; margin-bottom:0.4rem; }
.subj-meta { color:var(--muted); font-size:0.74rem; font-family:'DM Mono',monospace; }

/* ── TOPIC GRID ── */
.topic-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:1rem; }
.topic-card {
  background:var(--bg4); border:1.5px solid var(--border2); border-radius:16px;
  padding:1.5rem; cursor:pointer; transition:all 0.22s; position:relative; overflow:hidden;
}
.topic-card:hover { transform:translateY(-2px); box-shadow:var(--shadow); }
.topic-card.mastered { border-color:var(--gold); background:var(--gold-bg); }
.topic-card.mastered::after {
  content:'★ MASTERED'; position:absolute; top:0.7rem; right:0.8rem;
  font-family:'DM Mono',monospace; font-size:0.55rem; letter-spacing:0.12em;
  color:var(--gold); background:var(--gold-bg); border:1px solid rgba(184,134,11,0.25);
  padding:0.18rem 0.5rem; border-radius:6px;
}
[data-theme="dark"] .topic-card.mastered::after { border-color:rgba(255,215,0,0.2); }
.topic-card-top { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:1rem; gap:0.5rem; }
.topic-name { font-family:'Syne',sans-serif; font-size:0.95rem; font-weight:700; line-height:1.3; flex:1; }
.topic-count-badge {
  padding:0.18rem 0.55rem; border-radius:8px; font-size:0.64rem;
  font-family:'DM Mono',monospace; background:var(--bg3); color:var(--muted);
  border:1px solid var(--border); flex-shrink:0;
}
.topic-progress-wrap { margin-bottom:0.75rem; }
.topic-progress-bar-bg {
  height:5px; background:var(--bg3); border-radius:3px; overflow:hidden;
}
.topic-progress-bar-fill {
  height:100%; border-radius:3px; transition:width 0.5s ease;
  background:linear-gradient(90deg, var(--teal), var(--green));
}
.topic-progress-bar-fill.full { background:linear-gradient(90deg, var(--gold), #e6ac00); }
.topic-progress-text {
  font-family:'DM Mono',monospace; font-size:0.62rem; color:var(--muted);
  margin-top:0.35rem;
}
.topic-actions { display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:1rem; }

/* ── BUTTONS ── */
.btn {
  display:inline-flex; align-items:center; gap:0.35rem;
  padding:0.52rem 1.1rem; border-radius:9px; border:none; cursor:pointer;
  font-family:'DM Sans',sans-serif; font-size:0.8rem; font-weight:600;
  transition:all 0.18s; white-space:nowrap;
}
.btn-red    { background:var(--red); color:#fff; }
.btn-red:hover { background:#a8352a; transform:translateY(-1px); box-shadow:0 4px 14px rgba(194,59,46,0.3); }
.btn-teal   { background:var(--teal); color:#fff; }
.btn-teal:hover { background:#0b5f63; transform:translateY(-1px); box-shadow:0 4px 14px rgba(13,115,119,0.3); }
.btn-green  { background:var(--green); color:#fff; }
.btn-green:hover { background:#155f39; transform:translateY(-1px); box-shadow:0 4px 14px rgba(26,122,74,0.3); }
.btn-ghost  { background:transparent; color:var(--ink2); border:1.5px solid var(--border2); }
.btn-ghost:hover { background:var(--bg2); }
.btn-danger { background:transparent; color:var(--red); border:1px solid var(--red-bdr); }
.btn-danger:hover { background:var(--red-bg); }
.btn-sm     { padding:0.35rem 0.75rem; font-size:0.73rem; border-radius:7px; }
.btn-xs     { padding:0.26rem 0.55rem; font-size:0.66rem; border-radius:6px; }
.btn:disabled { opacity:0.45; cursor:not-allowed; transform:none !important; box-shadow:none !important; }

/* ── UPLOAD AREA ── */
.upload-area {
  border:2px dashed var(--border2); border-radius:16px;
  padding:2rem; text-align:center; cursor:pointer;
  transition:all 0.22s; background:var(--bg4); margin-bottom:2rem; position:relative;
}
.upload-area:hover, .upload-area.drag { border-color:var(--red); background:rgba(194,59,46,0.03); }
.upload-area input { position:absolute; inset:0; opacity:0; cursor:pointer; width:100%; height:100%; }
.upload-glyph { font-size:2.2rem; margin-bottom:0.5rem; }
.upload-head { font-family:'Syne',sans-serif; font-size:1.1rem; font-weight:700; margin-bottom:0.35rem; }
.upload-sub { color:var(--muted); font-size:0.8rem; line-height:1.6; }
.upload-format {
  font-family:'DM Mono',monospace; font-size:0.68rem; color:var(--red);
  margin-top:0.5rem; background:var(--red-bg); display:inline-block;
  padding:0.28rem 0.7rem; border-radius:6px;
}
.upload-bar { margin-top:1rem; height:2px; background:var(--border); border-radius:2px; overflow:hidden; }
.upload-bar-fill { height:100%; background:linear-gradient(90deg,var(--red),#e74c3c); border-radius:2px; animation:loadbar 1.4s ease-in-out infinite; }
@keyframes loadbar { 0%{width:0;opacity:1} 80%{width:90%;opacity:1} 100%{width:100%;opacity:0} }

/* ── MASTERY SESSION ── */
.session-shell { max-width:760px; margin:0 auto; padding:2rem 2rem 6rem; }
.session-topbar { display:flex; align-items:center; justify-content:space-between; margin-bottom:2rem; gap:1rem; flex-wrap:wrap; }
.session-info-label { font-family:'DM Mono',monospace; font-size:0.63rem; color:var(--red); letter-spacing:0.14em; text-transform:uppercase; margin-bottom:0.25rem; }
.session-info-title { font-family:'Syne',sans-serif; font-size:1.15rem; font-weight:700; }

/* HUD */
.hud { display:grid; grid-template-columns:repeat(4,1fr); gap:0.75rem; margin-bottom:1.75rem; }
.hud-cell { background:var(--bg4); border:1px solid var(--border); border-radius:12px; padding:0.85rem 0.6rem; text-align:center; }
.hud-val { font-family:'Syne',sans-serif; font-size:1.75rem; font-weight:800; line-height:1; }
.hud-val.g { color:var(--green); } .hud-val.r { color:var(--red); }
.hud-val.a { color:var(--amber); } .hud-val.t { color:var(--teal); }
.hud-lbl { font-size:0.58rem; color:var(--muted); text-transform:uppercase; letter-spacing:0.12em; margin-top:0.3rem; font-family:'DM Mono',monospace; }

/* PROG */
.prog-wrap { margin-bottom:1.75rem; }
.prog-bar { height:4px; background:var(--border); border-radius:2px; overflow:hidden; }
.prog-fill { height:100%; background:linear-gradient(90deg,var(--red),#e84c3c); border-radius:2px; transition:width 0.4s ease; }
.prog-label { font-family:'DM Mono',monospace; font-size:0.62rem; color:var(--muted); margin-top:0.45rem; display:flex; justify-content:space-between; }

/* QUESTION CARD */
.qcard {
  background:var(--bg4); border:1.5px solid var(--border2); border-radius:20px;
  padding:2rem 2.25rem; box-shadow:var(--shadow); animation:qin 0.3s ease;
}
@keyframes qin { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
.q-num-row {
  display:flex; align-items:center; justify-content:space-between;
  margin-bottom:1.25rem; gap:0.5rem; flex-wrap:wrap;
}
.q-num { font-family:'DM Mono',monospace; font-size:0.63rem; letter-spacing:0.16em; text-transform:uppercase; color:var(--muted); display:flex; align-items:center; gap:0.6rem; }
.retry-badge { padding:0.12rem 0.5rem; border-radius:5px; font-size:0.6rem; background:var(--red-bg); color:var(--red); border:1px solid var(--red-bdr); }

/* PER-QUESTION SCORE PIPS */
.q-score-pips { display:flex; align-items:center; gap:0.35rem; }
.q-score-label { font-family:'DM Mono',monospace; font-size:0.58rem; color:var(--muted); letter-spacing:0.1em; margin-right:0.1rem; }
.pip-row { display:flex; gap:3px; }
.pip {
  width:14px; height:6px; border-radius:3px;
  background:var(--pip-empty); transition:background 0.25s, transform 0.18s;
}
.pip.filled { background:var(--green); }
.pip.newly-filled { background:var(--green); transform:scaleY(1.4); }
.pip.mastered-pip { background:var(--gold); }

.q-text { background:var(--bg2); border-left:3px solid var(--red); border-radius:0 12px 12px 0; padding:1.2rem 1.5rem; margin-bottom:1.75rem; font-family:'DM Sans',sans-serif; font-size:1.05rem; line-height:1.72; color:var(--ink); }

/* OPTIONS */
.opts { display:flex; flex-direction:column; gap:0.6rem; }
.opt {
  width:100%; text-align:left; padding:0.9rem 1.1rem; border-radius:12px;
  border:1.5px solid var(--border); background:var(--bg3);
  color:var(--ink2); font-family:'DM Sans',sans-serif; font-size:0.88rem; font-weight:400;
  cursor:pointer; transition:all 0.16s; display:flex; align-items:center; gap:0.85rem;
}
.opt:hover:not(:disabled) { border-color:var(--red); background:var(--red-bg); }
.opt:disabled { cursor:default; }
.opt.correct { border-color:var(--green); background:var(--green-bg); color:var(--green); font-weight:600; }
.opt.wrong   { border-color:var(--red); background:var(--red-bg); color:var(--red); }
.opt-key {
  width:28px; height:28px; border-radius:7px; flex-shrink:0;
  display:flex; align-items:center; justify-content:center;
  font-family:'DM Mono',monospace; font-size:0.7rem; font-weight:500;
  background:var(--bg4); border:1px solid var(--border); transition:all 0.16s;
}
.opt.correct .opt-key { background:var(--green); color:#fff; border-color:var(--green); }
.opt.wrong   .opt-key { background:var(--red); color:#fff; border-color:var(--red); }
.opt:hover:not(:disabled) .opt-key { background:var(--red); color:#fff; border-color:var(--red); }

/* SOLUTION BOX */
.solution-box { margin-top:1.25rem; border-radius:14px; overflow:hidden; animation:qin 0.22s ease; }
.solution-head { display:flex; align-items:center; gap:0.5rem; padding:0.7rem 1.1rem; font-family:'DM Mono',monospace; font-size:0.66rem; letter-spacing:0.12em; text-transform:uppercase; font-weight:500; }
.solution-head.ok { background:var(--green-bg); color:var(--green); border:1px solid var(--green-bdr); border-bottom:none; border-radius:14px 14px 0 0; }
.solution-head.no { background:var(--red-bg); color:var(--red); border:1px solid var(--red-bdr); border-bottom:none; border-radius:14px 14px 0 0; }
.solution-body { padding:1rem 1.1rem; font-size:0.86rem; line-height:1.65; color:var(--ink2); border:1px solid; border-top:none; border-radius:0 0 14px 14px; }
.solution-body.ok { border-color:var(--green-bdr); background:var(--green-bg); }
.solution-body.no { border-color:var(--red-bdr); background:var(--red-bg); }
.solution-answer { margin-top:0.5rem; font-family:'DM Mono',monospace; font-size:0.78rem; color:var(--green); background:rgba(26,122,74,0.1); padding:0.28rem 0.6rem; border-radius:6px; display:inline-block; }

/* MASTERY FLASH BADGE */
.mastery-flash {
  display:inline-flex; align-items:center; gap:0.4rem;
  padding:0.3rem 0.75rem; border-radius:10px;
  font-family:'DM Mono',monospace; font-size:0.65rem; letter-spacing:0.1em;
  background:var(--gold-bg); color:var(--gold); border:1px solid rgba(184,134,11,0.3);
  animation:pop 0.4s cubic-bezier(0.175,0.885,0.32,1.275);
}
[data-theme="dark"] .mastery-flash { border-color:rgba(255,215,0,0.25); }
@keyframes pop { from{transform:scale(0.5);opacity:0} to{transform:scale(1);opacity:1} }

.next-row { display:flex; justify-content:flex-end; align-items:center; margin-top:1.5rem; gap:0.75rem; flex-wrap:wrap; }
.score-nudge { font-family:'DM Mono',monospace; font-size:0.7rem; color:var(--muted); }
.score-nudge span { color:var(--green); font-weight:600; }

/* ── RESULTS ── */
.results-shell { max-width:680px; margin:0 auto; padding:3rem 2rem 6rem; text-align:center; }
.results-label { font-family:'DM Mono',monospace; font-size:0.63rem; letter-spacing:0.22em; text-transform:uppercase; color:var(--muted); margin-bottom:1rem; }
.results-score { font-family:'Syne',sans-serif; font-size:5.5rem; font-weight:800; line-height:1; color:var(--red); }
.results-grade { font-size:1rem; color:var(--muted); margin:0.5rem 0 2rem; font-style:italic; }
.results-grid { display:flex; gap:1rem; justify-content:center; flex-wrap:wrap; margin-bottom:2rem; }
.res-box { background:var(--bg4); border:1px solid var(--border2); border-radius:14px; padding:1.2rem 2rem; min-width:110px; }
.res-val { font-family:'Syne',sans-serif; font-size:2.2rem; font-weight:800; }
.res-lbl { font-size:0.64rem; color:var(--muted); text-transform:uppercase; letter-spacing:0.1em; margin-top:0.2rem; font-family:'DM Mono',monospace; }
.results-actions { display:flex; gap:0.75rem; justify-content:center; flex-wrap:wrap; margin-top:2rem; }
.all-mastered-box {
  background:var(--gold-bg); border:2px solid rgba(184,134,11,0.3);
  border-radius:20px; padding:2.5rem 2rem; margin-bottom:2.5rem;
  animation:pop 0.5s cubic-bezier(0.175,0.885,0.32,1.275);
}
[data-theme="dark"] .all-mastered-box { border-color:rgba(255,215,0,0.2); }
.all-mastered-star { font-size:3.5rem; margin-bottom:0.75rem; }
.all-mastered-title { font-family:'Syne',sans-serif; font-size:1.6rem; font-weight:800; color:var(--gold); margin-bottom:0.5rem; }
.all-mastered-sub { color:var(--muted); font-size:0.88rem; }

/* SESSION SUMMARY QUESTION LIST */
.summary-list { text-align:left; margin-top:2rem; }
.summary-item { display:flex; align-items:center; gap:0.75rem; padding:0.6rem 0; border-bottom:1px solid var(--border); font-size:0.82rem; }
.summary-item:last-child { border-bottom:none; }
.summary-q { flex:1; color:var(--ink2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.summary-result { flex-shrink:0; font-family:'DM Mono',monospace; font-size:0.68rem; }
.summary-result.ok { color:var(--green); }
.summary-result.no { color:var(--red); }
.summary-pips { display:flex; gap:2px; flex-shrink:0; }
.sum-pip { width:10px; height:5px; border-radius:2px; background:var(--pip-empty); }
.sum-pip.filled { background:var(--green); }
.sum-pip.gold   { background:var(--gold); }

/* MISC */
.spin { width:32px; height:32px; border:2px solid var(--border2); border-top-color:var(--red); border-radius:50%; animation:rotate 0.7s linear infinite; margin:3rem auto; }
@keyframes rotate { to{transform:rotate(360deg)} }
.empty { text-align:center; padding:4rem 2rem; }
.empty-glyph { font-size:2.8rem; opacity:0.3; margin-bottom:1rem; }
.empty-head { font-family:'Syne',sans-serif; font-size:1.2rem; opacity:0.35; margin-bottom:0.4rem; }
.empty-sub { color:var(--muted); font-size:0.82rem; }

/* TOAST */
.toast-wrap { position:fixed; bottom:2rem; right:2rem; z-index:1000; display:flex; flex-direction:column; gap:0.5rem; }
.toast { background:var(--bg4); border:1px solid var(--border2); border-radius:12px; padding:0.8rem 1.1rem; font-size:0.8rem; max-width:300px; box-shadow:var(--shadow); animation:toastin 0.3s ease; display:flex; align-items:center; gap:0.6rem; }
.toast.success { border-left:3px solid var(--green); }
.toast.error   { border-left:3px solid var(--red); }
.toast.info    { border-left:3px solid var(--teal); }
@keyframes toastin { from{opacity:0;transform:translateX(16px)} to{opacity:1;transform:translateX(0)} }

/* MODAL */
.modal-overlay { position:fixed; inset:0; background:rgba(24,21,15,0.5); z-index:500; display:flex; align-items:center; justify-content:center; padding:1rem; backdrop-filter:blur(4px); }
.modal-box { background:var(--bg4); border:1.5px solid var(--border2); border-radius:18px; padding:2rem; max-width:480px; width:100%; box-shadow:0 24px 64px rgba(24,21,15,0.2); }
.modal-title { font-family:'Syne',sans-serif; font-size:1.25rem; font-weight:700; margin-bottom:0.3rem; }
.modal-sub { color:var(--muted); font-size:0.82rem; margin-bottom:1.25rem; }
.modal-actions { display:flex; gap:0.75rem; margin-top:1.25rem; }
.name-input { width:100%; background:var(--bg2); border:1.5px solid var(--border2); border-radius:9px; color:var(--ink); font-family:'DM Sans',sans-serif; font-size:0.95rem; padding:0.75rem 1rem; outline:none; margin-bottom:1.2rem; transition:border-color 0.18s; }
.name-input:focus { border-color:var(--red); }
.subject-bar { display:flex; gap:0.6rem; align-items:center; flex-wrap:wrap; margin-bottom:2rem; padding:1rem 1.2rem; background:var(--bg4); border:1px solid var(--border2); border-radius:14px; }
.subject-bar-label { font-family:'DM Mono',monospace; font-size:0.62rem; letter-spacing:0.15em; text-transform:uppercase; color:var(--muted); white-space:nowrap; }
.subject-select { padding:0.5rem 0.9rem; border:1.5px solid var(--border2); border-radius:8px; background:var(--bg2); color:var(--ink); font-family:'DM Sans',sans-serif; font-size:0.88rem; font-weight:600; outline:none; cursor:pointer; flex:1; min-width:130px; transition:border-color 0.18s; }
.subject-select:focus { border-color:var(--red); }
.subject-input { padding:0.5rem 0.85rem; border:1.5px solid var(--border2); border-radius:8px; background:var(--bg4); color:var(--ink); font-family:'DM Sans',sans-serif; font-size:0.85rem; outline:none; flex:1; min-width:120px; transition:border-color 0.18s; }
.subject-input:focus { border-color:var(--red); }
.subject-input::placeholder { color:var(--muted2); }

@media(max-width:600px){
  .hud{grid-template-columns:repeat(2,1fr)}
  .results-score{font-size:4rem}
  .topbar,.page,.session-shell{padding-left:1rem;padding-right:1rem}
  .breadcrumb{padding-left:1rem;padding-right:1rem}
  .subj-grid,.topic-grid{grid-template-columns:1fr}
  .all-mastered-title{font-size:1.3rem}
}
`;

// ============================================================
// SCORE PIPS COMPONENT
// ============================================================
function ScorePips({ score, newlyGained = false }) {
  return (
    <div className="q-score-pips">
      <span className="q-score-label">SCORE</span>
      <div className="pip-row">
        {Array.from({ length: MASTERY_THRESHOLD }, (_, i) => {
          const isFilled = i < score;
          const isGold   = score >= MASTERY_THRESHOLD;
          const isNew    = newlyGained && i === score - 1;
          return (
            <div
              key={i}
              className={`pip ${isGold ? "mastered-pip" : isFilled ? (isNew ? "newly-filled" : "filled") : ""}`}
            />
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// MASTERY SESSION ENGINE
// ============================================================
const LETTERS = ["A", "B", "C", "D"];

function MasterySession({ subject, fileName, allQuestions, onExit, toast }) {
  const topicTitle = fileName.replace(/\.csv$/i, "");

  const [session,   setSession]   = useState(null);
  const [qi,        setQi]        = useState(0);
  const [selected,  setSelected]  = useState(null);
  const [answered,  setAnswered]  = useState(false);
  // scores mirror ScoreStore cache for rendering — updated after each answer
  const [scores,    setScores]    = useState({});
  const [gained,    setGained]    = useState(null);
  const [results,   setResults]   = useState([]);
  const [done,      setDone]      = useState(false);
  const [roundCorrect, setRoundCorrect] = useState(0);
  const [roundWrong,   setRoundWrong]   = useState(0);
  const [retries,   setRetries]   = useState(new Set());
  const [saving,    setSaving]    = useState(false);
  const queue    = useRef([]);
  const pickLock = useRef(false);  // instant guard — prevents double-fire before state settles

  // Seed ScoreStore cache from the questions already loaded (score field from DB)
  useEffect(() => {
    ScoreStore.seed(allQuestions);
    const initialScores = ScoreStore.getAll(allQuestions.map(q => q.id));
    setScores(initialScores);
    startNewRound();
  }, []);

  function startNewRound() {
    const { questions, allMastered } = buildSession(allQuestions);
    if (allMastered) {
      setSession({ questions: [], allMastered: true });
      setDone(true);
      return;
    }
    queue.current = questions;
    setSession({ questions, allMastered: false });
    setQi(0); setSelected(null); setAnswered(false);
    setResults([]); setRoundCorrect(0); setRoundWrong(0);
    setRetries(new Set()); setGained(null); setDone(false);
    pickLock.current = false;
  }

  if (!session) return <div className="spin" />;

  if (session.allMastered || (done && session.allMastered)) {
    const ids = allQuestions.map(q => q.id);
    return (
      <div className="session-shell">
        <div className="session-topbar">
          <div>
            <div className="session-info-label">{subject} › {topicTitle}</div>
            <div className="session-info-title">Mastery Complete</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onExit}>← Topics</button>
        </div>
        <div className="all-mastered-box">
          <div className="all-mastered-star">🌟</div>
          <div className="all-mastered-title">All Questions Mastered!</div>
          <div className="all-mastered-sub">You've scored {MASTERY_THRESHOLD}/5 on every question in this topic.</div>
        </div>
        <div className="results-actions">
          <button className="btn btn-danger btn-sm" onClick={async () => {
            if (!window.confirm("Reset all mastery scores for this topic?")) return;
            setSaving(true);
            await ScoreStore.reset(ids);
            setSaving(false);
            setScores(ScoreStore.getAll(ids));
            toast("Scores reset!", "info");
            startNewRound();
          }} disabled={saving}>
            {saving ? "Resetting…" : "↺ Reset & Restart"}
          </button>
          <button className="btn btn-ghost" onClick={onExit}>← Back to Topics</button>
        </div>
      </div>
    );
  }

  if (done) {
    const pct = roundCorrect + roundWrong > 0
      ? Math.round((roundCorrect / (roundCorrect + roundWrong)) * 100) : 100;

    const grade =
      pct >= 90 ? "Excellent round! Keep it up. 🏆" :
      pct >= 70 ? "Good work — almost there! 🌟" :
      pct >= 50 ? "Solid effort — review the wrong ones. 📖" :
      "Keep practising — repetition builds memory. ✍️";

    const ids = allQuestions.map(q => q.id);
    const masteredNow   = ScoreStore.getMasteredCount(ids);
    const unmasteredNow = ids.length - masteredNow;

    return (
      <div className="session-shell">
        <div className="session-topbar">
          <div>
            <div className="session-info-label">{subject} › {topicTitle}</div>
            <div className="session-info-title">Round Complete</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onExit}>← Topics</button>
        </div>

        <div style={{textAlign:"center",padding:"1.5rem 0 0"}}>
          <div className="results-label">Round Score</div>
          <div className="results-score">{pct}%</div>
          <div className="results-grade">{grade}</div>
        </div>

        <div className="results-grid" style={{marginTop:"1.5rem"}}>
          <div className="res-box"><div className="res-val" style={{color:"var(--green)"}}>{roundCorrect}</div><div className="res-lbl">Correct</div></div>
          <div className="res-box"><div className="res-val" style={{color:"var(--red)"}}>{roundWrong}</div><div className="res-lbl">Wrong</div></div>
          <div className="res-box"><div className="res-val" style={{color:"var(--gold)"}}>{masteredNow}</div><div className="res-lbl">Mastered</div></div>
          <div className="res-box"><div className="res-val" style={{color:"var(--teal)"}}>{unmasteredNow}</div><div className="res-lbl">Remaining</div></div>
        </div>

        <div className="summary-list">
          <div style={{fontFamily:"DM Mono,monospace",fontSize:"0.62rem",letterSpacing:"0.15em",textTransform:"uppercase",color:"var(--muted)",marginBottom:"0.75rem"}}>
            This Round
          </div>
          {results.map((r, i) => {
            const sc = scores[r.id] ?? 0;
            const isMastered = sc >= MASTERY_THRESHOLD;
            return (
              <div className="summary-item" key={i}>
                <div className="summary-q">{r.question.length > 60 ? r.question.slice(0, 60) + "…" : r.question}</div>
                <div className={`summary-result ${r.correct ? "ok" : "no"}`}>{r.correct ? "✓" : "✗"}</div>
                <div className="summary-pips">
                  {Array.from({length: MASTERY_THRESHOLD}, (_, pi) => (
                    <div key={pi} className={`sum-pip ${pi < sc ? (isMastered ? "gold" : "filled") : ""}`} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="results-actions">
          {unmasteredNow > 0 ? (
            <button className="btn btn-red" onClick={() => startNewRound()}>
              Next Round ({unmasteredNow} left) →
            </button>
          ) : (
            <button className="btn btn-green" onClick={() => startNewRound()}>
              🌟 All Mastered! Restart →
            </button>
          )}
          <button className="btn btn-ghost" onClick={onExit}>← Topics</button>
          {masteredNow > 0 && (
            <button className="btn btn-danger btn-xs" onClick={async () => {
              if (!window.confirm("Reset all mastery scores?")) return;
              const ids2 = allQuestions.map(q => q.id);
              setSaving(true);
              await ScoreStore.reset(ids2);
              setSaving(false);
              setScores(ScoreStore.getAll(ids2));
              toast("Scores reset!", "info");
              startNewRound();
            }} disabled={saving}>
              {saving ? "…" : "↺ Reset"}
            </button>
          )}
        </div>
      </div>
    );
  }

  const qs = queue.current;
  const q  = qs[qi];
  if (!q) return null;

  const currentScore = scores[q.id] ?? 0;
  const isRetry    = retries.has(q.id);
  const isCorrect  = answered && selected === q.correct;
  const isMastered = answered && isCorrect && (currentScore + 1) >= MASTERY_THRESHOLD;
  const newScore   = answered
    ? (isCorrect ? Math.min(currentScore + 1, MASTERY_THRESHOLD) : Math.max(currentScore - 1, 0))
    : currentScore;
  const prog = (qi / qs.length) * 100;

  const pick = async (opt) => {
    if (pickLock.current || saving) return;  // ref check is instant, no async gap
    pickLock.current = true;
    setSelected(opt);
    setAnswered(true);
    setSaving(true);

    const correct = opt === q.correct;
    if (correct) {
      const ns = await ScoreStore.increment(q.id);
      setScores(prev => ({ ...prev, [q.id]: ns }));
      setGained(q.id);
      setRoundCorrect(c => c + 1);
      setRetries(s => { const n = new Set(s); n.delete(q.id); return n; });
    } else {
      const ns = await ScoreStore.decrement(q.id);
      setScores(prev => ({ ...prev, [q.id]: ns }));
      if (!isRetry) setRoundWrong(w => w + 1);
      // Re-insert this question 2–4 positions ahead in the queue
      const rest = qs.slice(qi + 1);
      const at   = Math.min(2 + Math.floor(Math.random() * 3), rest.length);
      rest.splice(at, 0, { ...q, options: shuffle([q.optionA, q.optionB, q.optionC, q.optionD].filter(Boolean)) });
      queue.current = [...qs.slice(0, qi + 1), ...rest];
      setRetries(s => new Set([...s, q.id]));
    }
    setResults(prev => [...prev, { id: q.id, question: q.question, correct }]);
    setSaving(false);
  };

  const next = () => {
    pickLock.current = false;
    const nextQi = qi + 1;
    if (nextQi >= queue.current.length) {
      setDone(true);
    } else {
      setQi(nextQi);
      setSelected(null);
      setAnswered(false);
      setGained(null);
    }
  };

  return (
    <div className="session-shell">
      <div className="session-topbar">
        <div>
          <div className="session-info-label">{subject} › {topicTitle}</div>
          <div className="session-info-title">Mastery Mode</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onExit}>Exit ✕</button>
      </div>

      <div className="hud">
        <div className="hud-cell"><div className="hud-val g">{roundCorrect}</div><div className="hud-lbl">Correct</div></div>
        <div className="hud-cell"><div className="hud-val r">{roundWrong}</div><div className="hud-lbl">Wrong</div></div>
        <div className="hud-cell"><div className="hud-val a">{Math.max(0, qs.length - qi - 1)}</div><div className="hud-lbl">Left</div></div>
        <div className="hud-cell"><div className="hud-val t">{ScoreStore.getMasteredCount(allQuestions.map(q => q.id))}</div><div className="hud-lbl">Mastered</div></div>
      </div>

      <div className="prog-wrap">
        <div className="prog-bar"><div className="prog-fill" style={{ width: `${prog}%` }} /></div>
        <div className="prog-label">
          <span>Question {qi + 1} of {qs.length}</span>
          <span>{Math.round(prog)}%</span>
        </div>
      </div>

      <div className="qcard">
        <div className="q-num-row">
          <div className="q-num">
            Q{qi + 1}
            {isRetry && <span className="retry-badge">↩ Retry</span>}
            {saving && answered && <span style={{fontFamily:"DM Mono,monospace",fontSize:"0.6rem",color:"var(--muted)"}}>saving…</span>}
          </div>
          <ScorePips
            score={answered ? newScore : currentScore}
            newlyGained={answered && isCorrect && gained === q.id}
          />
        </div>

        <div className="q-text">{q.question}</div>

        <div className="opts">
          {q.options.map((opt, i) => {
            let cls = "";
            if (answered) {
              if (opt === q.correct) cls = "correct";
              else if (opt === selected) cls = "wrong";
            }
            return (
              <button key={i} className={`opt ${cls}`} onClick={() => pick(opt)} disabled={answered || saving}>
                <span className="opt-key">{LETTERS[i]}</span>
                {opt}
              </button>
            );
          })}
        </div>

        {answered && (
          <div className="solution-box">
            <div className={`solution-head ${isCorrect ? "ok" : "no"}`}>
              {isCorrect ? "✓ Correct" : "✗ Incorrect"}
              {isMastered && <span className="mastery-flash" style={{marginLeft:"auto"}}>⭐ Mastered!</span>}
            </div>
            <div className={`solution-body ${isCorrect ? "ok" : "no"}`}>
              {!isCorrect && (
                <div>Correct answer: <span className="solution-answer">{q.correct}</span></div>
              )}
              {q.solution && (
                <div style={{ marginTop: isCorrect ? 0 : "0.65rem", color: "var(--ink2)" }}>
                  <strong style={{ fontFamily: "DM Mono,monospace", fontSize: "0.68rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)" }}>
                    Explanation
                  </strong>
                  <p style={{ marginTop: "0.3rem" }}>{q.solution}</p>
                </div>
              )}
              <div className="score-nudge" style={{ marginTop: "0.5rem" }}>
                Score: <span>{newScore}/{MASTERY_THRESHOLD}</span>
                {" — "}
                {newScore >= MASTERY_THRESHOLD ? "🌟 Mastered!" : `${MASTERY_THRESHOLD - newScore} more to master`}
              </div>
            </div>
          </div>
        )}

        <div className="next-row">
          {answered && (
            <button className="btn btn-red" onClick={next}>
              {qi + 1 >= queue.current.length ? "See Results →" : "Next →"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// TOPIC LIST VIEW
// ============================================================
function TopicListView({ subject, onSelectTopic, onBack, onUpload, toast }) {
  const [topics,    setTopics]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [uploading, setUploading] = useState(false);
  const [drag,      setDrag]      = useState(false);
  const [qCounts,   setQCounts]   = useState({}); // fileName -> { total, mastered }
  const fileRef = useRef();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const t = await DB.getTopicsForSubject(subject);
      setTopics(t);
      // For each topic, load questions (which include score from DB) and compute mastery
      const counts = {};
      for (const fileName of t) {
        const qs = await DB.getQuestionsForTopic(subject, fileName);
        const mastered = qs.filter(q => (q.score ?? 0) >= MASTERY_THRESHOLD).length;
        counts[fileName] = { total: qs.length, mastered };
      }
      setQCounts(counts);
    } catch { toast("Error loading topics", "error"); }
    setLoading(false);
  }, [subject]);

  useEffect(() => { load(); }, [load]);

  const handleFilePick = async (file) => {
    if (!file?.name.endsWith(".csv")) { toast("Please upload a .csv file", "error"); return; }
    setUploading(true);
    try {
      await DB.upload(file, subject);
      toast(`"${file.name}" uploaded!`, "success");
      await new Promise(r => setTimeout(r, 400));
      await load();
    } catch (err) { toast("Upload failed: " + err.message, "error"); }
    setUploading(false);
  };

  const handleDelete = async (e, fileName) => {
    e.stopPropagation();
    if (!window.confirm(`Delete topic "${fileName.replace(/\.csv$/i,"")}"?`)) return;
    await DB.deleteTopic(fileName);
    toast(`Deleted "${fileName}"`, "info");
    setTopics(prev => prev.filter(t => t !== fileName));
  };

  return (
    <div className="page">
      {/* Upload */}
      <div
        className={`upload-area ${drag ? "drag" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); handleFilePick(e.dataTransfer.files[0]); }}
        onClick={() => !uploading && fileRef.current?.click()}
      >
        <input ref={fileRef} type="file" accept=".csv" onChange={(e) => { handleFilePick(e.target.files[0]); e.target.value = ""; }} />
        <div className="upload-glyph">{uploading ? "⏳" : "📄"}</div>
        <div className="upload-head">{uploading ? "Uploading…" : "Drop CSV to add a topic"}</div>
        <div className="upload-sub">One question per row — comma separated</div>
        <div className="upload-format">Question , Opt A , Opt B , Opt C , Opt D , Correct , Solution</div>
        {uploading && <div className="upload-bar"><div className="upload-bar-fill" /></div>}
      </div>

      {/* Topic list */}
      <div className="sect-head">
        <div className="sect-line" />
        <span className="sect-label">Topics in {subject}</span>
        <span className="sect-badge teal">{topics.length}</span>
        <div className="sect-line" />
      </div>

      {loading ? (
        <div className="spin" />
      ) : topics.length === 0 ? (
        <div className="empty">
          <div className="empty-glyph">📂</div>
          <div className="empty-head">No topics yet</div>
          <div className="empty-sub">Upload a CSV to create the first topic in {subject}</div>
        </div>
      ) : (
        <div className="topic-grid">
          {topics.map((fileName) => {
            const counts = qCounts[fileName] || { total: 0, mastered: 0 };
            const pct = counts.total ? (counts.mastered / counts.total) * 100 : 0;
            const allMastered = counts.total > 0 && counts.mastered >= counts.total;
            return (
              <div
                key={fileName}
                className={`topic-card ${allMastered ? "mastered" : ""}`}
                onClick={() => onSelectTopic(fileName)}
              >
                <div className="topic-card-top">
                  <div className="topic-name">{fileName.replace(/\.csv$/i, "")}</div>
                  <span className="topic-count-badge">{counts.total}Q</span>
                </div>

                <div className="topic-progress-wrap">
                  <div className="topic-progress-bar-bg">
                    <div className={`topic-progress-bar-fill ${allMastered ? "full" : ""}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="topic-progress-text">
                    {counts.mastered} / {counts.total} mastered ({Math.round(pct)}%)
                  </div>
                </div>

                <div className="topic-actions">
                  <button
                    className={`btn ${allMastered ? "btn-green" : "btn-red"} btn-sm`}
                    onClick={(e) => { e.stopPropagation(); onSelectTopic(fileName); }}
                  >
                    {allMastered ? "🌟 Review" : "Study →"}
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={(e) => handleDelete(e, fileName)}>
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// SUBJECT LIST VIEW
// ============================================================
function SubjectListView({ subjects, onSelect, loading }) {
  if (loading) return <div className="page"><div className="spin" /></div>;
  return (
    <div className="page">
      <div className="sect-head">
        <div className="sect-line" />
        <span className="sect-label">All Subjects</span>
        <span className="sect-badge">{subjects.length}</span>
        <div className="sect-line" />
      </div>
      {subjects.length === 0 ? (
        <div className="empty">
          <div className="empty-glyph">📚</div>
          <div className="empty-head">No subjects yet</div>
          <div className="empty-sub">Add a subject and upload a CSV to get started</div>
        </div>
      ) : (
        <div className="subj-grid">
          {subjects.map(s => (
            <div key={s} className="subj-card" onClick={() => onSelect(s)}>
              <div className="subj-icon">📂</div>
              <div className="subj-name">{s.charAt(0).toUpperCase() + s.slice(1)}</div>
              <div className="subj-meta">Click to browse topics →</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// APP ROOT
// ============================================================
export default function App() {
  const [darkMode,  setDarkMode]  = useState(false);
  const [subjects,  setSubjects]  = useState([]);
  const [subjLoad,  setSubjLoad]  = useState(true);
  const [newSubject,setNewSubject]= useState("");
  const [addingSubj,setAddingSubj]= useState(false);

  // Navigation state
  const [view,      setView]      = useState("subjects");  // "subjects" | "topics" | "session"
  const [currentSubject, setCurrentSubject] = useState(null);
  const [currentFileName, setCurrentFileName] = useState(null);
  const [sessionData, setSessionData] = useState(null);   // { allQuestions }

  const { toasts, add: toast } = useToast();

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  const loadSubjects = useCallback(async () => {
    setSubjLoad(true);
    try {
      const subs = await DB.getSubjects();
      setSubjects(subs.length ? subs : ["general"]);
    } catch { setSubjects(["general"]); }
    setSubjLoad(false);
  }, []);

  useEffect(() => { loadSubjects(); }, [loadSubjects]);

  const addSubject = async () => {
    const t = newSubject.trim().toLowerCase();
    if (!t) return;
    if (subjects.includes(t)) { toast("Subject already exists", "info"); setNewSubject(""); return; }
    setAddingSubj(true);
    try {
      await DB.addSubjectSeed(t);
      await loadSubjects();
      setNewSubject("");
      toast(`Subject "${t}" added!`, "success");
    } catch { toast("Failed to add subject", "error"); }
    setAddingSubj(false);
  };

  const handleSelectSubject = (s) => {
    setCurrentSubject(s);
    setView("topics");
  };

  const handleSelectTopic = async (fileName) => {
    toast("Loading questions…", "info");
    try {
      const qs = await DB.getQuestionsForTopic(currentSubject, fileName);
      if (!qs.length) { toast("No questions found in this topic", "error"); return; }
      setCurrentFileName(fileName);
      setSessionData({ allQuestions: qs });
      setView("session");
    } catch { toast("Failed to load topic", "error"); }
  };

  // Breadcrumb
  const renderBreadcrumb = () => {
    if (view === "subjects") return null;
    return (
      <div className="breadcrumb">
        <span className="bc-item clickable" onClick={() => setView("subjects")}>All Subjects</span>
        {view !== "subjects" && <span className="bc-sep">›</span>}
        {view === "topics" && <span className="bc-item active">{currentSubject}</span>}
        {view === "session" && (
          <>
            <span className="bc-item clickable" onClick={() => setView("topics")}>{currentSubject}</span>
            <span className="bc-sep">›</span>
            <span className="bc-item active">{currentFileName?.replace(/\.csv$/i, "")}</span>
          </>
        )}
      </div>
    );
  };

  return (
    <>
      <style>{STYLES}</style>
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        {/* TOPBAR */}
        <header className="topbar">
          <div className="logo" style={{ cursor: "pointer" }} onClick={() => setView("subjects")}>
            <div className="logo-dot" />
            GKGS
            <span className="logo-sub">Mastery</span>
          </div>
          <div className="topbar-right">
            {/* Add subject inline */}
            {view === "subjects" && (
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                <input
                  className="subject-input"
                  style={{ padding: "0.3rem 0.65rem", fontSize: "0.78rem", minWidth: 140 }}
                  value={newSubject}
                  onChange={e => setNewSubject(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addSubject()}
                  placeholder="New subject…"
                />
                <button className="btn btn-red btn-sm" onClick={addSubject} disabled={addingSubj || !newSubject.trim()}>
                  {addingSubj ? "…" : "+ Subject"}
                </button>
              </div>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setDarkMode(d => !d)}>
              {darkMode ? "☀️" : "🌙"}
            </button>
            <div className="status-pill"><div className="status-dot" />Supabase</div>
          </div>
        </header>

        {renderBreadcrumb()}

        {/* VIEWS */}
        {view === "subjects" && (
          <SubjectListView
            subjects={subjects}
            onSelect={handleSelectSubject}
            loading={subjLoad}
          />
        )}

        {view === "topics" && currentSubject && (
          <TopicListView
            subject={currentSubject}
            onSelectTopic={handleSelectTopic}
            onBack={() => setView("subjects")}
            toast={toast}
          />
        )}

        {view === "session" && sessionData && (
          <MasterySession
            subject={currentSubject}
            fileName={currentFileName}
            allQuestions={sessionData.allQuestions}
            onExit={() => setView("topics")}
            toast={toast}
          />
        )}
      </div>

      <div className="toast-wrap">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            {t.type === "success" ? "✅" : t.type === "error" ? "❌" : "ℹ️"} {t.msg}
          </div>
        ))}
      </div>
    </>
  );
}
