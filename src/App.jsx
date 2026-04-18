import { useState, useEffect, useCallback, useRef } from "react";

// ============================================================
// SUPABASE CONFIG
// ============================================================
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

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

  async listAll(subject) {
    const base = subject
      ? `${SUPABASE_URL}/rest/v1/gkgs?select=file_name&subject=eq.${encodeURIComponent(subject)}&file_name=neq.__subject__`
      : `${SUPABASE_URL}/rest/v1/gkgs?select=file_name&file_name=neq.__subject__`;

    const PAGE = 1000;
    let from = 0;
    let allRows = [];

    while (true) {
      const res = await fetch(base, {
        headers: this._h({
          Prefer: "return=representation",
          Range: `${from}-${from + PAGE - 1}`,
          "Range-Unit": "items",
        }),
      });
      if (!res.ok) { console.error("listAll error:", await res.text()); break; }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      allRows = allRows.concat(rows);
      if (rows.length < PAGE) break;
      from += PAGE;
    }

    const unique = [...new Set(
      allRows.map(r => r.file_name?.trim()).filter(Boolean)
    )];

    return unique.map(name => ({ name, size: 0 }));
  },

  async getSubjects() {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/gkgs?select=subject`, {
      headers: this._h(),
    });
    const data = await res.json();
    const unique = [...new Set(
      data.map(d => d.subject).filter(Boolean)
    )];
    return unique;
  },

  // Insert a seed row so the subject persists even with no real files
  async addSubjectSeed(subject) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/gkgs`, {
      method: "POST",
      headers: this._h({ Prefer: "return=minimal" }),
      body: JSON.stringify([{
        file_name: "__subject__",
        subject: subject,
        question: "__seed__",
        option_a: "",
        option_b: "",
        option_c: "",
        option_d: "",
        correct_answer: "",
        solution: null,
      }]),
    });
    return res.ok;
  },

  async upload(file, subject) {
    const text = await file.text();
    const fileName = file.name;

    await fetch(
      `${SUPABASE_URL}/rest/v1/gkgs?file_name=eq.${encodeURIComponent(fileName)}`,
      { method: "DELETE", headers: this._h() }
    );

    let rows = [];
    const lines = text.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      const cols = parseCSVLine(line);
      if (cols.length < 6) continue;
      if (!cols[0] || cols[0].toLowerCase() === "question") continue;

      rows.push({
        file_name: fileName,
        subject: subject || "general",
        question: cols[0],
        option_a: cols[1] || "",
        option_b: cols[2] || "",
        option_c: cols[3] || "",
        option_d: cols[4] || "",
        correct_answer: cols[5] || "",
        solution: cols[6] || null,
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

  async read(fileObj) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/gkgs?file_name=eq.${encodeURIComponent(fileObj.name)}&order=id`,
      { headers: this._h() }
    );
    if (!res.ok) throw new Error(await res.text());
    const rows = await res.json();

    if (!rows.length) return { type: "empty", questions: [], cards: [] };

    const questions = rows.map(r => {
      const rawOptions = [r.option_a, r.option_b, r.option_c, r.option_d].filter(Boolean);
      return {
        id: r.id,
        question: r.question,
        options: shuffle(rawOptions),
        correct: r.correct_answer,
        solution: r.solution,
      };
    });

    return { type: "quiz", questions };
  },

  async delete(fileObj) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/gkgs?file_name=eq.${encodeURIComponent(fileObj.name)}`,
      { method: "DELETE", headers: this._h() }
    );
    return res.ok;
  },

  async deleteQuestion(id) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/gkgs?id=eq.${id}`,
      { method: "DELETE", headers: this._h() }
    );
    return res.ok;
  },

  async rename(oldName, newName) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/gkgs?file_name=eq.${encodeURIComponent(oldName)}`,
      {
        method: "PATCH",
        headers: this._h({ Prefer: "return=minimal" }),
        body: JSON.stringify({ file_name: newName }),
      }
    );
    return res.ok;
  },
};

const Storage = DB;

// ============================================================
// CSV PARSERS
// ============================================================
function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"' && inQuotes) {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
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

const buildQueue = (qs) => shuffle(qs);

// ============================================================
// TOAST
// ============================================================
function useToast() {
  const [toasts, setToasts] = useState([]);
  const add = useCallback((msg, type = "info") => {
    const id = Date.now();
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);
  return { toasts, add };
}

// ============================================================
// STYLES
// ============================================================
const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400;1,700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:       #f5f0e8;
  --bg2:      #ede8df;
  --bg3:      #e4ddd2;
  --bg4:      #faf7f2;
  --ink:      #1c1710;
  --ink2:     #3d3528;
  --muted:    #8a7f6e;
  --muted2:   #b5a992;
  --border:   rgba(28,23,16,0.1);
  --border2:  rgba(28,23,16,0.18);
  --red:      #c0392b;
  --red-bg:   #fdf1ef;
  --red-bdr:  rgba(192,57,43,0.2);
  --green:    #1a7a4a;
  --green-bg: #eef7f2;
  --green-bdr:rgba(26,122,74,0.2);
  --blue:     #1e4d8c;
  --blue-bg:  #edf2fb;
  --blue-bdr: rgba(30,77,140,0.2);
  --amber:    #9a6c00;
  --amber-bg: #fdf8ec;
  --teal:     #0d7377;
  --teal-bg:  #edf7f7;
  --teal-bdr: rgba(13,115,119,0.2);
  --rule:     rgba(28,23,16,0.08);
  font-size: 16px;
}

[data-theme="dark"] {
  --bg:       #0f1115;
  --bg2:      #161a20;
  --bg3:      #1c2128;
  --bg4:      #1e232a;
  --ink:      #f1f3f5;
  --ink2:     #c9d1d9;
  --muted:    #8b949e;
  --muted2:   #6e7681;
  --border:   rgba(255,255,255,0.08);
  --border2:  rgba(255,255,255,0.16);
  --red:      #ff6b6b;
  --red-bg:   rgba(255,107,107,0.08);
  --red-bdr:  rgba(255,107,107,0.25);
  --green:    #3fb950;
  --green-bg: rgba(63,185,80,0.08);
  --green-bdr:rgba(63,185,80,0.25);
  --blue:     #58a6ff;
  --blue-bg:  rgba(88,166,255,0.08);
  --blue-bdr: rgba(88,166,255,0.25);
  --amber:    #e3b341;
  --amber-bg: rgba(227,179,65,0.08);
  --teal:     #2dd4bf;
  --teal-bg:  rgba(45,212,191,0.08);
  --teal-bdr: rgba(45,212,191,0.25);
  --rule:     rgba(255,255,255,0.05);
}

html { scroll-behavior: smooth; }
body {
  background: var(--bg);
  color: var(--ink);
  font-family: 'DM Sans', sans-serif;
  min-height: 100vh;
  overflow-x: hidden;
}
body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image: repeating-linear-gradient(
    transparent, transparent 27px,
    var(--rule) 27px, var(--rule) 28px
  );
  opacity: 0.5;
}
#root { position: relative; z-index: 1; }

.topbar {
  height: 62px;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 2.5rem;
  border-bottom: 2px solid var(--border2);
  background: rgba(245,240,232,0.92);
  backdrop-filter: blur(12px);
  position: sticky; top: 0; z-index: 200;
}
[data-theme="dark"] .topbar { background: rgba(15,17,21,0.92); }
.logo {
  font-family: 'Playfair Display', serif;
  font-size: 1.45rem; font-weight: 900; font-style: italic;
  color: var(--ink); letter-spacing: -0.02em;
  display: flex; align-items: center; gap: 0.5rem;
}
.logo-em {
  color: var(--red); font-style: normal;
  text-decoration: underline; text-decoration-color: var(--red); text-underline-offset: 3px;
}
.topbar-right { display: flex; align-items: center; gap: 0.75rem; }
.cloud-pill {
  display: flex; align-items: center; gap: 0.4rem;
  padding: 0.28rem 0.85rem; border-radius: 100px;
  font-size: 0.68rem; font-family: 'DM Mono', monospace; letter-spacing: 0.05em;
  border: 1px solid rgba(26,122,74,0.3);
  background: rgba(26,122,74,0.07);
  color: var(--green);
}

.mode-tabs {
  display: flex; gap: 0; border-bottom: 2px solid var(--border2);
  padding: 0 2.5rem; background: var(--bg4);
  position: sticky; top: 62px; z-index: 190;
}
.mode-tab {
  padding: 0.85rem 1.4rem; border: none; background: transparent;
  font-family: 'DM Sans', sans-serif; font-size: 0.82rem; font-weight: 600;
  color: var(--muted); cursor: pointer; border-bottom: 2.5px solid transparent;
  margin-bottom: -2px; transition: all 0.18s;
  display: flex; align-items: center; gap: 0.4rem;
}
.mode-tab:hover { color: var(--ink); }
.mode-tab.active { color: var(--ink); border-bottom-color: var(--red); }
.mode-tab.flash.active { border-bottom-color: var(--teal); }

.page { max-width: 1080px; margin: 0 auto; padding: 2.5rem 2rem 6rem; }

.sect {
  display: flex; align-items: center; gap: 0.75rem;
  margin-bottom: 1.2rem;
  font-family: 'DM Mono', monospace;
  font-size: 0.63rem; letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--muted);
}
.sect::before { content: '§'; color: var(--red); font-size: 0.8rem; }
.sect.teal::before { color: var(--teal); }
.sect::after { content:''; flex:1; height:1px; background: var(--border2); }
.sect-count {
  background: rgba(192,57,43,0.08); color: var(--red);
  border: 1px solid rgba(192,57,43,0.2);
  border-radius: 100px; padding: 0.1rem 0.5rem; font-size: 0.62rem;
}
.sect-count.teal { background: var(--teal-bg); color: var(--teal); border-color: var(--teal-bdr); }

.subject-bar {
  display: flex; gap: 0.6rem; align-items: center;
  flex-wrap: wrap; margin-bottom: 2rem;
  padding: 1rem 1.2rem;
  background: var(--bg4);
  border: 1px solid var(--border2);
  border-radius: 14px;
}
.subject-bar-label {
  font-family: 'DM Mono', monospace; font-size: 0.62rem;
  letter-spacing: 0.15em; text-transform: uppercase;
  color: var(--muted); margin-right: 0.25rem; white-space: nowrap;
}
.subject-select {
  padding: 0.55rem 0.9rem;
  border: 1.5px solid var(--border2);
  border-radius: 8px;
  background: var(--bg2);
  color: var(--ink);
  font-family: 'DM Sans', sans-serif;
  font-size: 0.88rem;
  font-weight: 600;
  outline: none;
  cursor: pointer;
  flex: 1;
  min-width: 140px;
  transition: border-color 0.18s;
}
.subject-select:focus { border-color: var(--red); }
.subject-input {
  padding: 0.55rem 0.85rem;
  border: 1.5px solid var(--border2);
  border-radius: 8px;
  background: var(--bg4);
  color: var(--ink);
  font-family: 'DM Sans', sans-serif;
  font-size: 0.85rem;
  outline: none;
  flex: 1;
  min-width: 130px;
  transition: border-color 0.18s;
}
.subject-input:focus { border-color: var(--red); }
.subject-input::placeholder { color: var(--muted2); }

.upload-area {
  border: 2px dashed var(--border2); border-radius: 16px;
  padding: 2.5rem; text-align: center; cursor: pointer;
  transition: all 0.25s; background: var(--bg4);
  margin-bottom: 3rem; position: relative;
}
.upload-area:hover, .upload-area.drag {
  border-color: var(--red); background: rgba(192,57,43,0.03);
}
.upload-area.flash-mode:hover, .upload-area.flash-mode.drag {
  border-color: var(--teal); background: rgba(13,115,119,0.03);
}
.upload-area input { position:absolute; inset:0; opacity:0; cursor:pointer; width:100%; height:100%; }
.upload-glyph { font-size: 2.6rem; margin-bottom: 0.6rem; }
.upload-head { font-family: 'Playfair Display', serif; font-size: 1.25rem; font-weight: 700; margin-bottom: 0.4rem; }
.upload-sub { color: var(--muted); font-size: 0.82rem; line-height: 1.6; }
.upload-format {
  font-family: 'DM Mono', monospace; font-size: 0.7rem;
  color: var(--teal); margin-top: 0.55rem;
  background: var(--teal-bg); display: inline-block;
  padding: 0.3rem 0.75rem; border-radius: 6px;
}
.upload-format.quiz-fmt { color: var(--red); background: rgba(192,57,43,0.06); }
.upload-bar { margin-top: 1.2rem; height: 2px; background: var(--border); border-radius: 2px; overflow: hidden; }
.upload-bar-fill { height:100%; background: linear-gradient(90deg, var(--red), #e74c3c); border-radius:2px; animation: loadbar 1.4s ease-in-out infinite; }
@keyframes loadbar { 0%{width:0;opacity:1} 80%{width:90%;opacity:1} 100%{width:100%;opacity:0} }

.file-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:1rem; }
.fcard {
  background: var(--bg4); border: 1px solid var(--border2); border-radius: 14px;
  padding: 1.4rem; cursor: pointer; transition: all 0.2s;
  position: relative; overflow: hidden;
}
.fcard::after {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: var(--red); opacity: 0; transition: opacity 0.2s;
  border-radius: 14px 0 0 14px;
}
.fcard.teal-card::after { background: var(--teal); }
.fcard:hover { transform: translateY(-2px); box-shadow: 0 8px 32px rgba(28,23,16,0.12); }
.fcard:hover::after { opacity: 1; }
.fcard-icon { font-size: 1.5rem; margin-bottom: 0.5rem; }
.fcard-name { font-family: 'Playfair Display', serif; font-weight: 700; font-size: 1rem; margin-bottom: 0.3rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fcard-meta { color: var(--muted); font-size: 0.75rem; margin-bottom: 1rem; }
.fcard-actions { display:flex; gap:0.5rem; flex-wrap:wrap; }

.btn {
  display:inline-flex; align-items:center; gap:0.35rem;
  padding:0.5rem 1.1rem; border-radius:8px; border:none; cursor:pointer;
  font-family:'DM Sans',sans-serif; font-size:0.8rem; font-weight:600;
  transition:all 0.18s; white-space:nowrap;
}
.btn-red { background: var(--red); color: #fff; }
.btn-red:hover { background: #a93226; transform:translateY(-1px); box-shadow:0 4px 14px rgba(192,57,43,0.3); }
.btn-teal { background: var(--teal); color: #fff; }
.btn-teal:hover { background: #0a5c60; transform:translateY(-1px); box-shadow:0 4px 14px rgba(13,115,119,0.35); }
.btn-ghost { background: transparent; color: var(--ink2); border: 1px solid var(--border2); }
.btn-ghost:hover { background: var(--bg2); }
.btn-danger { background: transparent; color: var(--red); border: 1px solid var(--red-bdr); font-size:0.75rem; }
.btn-danger:hover { background: var(--red-bg); }
.btn-sm { padding:0.35rem 0.7rem; font-size:0.73rem; border-radius:7px; }

.modal-overlay {
  position:fixed; inset:0; background:rgba(28,23,16,0.55); z-index:500;
  display:flex; align-items:center; justify-content:center; padding:1rem;
  backdrop-filter:blur(4px);
}
.modal-box {
  background:var(--bg4); border:1px solid var(--border2); border-radius:18px;
  padding:2rem; max-width:480px; width:100%;
  box-shadow: 0 24px 64px rgba(28,23,16,0.2);
}
.modal-title { font-family:'Playfair Display',serif; font-size:1.3rem; font-weight:700; margin-bottom:0.3rem; }
.modal-sub { color:var(--muted); font-size:0.82rem; margin-bottom:1.4rem; }
.name-input {
  width:100%; background:var(--bg2); border:1.5px solid var(--border2); border-radius:9px;
  color:var(--ink); font-family:'DM Sans',sans-serif; font-size:0.95rem; font-weight:500;
  padding:0.75rem 1rem; outline:none; margin-bottom:1.2rem; transition:border-color 0.18s;
}
.name-input:focus { border-color:var(--red); }
.modal-actions { display:flex; gap:0.75rem; }

.batch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 0.65rem;
  margin-bottom: 1.5rem;
}
.batch-btn {
  padding: 0.75rem 0.5rem; border-radius: 12px;
  border: 1.5px solid var(--border2); background: var(--bg3);
  color: var(--ink2); font-family: 'DM Mono', monospace; font-size: 0.78rem;
  cursor: pointer; transition: all 0.18s; text-align: center;
  font-weight: 500; letter-spacing: 0.04em;
}
.batch-btn:hover { border-color: var(--teal); background: var(--teal-bg); color: var(--teal); transform: translateY(-1px); }
.batch-btn.selected { border-color: var(--teal); background: var(--teal-bg); color: var(--teal); font-weight: 600; box-shadow: 0 0 0 2px rgba(13,115,119,0.15); }
.batch-all-btn {
  padding: 0.7rem; border-radius: 12px; border: 1.5px dashed var(--border2);
  background: transparent; color: var(--muted); font-family: 'DM Mono', monospace;
  font-size: 0.75rem; cursor: pointer; transition: all 0.18s; grid-column: 1 / -1;
  font-weight: 500; letter-spacing: 0.04em;
}
.batch-all-btn:hover { border-color: var(--teal); color: var(--teal); background: var(--teal-bg); }
.batch-all-btn.selected { border-color: var(--teal); color: var(--teal); background: var(--teal-bg); }
.batch-label {
  font-family: 'DM Mono', monospace; font-size: 0.62rem; letter-spacing: 0.15em;
  text-transform: uppercase; color: var(--muted); margin-bottom: 0.75rem;
}
.batch-count-info {
  font-size: 0.78rem; color: var(--muted); margin-bottom: 1.5rem;
  background: var(--bg2); border-radius: 8px; padding: 0.6rem 1rem;
  font-family: 'DM Mono', monospace; letter-spacing: 0.03em;
}
.batch-count-info span { color: var(--teal); font-weight: 600; }

.deleted-badge {
  display: inline-flex; align-items: center; gap: 0.4rem;
  padding: 0.22rem 0.7rem; border-radius: 100px;
  font-family: 'DM Mono', monospace; font-size: 0.62rem; letter-spacing: 0.08em;
  background: var(--red-bg); color: var(--red); border: 1px solid var(--red-bdr);
}

.flash-shell { max-width: 680px; margin: 0 auto; padding: 2rem 2rem 6rem; }

.flash-topbar {
  display:flex; align-items:center; justify-content:space-between;
  margin-bottom:1.75rem; gap:1rem; flex-wrap:wrap;
}
.flash-filename { font-family:'DM Mono',monospace; font-size:0.65rem; color:var(--teal); letter-spacing:0.12em; text-transform:uppercase; margin-bottom:0.2rem; }
.flash-title { font-family:'Playfair Display',serif; font-size:1.1rem; font-weight:700; }

.hud { display:grid; grid-template-columns:repeat(4,1fr); gap:0.7rem; margin-bottom:1.75rem; }
.hud-cell {
  background: var(--bg4); border:1px solid var(--border); border-radius:12px;
  padding:0.85rem 0.6rem; text-align:center;
}
.hud-val { font-family:'Playfair Display',serif; font-size:1.65rem; font-weight:900; line-height:1; }
.hud-val.g { color:var(--green); }
.hud-val.r { color:var(--red); }
.hud-val.a { color:var(--amber); }
.hud-val.t { color:var(--teal); }
.hud-lbl { font-size:0.6rem; color:var(--muted); text-transform:uppercase; letter-spacing:0.1em; margin-top:0.3rem; font-family:'DM Mono',monospace; }

.prog-bar { height:3px; background:var(--border); border-radius:2px; margin-bottom:1.75rem; overflow:hidden; }
.prog-fill { height:100%; background:linear-gradient(90deg,var(--teal),#0d9898); border-radius:2px; transition:width 0.4s ease; }
.prog-fill.quiz { background:linear-gradient(90deg,var(--red),#e74c3c); }

.flip-scene {
  width: 100%; height: 280px;
  perspective: 1200px;
  cursor: pointer;
  margin-bottom: 1.4rem;
}
.flip-card {
  width: 100%; height: 100%;
  position: relative;
  transform-style: preserve-3d;
  transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}
.flip-card.flipped { transform: rotateY(180deg); }
.flip-face {
  position: absolute; inset: 0;
  backface-visibility: hidden;
  border-radius: 20px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 2.5rem;
  border: 1.5px solid var(--border2);
  text-align: center;
}
.flip-front { background: var(--bg4); box-shadow: 0 4px 32px rgba(28,23,16,0.08); }
.flip-back {
  background: linear-gradient(135deg, var(--teal-bg) 0%, var(--bg4) 100%);
  border-color: var(--teal-bdr);
  transform: rotateY(180deg);
  box-shadow: 0 4px 32px rgba(13,115,119,0.12);
}
[data-theme="dark"] .flip-back {
  background: linear-gradient(135deg, rgba(45,212,191,0.07) 0%, var(--bg4) 100%);
}
.flip-hint {
  font-family: 'DM Mono', monospace; font-size: 0.6rem; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--muted); margin-bottom: 1rem;
  display: flex; align-items: center; gap: 0.4rem;
}
.flip-hint-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--teal); animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
.flip-term {
  font-family: 'Playfair Display', serif;
  font-size: 2rem; font-weight: 900; line-height: 1.2;
  color: var(--ink); letter-spacing: -0.02em;
}
.flip-back-label {
  font-family: 'DM Mono', monospace; font-size: 0.6rem; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--teal); margin-bottom: 0.85rem;
}
.flip-definition { font-family: 'DM Sans', sans-serif; font-size: 1.08rem; line-height: 1.65; color: var(--ink2); font-weight: 400; }
.flip-example {
  margin-top: 0.85rem;
  font-family: 'Playfair Display', serif; font-style: italic;
  font-size: 0.88rem; color: var(--muted);
  border-top: 1px solid var(--teal-bdr); padding-top: 0.75rem; line-height: 1.55;
}

.flip-controls { display: flex; align-items: center; justify-content: center; gap: 1rem; margin-bottom: 1.5rem; }
.flip-nav-btn {
  width: 44px; height: 44px; border-radius: 50%;
  border: 1.5px solid var(--border2); background: var(--bg4);
  color: var(--ink2); font-size: 1.1rem; cursor: pointer;
  display: flex; align-items: center; justify-content: center; transition: all 0.18s;
}
.flip-nav-btn:hover:not(:disabled) { border-color: var(--teal); background: var(--teal-bg); color: var(--teal); }
.flip-nav-btn:disabled { opacity: 0.3; cursor: default; }
.flip-counter { font-family: 'DM Mono', monospace; font-size: 0.8rem; color: var(--muted); min-width: 80px; text-align: center; }

.know-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 1rem; }
.know-btn {
  padding: 0.75rem; border-radius: 12px; border: 1.5px solid;
  font-family: 'DM Sans', sans-serif; font-size: 0.85rem; font-weight: 600;
  cursor: pointer; transition: all 0.18s; display: flex; align-items: center; justify-content: center; gap: 0.4rem;
}
.know-btn.yes { border-color: var(--green-bdr); color: var(--green); background: var(--green-bg); }
.know-btn.yes:hover { background: var(--green); color: #fff; transform: translateY(-1px); }
.know-btn.no { border-color: var(--red-bdr); color: var(--red); background: var(--red-bg); }
.know-btn.no:hover { background: var(--red); color: #fff; transform: translateY(-1px); }
.flip-skip-btn {
  width: 100%; padding: 0.6rem; border-radius: 10px;
  border: 1px dashed var(--border2); background: transparent;
  color: var(--muted); font-size: 0.78rem; cursor: pointer;
  transition: all 0.16s; font-family: 'DM Sans', sans-serif;
}
.flip-skip-btn:hover { background: var(--bg2); color: var(--ink2); }

.kbd-hint {
  text-align: center; margin-top: 1rem;
  font-family: 'DM Mono', monospace; font-size: 0.62rem; color: var(--muted2);
  display: flex; align-items: center; justify-content: center; gap: 0.5rem;
}
kbd {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0.18rem 0.45rem; border-radius: 4px;
  border: 1px solid var(--border2); background: var(--bg3);
  font-size: 0.6rem; font-family: 'DM Mono', monospace; color: var(--ink2);
}

.results-page { text-align:center; padding:3rem 1rem; }
.results-label { font-family:'DM Mono',monospace; font-size:0.65rem; letter-spacing:0.22em; text-transform:uppercase; color:var(--muted); margin-bottom:1rem; }
.results-score { font-family:'Playfair Display',serif; font-size:5.5rem; font-weight:900; line-height:1; color: var(--teal); }
.results-score.quiz-score { color: var(--red); }
.results-grade { font-size:1rem; color:var(--muted); margin:0.5rem 0 2rem; font-style:italic; }
.results-grid { display:flex; gap:1rem; justify-content:center; flex-wrap:wrap; margin-bottom:2.5rem; }
.res-box { background:var(--bg4); border:1px solid var(--border2); border-radius:14px; padding:1.2rem 2rem; min-width:110px; }
.res-val { font-family:'Playfair Display',serif; font-size:2.3rem; font-weight:900; }
.res-lbl { font-size:0.65rem; color:var(--muted); text-transform:uppercase; letter-spacing:0.1em; margin-top:0.2rem; font-family:'DM Mono',monospace; }
.results-actions { display:flex; gap:0.75rem; justify-content:center; flex-wrap:wrap; }

.test-shell { max-width: 760px; margin: 0 auto; padding: 2rem 2rem 6rem; }
.test-topbar { display:flex; align-items:center; justify-content:space-between; margin-bottom:1.75rem; gap:1rem; flex-wrap:wrap; }
.test-filename { font-family:'DM Mono',monospace; font-size:0.65rem; color:var(--red); letter-spacing:0.12em; text-transform:uppercase; margin-bottom:0.2rem; }
.test-title { font-family:'Playfair Display',serif; font-size:1.1rem; font-weight:700; }

.qcard { background: var(--bg4); border: 1px solid var(--border2); border-radius: 18px; padding: 2rem 2.25rem; box-shadow: 0 2px 20px rgba(28,23,16,0.06); animation: qin 0.28s ease; }
@keyframes qin { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
.q-num { font-family:'DM Mono',monospace; font-size:0.63rem; letter-spacing:0.18em; text-transform:uppercase; color:var(--muted); display:flex; align-items:center; gap:0.5rem; margin-bottom:1.1rem; }
.retry-badge { padding:0.12rem 0.5rem; border-radius:5px; font-size:0.6rem; background: var(--red-bg); color:var(--red); border:1px solid var(--red-bdr); }
.q-sentence-wrap { background: var(--bg2); border-left: 3px solid var(--red); border-radius: 0 10px 10px 0; padding: 1.1rem 1.4rem; margin-bottom: 1.6rem; font-family: 'Playfair Display', serif; font-size: 1.12rem; line-height: 1.7; color: var(--ink); }
.q-prompt { font-family: 'DM Sans', sans-serif; font-size: 0.78rem; color: var(--muted); margin-bottom: 0.65rem; letter-spacing: 0.02em; }
.opts { display:flex; flex-direction:column; gap:0.6rem; }
.opt { width:100%; text-align:left; padding:0.85rem 1.1rem; border-radius:11px; border:1.5px solid var(--border); background: var(--bg3); color:var(--ink2); font-family:'DM Sans',sans-serif; font-size:0.88rem; font-weight:400; cursor:pointer; transition:all 0.16s; display:flex; align-items:center; gap:0.85rem; }
.opt:hover:not(:disabled) { border-color:var(--red); background: var(--red-bg); }
.opt:disabled { cursor:default; }
.opt.correct { border-color:var(--green); background:var(--green-bg); color:var(--green); font-weight:600; }
.opt.wrong { border-color:var(--red); background:var(--red-bg); color:var(--red); }
.opt-key { width:28px; height:28px; border-radius:7px; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-family:'DM Mono',monospace; font-size:0.7rem; font-weight:500; background:var(--bg4); border:1px solid var(--border); transition:all 0.16s; }
.opt.correct .opt-key { background:var(--green); color:#fff; border-color:var(--green); }
.opt.wrong .opt-key { background:var(--red); color:#fff; border-color:var(--red); }
.opt:hover:not(:disabled) .opt-key { background:var(--red); color:#fff; border-color:var(--red); }
.solution-box { margin-top: 1.2rem; border-radius: 12px; overflow: hidden; animation: qin 0.22s ease; }
.solution-head { display: flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1.1rem; font-family: 'DM Mono', monospace; font-size: 0.68rem; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 500; }
.solution-head.ok { background:var(--green-bg); color:var(--green); border:1px solid var(--green-bdr); border-bottom:none; border-radius:12px 12px 0 0; }
.solution-head.no { background:var(--red-bg); color:var(--red); border:1px solid var(--red-bdr); border-bottom:none; border-radius:12px 12px 0 0; }
.solution-body { padding: 1rem 1.1rem; font-size: 0.86rem; line-height: 1.65; color: var(--ink2); border: 1px solid; border-top: none; border-radius: 0 0 12px 12px; }
.solution-body.ok { border-color: var(--green-bdr); background: var(--green-bg); }
.solution-body.no { border-color: var(--red-bdr); background: var(--red-bg); }
.solution-answer { margin-top: 0.5rem; font-family: 'DM Mono', monospace; font-size: 0.8rem; color: var(--green); background: rgba(26,122,74,0.08); padding: 0.3rem 0.65rem; border-radius: 6px; display:inline-block; }
.next-row { display:flex; justify-content:flex-end; margin-top:1.5rem; gap:0.75rem; }

.spin { width:32px; height:32px; border:2px solid var(--border2); border-top-color:var(--red); border-radius:50%; animation:rotate 0.7s linear infinite; margin:3rem auto; }
@keyframes rotate { to{transform:rotate(360deg)} }
.empty { text-align:center; padding:4rem 2rem; }
.empty-glyph { font-size:3rem; opacity:0.3; margin-bottom:1rem; }
.empty-head { font-family:'Playfair Display',serif; font-size:1.2rem; opacity:0.35; margin-bottom:0.4rem; }
.empty-sub { color:var(--muted); font-size:0.82rem; }

.toast-wrap { position:fixed; bottom:2rem; right:2rem; z-index:1000; display:flex; flex-direction:column; gap:0.5rem; }
.toast { background: var(--bg4); border:1px solid var(--border2); border-radius:12px; padding:0.85rem 1.1rem; font-size:0.82rem; max-width:300px; box-shadow:0 8px 24px rgba(28,23,16,0.12); animation: toastin 0.3s ease; display:flex; align-items:center; gap:0.6rem; }
.toast.success { border-left:3px solid var(--green); }
.toast.error { border-left:3px solid var(--red); }
.toast.info { border-left:3px solid var(--blue); }
@keyframes toastin { from{opacity:0;transform:translateX(16px)} to{opacity:1;transform:translateX(0)} }

@media(max-width:600px){
  .hud{grid-template-columns:repeat(2,1fr)}
  .results-score{font-size:4rem}
  .file-grid{grid-template-columns:1fr}
  .topbar,.page,.test-shell,.flash-shell{padding-left:1rem;padding-right:1rem}
  .mode-tabs{padding-left:1rem;padding-right:1rem}
  .flip-scene{height:240px}
  .flip-term{font-size:1.6rem}
  .batch-grid{grid-template-columns:repeat(2,1fr)}
  .subject-bar{flex-direction:column;align-items:stretch}
}
`;

// ============================================================
// RENAME MODAL
// ============================================================
function RenameModal({ file, onSave, onClose }) {
  const [name, setName] = useState(file.name.replace(/\.csv$/i, ""));
  const inputRef = useRef();
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  const save = () => {
    const t = name.trim();
    if (!t) return;
    onSave(file, t.endsWith(".csv") ? t : `${t}.csv`);
  };
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div className="modal-title">✏️ Rename Set</div>
        <div className="modal-sub">Current: <span style={{fontFamily:"DM Mono,monospace",fontSize:"0.78rem",color:"var(--red)"}}>{file.name}</span></div>
        <input ref={inputRef} className="name-input" value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key==="Enter") save(); if (e.key==="Escape") onClose(); }}
          placeholder="New name…" />
        <div className="modal-actions">
          <button className="btn btn-red" style={{flex:1}} onClick={save}>Save</button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// BATCH SELECTOR MODAL
// ============================================================
const BATCH_SIZE = 50;

function BatchSelectorModal({ totalCards, title, onStart, onClose }) {
  const [selected, setSelected] = useState(null);

  const batches = [];
  for (let i = 0; i < totalCards; i += BATCH_SIZE) {
    batches.push({
      start: i,
      end: Math.min(i + BATCH_SIZE - 1, totalCards - 1),
      label: `${i + 1}–${Math.min(i + BATCH_SIZE, totalCards)}`
    });
  }

  const selectedCount = selected === "all"
    ? totalCards
    : selected !== null ? (selected.end - selected.start + 1) : 0;

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{maxWidth: 520}}>
        <div className="modal-title">🃏 Choose a Batch</div>
        <div className="modal-sub" style={{marginBottom:"1rem"}}>
          <span style={{fontFamily:"DM Mono,monospace",fontSize:"0.78rem",color:"var(--teal)"}}>{title}</span>
          {" "}— {totalCards} cards total
        </div>

        <div className="batch-label">Select range to study</div>
        <div className="batch-grid">
          {batches.map((b, i) => (
            <button key={i}
              className={`batch-btn ${selected && selected !== "all" && selected.start === b.start ? "selected" : ""}`}
              onClick={() => setSelected(b)}
            >
              {b.label}
              <div style={{fontSize:"0.62rem",color:"inherit",opacity:0.7,marginTop:"0.2rem"}}>
                {b.end - b.start + 1} cards
              </div>
            </button>
          ))}
          <button className={`batch-all-btn ${selected === "all" ? "selected" : ""}`} onClick={() => setSelected("all")}>
            📚 All {totalCards} cards (shuffled)
          </button>
        </div>

        {selected !== null && (
          <div className="batch-count-info">
            <span>{selectedCount}</span> cards selected — no repeats, shuffled order
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-teal" style={{flex:1}} onClick={() => { if (selected !== null) onStart(selected); }} disabled={selected === null}>
            Start Flashcards →
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// FLASHCARD VIEW
// ============================================================
function FlashcardView({ session, onExit }) {
  const { cards: allCards, title } = session;
  const [flipped, setFlipped] = useState(false);
  const [idx, setIdx] = useState(0);
  const [known, setKnown] = useState(0);
  const [unknown, setUnknown] = useState(0);
  const [done, setDone] = useState(false);

  const total = allCards.length;
  const card = allCards[idx];
  const prog = (idx / total) * 100;

  useEffect(() => {
    const handler = (e) => {
      if (e.key === " " || e.key === "ArrowDown") { e.preventDefault(); setFlipped(f => !f); }
      if (e.key === "ArrowRight") advance("know");
      if (e.key === "ArrowLeft") advance("unknown");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [idx]);

  const advance = (verdict) => {
    if (verdict === "know") setKnown(k => k + 1);
    else setUnknown(u => u + 1);
    setFlipped(false);
    setTimeout(() => {
      if (idx + 1 >= total) setDone(true);
      else setIdx(i => i + 1);
    }, 150);
  };

  const skip = () => {
    setFlipped(false);
    setTimeout(() => {
      if (idx + 1 >= total) setDone(true);
      else setIdx(i => i + 1);
    }, 150);
  };

  if (done) {
    const pct = Math.round((known / total) * 100);
    const grade =
      pct >= 90 ? "Vocabulary master! Outstanding. 🏆" :
      pct >= 75 ? "Great recall — almost there! 🌟" :
      pct >= 60 ? "Good progress — review the tricky ones. 📖" :
      pct >= 40 ? "Keep practising — repetition builds memory. ✍️" :
      "A strong foundation starts here — revisit this set. 🔄";

    return (
      <div className="flash-shell">
        <div className="results-page">
          <div className="results-label">Session Complete</div>
          <div className="results-score">{pct}%</div>
          <div className="results-grade">{grade}</div>
          <div className="results-grid">
            <div className="res-box"><div className="res-val" style={{color:"var(--green)"}}>{known}</div><div className="res-lbl">Known</div></div>
            <div className="res-box"><div className="res-val" style={{color:"var(--red)"}}>{unknown}</div><div className="res-lbl">Review</div></div>
            <div className="res-box"><div className="res-val" style={{color:"var(--teal)"}}>{total}</div><div className="res-lbl">Total</div></div>
          </div>
          <div className="results-actions">
            <button className="btn btn-teal" onClick={() => {
              setIdx(0); setFlipped(false); setKnown(0); setUnknown(0); setDone(false);
            }}>Retry ↺</button>
            <button className="btn btn-ghost" onClick={onExit}>← Back to Sets</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flash-shell">
      <div className="flash-topbar">
        <div>
          <div className="flash-filename">{title}</div>
          <div className="flash-title">Flashcards</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onExit}>Exit ✕</button>
      </div>

      <div className="hud">
        <div className="hud-cell"><div className="hud-val g">{known}</div><div className="hud-lbl">Known</div></div>
        <div className="hud-cell"><div className="hud-val r">{unknown}</div><div className="hud-lbl">Review</div></div>
        <div className="hud-cell"><div className="hud-val a">{total - idx - 1}</div><div className="hud-lbl">Left</div></div>
        <div className="hud-cell"><div className="hud-val t">{total}</div><div className="hud-lbl">Total</div></div>
      </div>

      <div className="prog-bar"><div className="prog-fill" style={{width:`${prog}%`}} /></div>

      <div className="flip-scene" onClick={() => setFlipped(f => !f)}>
        <div className={`flip-card ${flipped ? "flipped" : ""}`}>
          <div className="flip-face flip-front">
            <div className="flip-hint"><div className="flip-hint-dot" />tap to reveal</div>
            <div className="flip-term">{card.term}</div>
          </div>
          <div className="flip-face flip-back">
            <div className="flip-back-label">Definition</div>
            <div className="flip-definition">{card.definition}</div>
            {card.example && <div className="flip-example">"{card.example}"</div>}
          </div>
        </div>
      </div>

      <div className="flip-controls">
        <button className="flip-nav-btn" onClick={(e) => { e.stopPropagation(); if (idx > 0) { setIdx(i => i - 1); setFlipped(false); } }} disabled={idx === 0}>←</button>
        <span className="flip-counter">{idx + 1} / {total}</span>
        <button className="flip-nav-btn" onClick={(e) => { e.stopPropagation(); skip(); }}>→</button>
      </div>

      <div className="know-row">
        <button className="know-btn no" onClick={() => advance("unknown")}>✗ Still Learning</button>
        <button className="know-btn yes" onClick={() => advance("know")}>✓ Know It</button>
      </div>
      <button className="flip-skip-btn" onClick={skip}>Skip →</button>

      <div className="kbd-hint">
        <kbd>Space</kbd> flip &nbsp;·&nbsp;
        <kbd>←</kbd> still learning &nbsp;·&nbsp;
        <kbd>→</kbd> know it
      </div>
    </div>
  );
}

// ============================================================
// QUIZ TEST ENGINE
// ============================================================
const LETTERS = ["A","B","C","D"];

function TestView({ session, onExit }) {
  const { questions: initialQ, title } = session;

  const [questions,    setQuestions]    = useState(initialQ);
  const [queue,        setQueue]        = useState(() => buildQueue(initialQ));
  const [qi,           setQi]           = useState(0);
  const [selected,     setSelected]     = useState(null);
  const [answered,     setAnswered]     = useState(false);
  const [correct,      setCorrect]      = useState(0);
  const [wrong,        setWrong]        = useState(0);
  const [done,         setDone]         = useState(false);
  const [retries,      setRetries]      = useState(new Set());
  const [deletedCount, setDeletedCount] = useState(0);
  const [saving,       setSaving]       = useState(false);

  const total     = questions.length;
  const q         = queue[qi];
  const remaining = Math.max(0, queue.length - qi - 1);
  const prog      = total > 0 ? (Math.min(qi, total) / (total + deletedCount)) * 100 : 100;

  if (done || (!q && qi > 0)) {
    const pct = total > 0 ? Math.round((correct / (correct + wrong)) * 100) : 100;
    const grade =
      pct >= 90 ? "Exceptional command of grammar. 🏆" :
      pct >= 75 ? "Strong performance! Keep refining. 🌟" :
      pct >= 60 ? "Good effort — review the errors you missed. 📖" :
      pct >= 40 ? "More practice will sharpen your instincts. ✍️" :
      "Regular grammar drills will help greatly. 🔄";

    return (
      <div className="test-shell">
        <div className="results-page">
          <div className="results-label">Session Complete</div>
          <div className="results-score quiz-score">{pct}%</div>
          <div className="results-grade">{grade}</div>
          <div className="results-grid">
            <div className="res-box"><div className="res-val" style={{color:"var(--green)"}}>{correct}</div><div className="res-lbl">Correct</div></div>
            <div className="res-box"><div className="res-val" style={{color:"var(--red)"}}>{wrong}</div><div className="res-lbl">Wrong</div></div>
            <div className="res-box"><div className="res-val" style={{color:"var(--amber)"}}>{correct + wrong}</div><div className="res-lbl">Answered</div></div>
            <div className="res-box"><div className="res-val" style={{color:"var(--red)"}}>{deletedCount}</div><div className="res-lbl">Deleted</div></div>
          </div>
          <div className="results-actions">
            <button className="btn btn-red" onClick={() => {
              setQueue(buildQueue(questions)); setQi(0); setSelected(null); setAnswered(false);
              setCorrect(0); setWrong(0); setDone(false); setRetries(new Set()); setDeletedCount(0);
            }}>Retry ↺</button>
            <button className="btn btn-ghost" onClick={onExit}>← Back to Sets</button>
          </div>
        </div>
      </div>
    );
  }

  if (!q) return null;

  const isRetry   = retries.has(q.id);
  const isCorrect = answered && selected === q.correct;

  const pick = (opt) => {
    if (answered) return;
    setSelected(opt);
    setAnswered(true);
    if (opt === q.correct) {
      setCorrect(c => c + 1);
      setRetries(s => { const n = new Set(s); n.delete(q.id); return n; });
    } else {
      if (!isRetry) setWrong(w => w + 1);
      const rest = queue.slice(qi + 1);
      const at   = Math.min(2 + Math.floor(Math.random() * 3), rest.length);
      rest.splice(at, 0, { ...q, options: shuffle(q.options) });
      setQueue([...queue.slice(0, qi + 1), ...rest]);
      setRetries(s => new Set([...s, q.id]));
    }
  };

  const deleteQuestion = async () => {
    if (!window.confirm("Are you sure you want to delete this question?")) return;
    const idToRemove   = q.id;
    const newQuestions = questions.filter(item => item.id !== idToRemove);
    const newQueue     = queue.filter(item => item.id !== idToRemove);
    setDeletedCount(d => d + 1);
    setQuestions(newQuestions);
    setQueue(newQueue);
    if (newQuestions.length === 0 || newQueue.length === 0) {
      setDone(true);
    } else {
      setQi(Math.min(qi, newQueue.length - 1));
      setSelected(null);
      setAnswered(false);
    }
    setSaving(true);
    try { await DB.deleteQuestion(idToRemove); }
    catch (err) { console.error("Failed to delete:", err); }
    finally { setSaving(false); }
  };

  const next = () => {
    if (qi + 1 >= queue.length) setDone(true);
    else { setQi(i => i + 1); setSelected(null); setAnswered(false); }
  };

  return (
    <div className="test-shell">
      <div className="test-topbar">
        <div>
          <div className="test-filename">{title}</div>
          <div className="test-title">
            Error Detection
            {deletedCount > 0 && (
              <span className="deleted-badge" style={{marginLeft:"0.75rem"}}>🗑 {deletedCount} deleted</span>
            )}
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onExit}>Exit ✕</button>
      </div>

      <div className="hud">
        <div className="hud-cell"><div className="hud-val g">{correct}</div><div className="hud-lbl">Correct</div></div>
        <div className="hud-cell"><div className="hud-val r">{wrong}</div><div className="hud-lbl">Wrong</div></div>
        <div className="hud-cell"><div className="hud-val a">{remaining}</div><div className="hud-lbl">Left</div></div>
        <div className="hud-cell"><div className="hud-val t">{total}</div><div className="hud-lbl">Remaining</div></div>
      </div>

      <div className="prog-bar"><div className="prog-fill quiz" style={{width:`${prog}%`}} /></div>

      <div className="qcard">
        <div className="q-num">
          Question {qi + 1} of {queue.length}
          {isRetry && <span className="retry-badge">↩ Retry</span>}
        </div>
        <div className="q-prompt">Identify the part of the sentence that contains an error:</div>
        <div className="q-sentence-wrap">{q.question}</div>
        <div className="opts">
          {q.options.map((opt, i) => {
            let cls = "";
            if (answered) {
              if (opt === q.correct) cls = "correct";
              else if (opt === selected) cls = "wrong";
            }
            return (
              <button key={i} className={`opt ${cls}`} onClick={() => pick(opt)} disabled={answered}>
                <span className="opt-key">{LETTERS[i]}</span>
                {opt}
              </button>
            );
          })}
        </div>

        {answered && (
          <div className="solution-box">
            <div className={`solution-head ${isCorrect ? "ok" : "no"}`}>
              <span>{isCorrect ? "✓ Correct" : "✗ Incorrect"}</span>
            </div>
            <div className={`solution-body ${isCorrect ? "ok" : "no"}`}>
              {!isCorrect && <div>Correct answer: <span className="solution-answer">{q.correct}</span></div>}
              {q.solution && (
                <div style={{marginTop: isCorrect ? 0 : "0.65rem", color:"var(--ink2)"}}>
                  <strong style={{fontFamily:"DM Mono,monospace",fontSize:"0.7rem",letterSpacing:"0.08em",textTransform:"uppercase",color:"var(--muted)"}}>Explanation</strong>
                  <p style={{marginTop:"0.3rem"}}>{q.solution}</p>
                </div>
              )}
              {isCorrect && !q.solution && <span>Well spotted! Moving on.</span>}
            </div>
          </div>
        )}

        <div className="next-row">
          <button className="btn btn-danger" onClick={deleteQuestion} disabled={saving}>
            {saving ? "💾 Saving…" : "🗑 Delete"}
          </button>
          {answered && (
            <button className="btn btn-red" onClick={next}>
              {qi + 1 >= queue.length ? "See Results →" : "Next →"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// DASHBOARD
// ============================================================
function Dashboard({ mode, onStartTest, onStartFlash, toast }) {
  const [files,        setFiles]        = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [uploading,    setUploading]    = useState(false);
  const [drag,         setDrag]         = useState(false);
  const [renaming,     setRenaming]     = useState(null);
  const [batchPicker,  setBatchPicker]  = useState(null);
  const fileRef = useRef();
  const isFlash = mode === "flash";

  // Subject state
  const [subjects,        setSubjects]        = useState([]);
  const [selectedSubject, setSelectedSubject] = useState("");
  const [newSubject,      setNewSubject]       = useState("");
  const [addingSubject,   setAddingSubject]    = useState(false);

  // Load subjects once on mount
  useEffect(() => {
    async function loadSubjects() {
      try {
        const subs = await DB.getSubjects();
        const finalSubs = subs.length ? subs : ["general"];
        setSubjects(finalSubs);
        setSelectedSubject(prev => finalSubs.includes(prev) ? prev : finalSubs[0]);
      } catch (err) {
        console.error("Failed to load subjects:", err);
        setSubjects(["general"]);
        setSelectedSubject("general");
      }
    }
    loadSubjects();
  }, []);

  // Add a new subject — inserts a seed row so it persists across refreshes
  const addSubject = async () => {
    const trimmed = newSubject.trim().toLowerCase();
    if (!trimmed) return;

    // Already exists — just switch to it
    if (subjects.includes(trimmed)) {
      setSelectedSubject(trimmed);
      setNewSubject("");
      return;
    }

    setAddingSubject(true);
    try {
      await DB.addSubjectSeed(trimmed);
      // Re-fetch so the dropdown is always in sync with the DB
      const subs = await DB.getSubjects();
      const finalSubs = subs.length ? subs : ["general"];
      setSubjects(finalSubs);
      setSelectedSubject(trimmed);
      setNewSubject("");
      toast(`Subject "${trimmed}" added!`, "success");
    } catch (err) {
      console.error("Failed to add subject:", err);
      toast("Failed to add subject", "error");
    } finally {
      setAddingSubject(false);
    }
  };

  // Load files whenever selected subject changes
  const load = useCallback(async () => {
    if (!selectedSubject) return;
    setLoading(true);
    try { setFiles(await Storage.listAll(selectedSubject)); }
    catch { toast("Error loading files", "error"); }
    setLoading(false);
  }, [selectedSubject, toast]);

  useEffect(() => { load(); }, [load]);

  const handleFilePick = async (file) => {
    if (!file?.name.endsWith(".csv")) { toast("Please upload a .csv file", "error"); return; }
    setUploading(true);
    try {
      await Storage.upload(file, selectedSubject);
      toast(`"${file.name}" uploaded!`, "success");
      await new Promise(r => setTimeout(r, 500));
      await load();
    } catch (err) { console.error(err); toast("Upload failed", "error"); }
    setUploading(false);
  };

  const startSession = async (f) => {
    toast("Loading…", "info");
    try {
      const result    = await Storage.read(f);
      const fileTitle = f.name.replace(/\.csv$/i, "");
      if (result.type === "empty") { toast("No data found in this set", "error"); return; }
      if (result.type === "flashcard" || isFlash) {
        const cards = result.cards || [];
        if (!cards.length) { toast("No valid flashcard data found", "error"); return; }
        setBatchPicker({ type: "flash", file: f, cards, title: fileTitle });
      } else {
        const questions = result.questions || [];
        if (!questions.length) { toast("No valid questions found", "error"); return; }
        setBatchPicker({ type: "quiz", questions, title: fileTitle, fileName: f.name });
      }
    } catch (e) { console.error(e); toast("Could not load file", "error"); }
  };

  const handleBatchStart = (batch) => {
    const { type, cards, questions, title, fileName } = batchPicker;
    if (type === "flash") {
      const data = cards;
      const sel  = batch === "all" ? shuffle([...data]) : shuffle(data.slice(batch.start, batch.end + 1));
      onStartFlash({ cards: sel, title });
    } else {
      const data = questions;
      const sel  = batch === "all" ? shuffle([...data]) : shuffle(data.slice(batch.start, batch.end + 1));
      onStartTest({ questions: sel, fileName, title });
    }
    setBatchPicker(null);
  };

  const handleRename = async (oldFile, newName) => {
    try {
      await DB.rename(oldFile.name, newName);
      setRenaming(null);
      toast(`Renamed to "${newName}"`, "success");
      await load();
    } catch { toast("Rename failed", "error"); }
  };

  const deleteFile = async (e, f) => {
    e.stopPropagation();
    if (!confirm(`Delete "${f.name}"?`)) return;
    await Storage.delete(f);
    toast(`Deleted "${f.name}"`, "info");
    setFiles(prev => prev.filter(x => x.name !== f.name));
  };

  return (
    <div className="page">

      {/* Subject bar */}
      <div className="subject-bar">
        <span className="subject-bar-label">Subject</span>
        <select className="subject-select" value={selectedSubject} onChange={(e) => setSelectedSubject(e.target.value)}>
          {subjects.map(sub => (
            <option key={sub} value={sub}>{sub.charAt(0).toUpperCase() + sub.slice(1)}</option>
          ))}
        </select>
        <input
          className="subject-input"
          value={newSubject}
          onChange={(e) => setNewSubject(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addSubject(); }}
          placeholder="New subject name…"
        />
        <button className="btn btn-red btn-sm" onClick={addSubject} disabled={addingSubject || !newSubject.trim()}>
          {addingSubject ? "Adding…" : "+ Add"}
        </button>
      </div>

      <div className={`sect ${isFlash ? "teal" : ""}`}>Upload {isFlash ? "Flashcard" : "Question"} Set</div>
      <div
        className={`upload-area ${drag ? "drag" : ""} ${isFlash ? "flash-mode" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); handleFilePick(e.dataTransfer.files[0]); }}
        onClick={() => !uploading && fileRef.current?.click()}
      >
        <input ref={fileRef} type="file" accept=".csv"
          onChange={(e) => { handleFilePick(e.target.files[0]); e.target.value = ""; }} />
        <div className="upload-glyph">{uploading ? "⏳" : isFlash ? "🃏" : "📄"}</div>
        <div className="upload-head">{uploading ? "Uploading…" : "Drop your CSV or click to upload"}</div>
        {isFlash ? (
          <>
            <div className="upload-sub">One word/idiom per row — comma or semicolon separated</div>
            <div className="upload-format">Term , Definition , Example sentence (optional)</div>
          </>
        ) : (
          <>
            <div className="upload-sub">Comma-separated — one question per row</div>
            <div className="upload-format quiz-fmt">Question , Opt A , Opt B , Opt C , Opt D , Correct , Solution</div>
          </>
        )}
        {uploading && <div className="upload-bar"><div className="upload-bar-fill" /></div>}
      </div>

      <div className={`sect ${isFlash ? "teal" : ""}`}>
        {isFlash ? "Flashcard" : "Question"} Sets
        <span className={`sect-count ${isFlash ? "teal" : ""}`}>{files.length}</span>
      </div>

      {loading ? (
        <div className="spin" />
      ) : files.length === 0 ? (
        <div className="empty">
          <div className="empty-glyph">{isFlash ? "🃏" : "📝"}</div>
          <div className="empty-head">No sets uploaded yet</div>
          <div className="empty-sub">Upload a CSV file to begin</div>
        </div>
      ) : (
        <div className="file-grid">
          {files.map((f) => (
            <div key={f.name} className={`fcard ${isFlash ? "teal-card" : ""}`} onClick={() => startSession(f)}>
              <div className="fcard-icon">{isFlash ? "🃏" : "📋"}</div>
              <div className="fcard-name">{f.name.replace(/\.csv$/i, "")}</div>
              <div className="fcard-meta">☁️ Cloud · {f.size ? `${(f.size / 1024).toFixed(1)} KB` : "—"}</div>
              <div className="fcard-actions">
                <button className={`btn ${isFlash ? "btn-teal" : "btn-red"} btn-sm`}
                  onClick={(e) => { e.stopPropagation(); startSession(f); }}>
                  {isFlash ? "Study →" : "Start →"}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setRenaming(f); }}>✏️</button>
                <button className="btn btn-danger btn-sm" onClick={(e) => deleteFile(e, f)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {renaming && <RenameModal file={renaming} onSave={handleRename} onClose={() => setRenaming(null)} />}

      {batchPicker && (
        <BatchSelectorModal
          totalCards={batchPicker.type === "quiz" ? batchPicker.questions.length : batchPicker.cards.length}
          title={batchPicker.title}
          onStart={handleBatchStart}
          onClose={() => setBatchPicker(null)}
        />
      )}
    </div>
  );
}

// ============================================================
// APP
// ============================================================
export default function App() {
  const [quizSession,  setQuizSession]  = useState(null);
  const [flashSession, setFlashSession] = useState(null);
  const [mode,         setMode]         = useState("quiz");
  const { toasts, add: toast }          = useToast();
  const [darkMode,     setDarkMode]     = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  const inSession = quizSession || flashSession;

  return (
    <>
      <style>{STYLES}</style>
      <div style={{display:"flex",flexDirection:"column",minHeight:"100vh"}}>
        <header className="topbar">
          <div className="logo">GKGS<span className="logo-em">------</span></div>
          <div className="topbar-right">
            <button className="btn btn-ghost btn-sm" onClick={() => setDarkMode(!darkMode)}>
              {darkMode ? "☀️ Light" : "🌙 Dark"}
            </button>
            <div className="cloud-pill">☁️ Supabase</div>
          </div>
        </header>

        {!inSession && (
          <nav className="mode-tabs">
            <button className={`mode-tab ${mode === "quiz" ? "active" : ""}`} onClick={() => setMode("quiz")}>
              📝 Error Detection
            </button>
            <button className={`mode-tab flash ${mode === "flash" ? "active" : ""}`} onClick={() => setMode("flash")}>
              🃏 Flashcards
            </button>
          </nav>
        )}

        {quizSession ? (
          <TestView session={quizSession} onExit={() => setQuizSession(null)} />
        ) : flashSession ? (
          <FlashcardView session={flashSession} onExit={() => setFlashSession(null)} />
        ) : (
          <Dashboard mode={mode} onStartTest={setQuizSession} onStartFlash={setFlashSession} toast={toast} />
        )}
      </div>

      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            {t.type === "success" ? "✅" : t.type === "error" ? "❌" : "ℹ️"} {t.msg}
          </div>
        ))}
      </div>
    </>
  );
}
