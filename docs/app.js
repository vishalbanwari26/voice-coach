// Voice Coach: a phone-first web app, no server.
// - The live conversation streams audio both ways with the Gemini Live API.
//   The mic stays open while the AI speaks, so talking interrupts it.
// - Each of your answers is also sent to Whisper (Groq) for an accurate transcript.
// - The report is written by a text model on Groq.
// Keys, settings, history and German mistakes live in this browser's localStorage.

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const GROQ = "https://api.groq.com/openai/v1";
const DEFAULTS = { live: "models/gemini-3.8-live", report: "openai/gpt-oss-120b", whisper: "whisper-large-v3-turbo",
  listen: "whisper-large-v3" }; // the full model is slower but much better with accents
const VOICES = ["Charon", "Kore", "Puck", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];
const DEFAULT_VOICE = { interview: "Charon", tutor: "Kore" };
const FILLERS = {
  interview: /\b(um+|uh+|uhm+|erm+|hmm+|like|basically|you know|i mean|actually|kind of|sort of)\b/gi,
  tutor: /\b(äh+m?|ähm+|hm+|also|halt|quasi|irgendwie)\b/gi,
};
// Writing the prompt with fillers nudges Whisper to keep them instead of cleaning them up.
const WHISPER_PROMPT = { interview: "Umm, so, uh, I think, like, you know, hmm, basically...", tutor: "Ähm, also, äh, ich denke, halt, hmm, quasi..." };
const WHISPER_JUNK = new Set(["thank you", "thanks for watching", "you", "vielen dank", "untertitel im auftrag des zdf", "bis zum nächsten mal"]);

let mode = store.get("mode", "interview");
const S = {
  running: false, ending: false, ws: null, handle: null, kicked: false, cfg: null,
  ctx: null, stream: null, node: null, playHead: 0, sources: new Set(),
  startedAt: 0, clock: null, transcript: [], user: null, ai: null, lastUser: null,
  turnAudio: [], whisperJobs: [], notes: { soon: false, up: false }, pendingNote: null,
  muted: false, speakerMode: false, wake: null,
};

// ---------- settings ----------
const settings = () => store.get("settings", {});
function loadSettings() {
  const s = settings();
  $("#k-gemini").value = s.gemini || ""; $("#k-groq").value = s.groq || "";
  $("#m-live").value = s.live || ""; $("#m-report").value = s.report || "";
  $("#use-whisper").checked = s.whisper !== false;
  $("#listen").value = s.listen || "whisper";
  $("#me-name").value = s.name || ""; $("#me-about").value = s.about || "";
  if (!s.gemini) $("#settings").open = true;
}
function saveSettings() {
  store.set("settings", { gemini: $("#k-gemini").value.trim(), groq: $("#k-groq").value.trim(),
    live: $("#m-live").value.trim(), report: $("#m-report").value.trim(), whisper: $("#use-whisper").checked, listen: $("#listen").value,
    name: $("#me-name").value.trim(), about: $("#me-about").value.trim() });
  $("#settings").open = false; checkSetup();
}
function checkSetup() {
  const s = settings(), missing = [];
  if (!s.gemini) missing.push("a Gemini API key");
  if (!s.groq) missing.push("a Groq API key (for reports)");
  showWarn(missing.length ? `Add ${missing.join(" and ")} in Settings.` :
    (!window.isSecureContext ? "The microphone needs an https page." : ""));
  return !!s.gemini;
}

// ---------- setup form ----------
const form = () => document.querySelector(`#form-${mode}`);
function readConfig() {
  const cfg = Object.fromEntries(new FormData(form()).entries());
  cfg.minutes = Number(cfg.minutes) || 30;
  cfg.silence_ms = Number(cfg.silence_ms) || 1200;
  return cfg;
}
function loadConfig() {
  for (const m of ["interview", "tutor"]) {
    const f = document.querySelector(`#form-${m}`);
    f.querySelectorAll(".voices").forEach(sel => {
      sel.innerHTML = VOICES.map(v => `<option>${v}</option>`).join("");
      sel.value = DEFAULT_VOICE[m];
    });
    for (const [k, v] of Object.entries(store.get(`cfg-${m}`, {}))) if (f.elements[k]) f.elements[k].value = v;
    f.addEventListener("input", () => store.set(`cfg-${m}`, Object.fromEntries(new FormData(f).entries())));
  }
  $("#speaker-mode").checked = store.get("speakerMode", false);
}
function setMode(m) {
  mode = m; store.set("mode", m);
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.mode === m));
  $("#form-interview").hidden = m !== "interview";
  $("#form-tutor").hidden = m !== "tutor";
  if (m === "tutor") showRecurring();
}

// ---------- German mistakes memory ----------
function recurringErrors(limit = 8) {
  return store.get("germanErrors", []).slice()
    .sort((a, b) => (b.count || 1) - (a.count || 1) || String(b.last_seen).localeCompare(String(a.last_seen)))
    .slice(0, limit);
}
function mergeErrors(found) {
  const errs = store.get("germanErrors", []), today = new Date().toISOString().slice(0, 10);
  const key = e => `${(e.rule || "").toLowerCase()}|${(e.right || "").toLowerCase()}`;
  const index = new Map(errs.map(e => [key(e), e]));
  for (const n of found || []) {
    if (!n.wrong || !n.right) continue;
    const e = index.get(key(n));
    if (e) { e.count = (e.count || 1) + 1; e.last_seen = today; } else index.set(key(n), { ...n, count: 1, last_seen: today });
  }
  store.set("germanErrors", [...index.values()]);
}
function showRecurring() {
  const errs = recurringErrors();
  $("#recurring").innerHTML = errs.length
    ? `<span class="muted">Lena works these into the conversation (your repeat mistakes):</span><br>` +
      errs.map(e => `<span class="chip">${esc(e.right)} · ${e.count}x</span>`).join("")
    : `<span class="muted">After your first session, your repeat mistakes show up here and Lena practises them with you.</span>`;
}

// ---------- audio ----------
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.t = 0; this.out = new Int16Array(1600); this.n = 0; this.e = 0; this.k = 0; }
  process(inputs) {
    const x = inputs[0][0];
    if (!x) return true;
    for (let i = 0; i < x.length; i++) { this.e += x[i] * x[i]; this.k++; }
    while (this.t <= x.length - 1) {
      const i = Math.floor(this.t), f = this.t - i;
      const v = x[i] + ((i + 1 < x.length ? x[i + 1] : x[i]) - x[i]) * f;
      this.out[this.n++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      if (this.n === this.out.length) {
        this.port.postMessage({ pcm: this.out.buffer.slice(0), rms: Math.sqrt(this.e / this.k) });
        this.n = 0; this.e = 0; this.k = 0;
      }
      this.t += this.ratio;
    }
    this.t -= x.length;
    return true;
  }
}
registerProcessor("capture", Capture);`;

async function startAudio() {
  S.ctx = new (window.AudioContext || window.webkitAudioContext)();
  await S.ctx.resume();
  S.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  await S.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
  S.node = new AudioWorkletNode(S.ctx, "capture");
  S.node.port.onmessage = ({ data }) => {
    $("#level").style.width = `${Math.min(100, data.rms * 400)}%`;
    if (S.muted || !S.kicked) return;
    if (S.speakerMode && S.sources.size) return; // no headphones: keep the AI from hearing itself
    if (whisperListens()) return vad(data);
    S.turnAudio.push(data.pcm);
    if (S.ws?.readyState === 1)
      S.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(data.pcm), mimeType: "audio/pcm;rate=16000" } } }));
  };
  S.ctx.createMediaStreamSource(S.stream).connect(S.node);
  const sink = S.ctx.createGain(); sink.gain.value = 0; // keeps the worklet pulling audio on every browser
  S.node.connect(sink).connect(S.ctx.destination);
}
function stopAudio() {
  stopPlayback();
  S.stream?.getTracks().forEach(t => t.stop());
  S.node?.disconnect();
  S.ctx?.close().catch(() => {});
  S.ctx = S.stream = S.node = null;
}
function b64(buf) {
  const b = new Uint8Array(buf); let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function play(data) {
  const bin = atob(data), n = bin.length >> 1;
  const buf = S.ctx.createBuffer(1, n, 24000), ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 32768) v -= 65536;
    ch[i] = v / 32768;
  }
  const src = S.ctx.createBufferSource();
  src.buffer = buf; src.connect(S.ctx.destination);
  S.playHead = Math.max(S.playHead, S.ctx.currentTime + 0.04);
  src.start(S.playHead); S.playHead += buf.duration;
  S.sources.add(src); setStatus("speaking");
  src.onended = () => { S.sources.delete(src); if (!S.sources.size && S.running) { setStatus("listening"); flushNote(); } };
}
function stopPlayback() {
  for (const s of S.sources) { try { s.stop(); } catch {} }
  S.sources.clear(); S.playHead = 0;
}
function wav(chunks) {
  const len = chunks.reduce((a, c) => a + c.byteLength, 0), out = new DataView(new ArrayBuffer(44 + len));
  const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); out.setUint32(4, 36 + len, true); str(8, "WAVEfmt "); out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, 16000, true); out.setUint32(28, 32000, true);
  out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, "data"); out.setUint32(40, len, true);
  let o = 44; for (const c of chunks) { new Uint8Array(out.buffer, o, c.byteLength).set(new Uint8Array(c)); o += c.byteLength; }
  return new Blob([out.buffer], { type: "audio/wav" });
}

// ---------- live session ----------
function systemPrompt(cfg) {
  const s = settings();
  return mode === "tutor" ? tutorPrompt(cfg, recurringErrors(), { name: s.name, about: s.about }) : interviewerPrompt(cfg);
}
function connect() {
  const s = settings(), cfg = S.cfg;
  const ws = new WebSocket(`${LIVE_URL}?key=${encodeURIComponent(s.gemini)}`);
  S.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ setup: {
    model: s.live || DEFAULTS.live,
    generationConfig: { responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice || DEFAULT_VOICE[mode] } } } },
    systemInstruction: { parts: [{ text: systemPrompt(cfg) }] },
    ...(whisperListens() ? {} : { inputAudioTranscription: {} }), outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: cfg.silence_ms } },
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: S.handle ? { handle: S.handle } : {},
  } }));
  ws.onmessage = async ev => onMessage(JSON.parse(typeof ev.data === "string" ? ev.data : await ev.data.text()));
  ws.onclose = ev => {
    if (ws !== S.ws || !S.running || S.ending) return;
    if (!S.kicked) return fail(ev.reason ? `Gemini refused the session: ${ev.reason}` : "Could not connect to Gemini. Check the key in Settings.");
    // Google recycles connections about every 10 minutes; resume the same conversation.
    setStatus("reconnecting");
    if (!S.handle) return fail(`The connection dropped (${ev.code}). Start a new session.`);
    setTimeout(connect, 300);
  };
}
function onMessage(m) {
  if (m.setupComplete) {
    if (!S.kicked) { S.kicked = true; send({ realtimeInput: { text: KICKOFF[mode] } }); startClock(); }
    setStatus("listening");
  }
  if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) S.handle = m.sessionResumptionUpdate.newHandle;
  if (m.goAway) setStatus("reconnecting");
  const sc = m.serverContent;
  if (!sc) return;
  if (sc.inputTranscription?.text) userSaid(sc.inputTranscription.text);
  if (sc.outputTranscription?.text) aiSaid(sc.outputTranscription.text);
  for (const p of sc.modelTurn?.parts || []) if (p.inlineData?.data) {
    S.generating = true;
    if (S.dropAudio) continue; // the rest of an answer you already talked over
    closeUser(); play(p.inlineData.data);
  }
  if (sc.interrupted) { S.generating = false; S.dropAudio = false; stopPlayback(); closeAi(true); setStatus("listening"); }
  if (sc.turnComplete) { S.generating = false; S.dropAudio = false; closeAi(false); flushNote(); }
}
function send(obj) { if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(obj)); }

// ---------- transcript ----------
function userSaid(text) {
  const now = performance.now();
  // Live transcription trails the audio: a fragment arriving just after the AI
  // started answering still belongs to the previous answer.
  if (!S.user && S.lastUser && S.ai && now - S.ai.started < 2500) S.user = S.lastUser;
  if (!S.user) { S.user = addTurn("user"); S.user.first = now; }
  S.user.text += text; S.user.last = now;
  render(S.user);
}
function aiSaid(text) {
  closeUser();
  if (!S.ai) { S.ai = addTurn("assistant"); S.ai.started = performance.now(); }
  S.ai.text += text; render(S.ai);
}
function addTurn(role) {
  const t = { role, text: "", el: document.createElement("div") };
  t.el.className = `turn ${role}`;
  $("#transcript").appendChild(t.el);
  S.transcript.push(t);
  return t;
}
function render(t) {
  t.el.textContent = t.text.trim();
  if (t.metrics) {
    const meta = document.createElement("span"); meta.className = "meta";
    meta.textContent = `~${t.metrics.wpm} wpm · ${t.metrics.fillers} fillers · ${t.metrics.seconds}s${t.whisper ? " · whisper" : ""}`;
    t.el.appendChild(meta);
  }
  const box = $("#transcript"); box.scrollTop = box.scrollHeight;
}
function metricsFor(text, seconds) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  seconds = Math.max(1, Math.round(seconds));
  return { words, seconds, wpm: Math.round(words / (seconds / 60)), fillers: (text.match(FILLERS[mode]) || []).length };
}
function closeUser() {
  const u = S.user;
  if (!u) return;
  u.metrics = metricsFor(u.text, (u.last - u.first) / 1000 + 1);
  render(u); S.lastUser = u; S.user = null;
  const audio = S.turnAudio; S.turnAudio = [];
  if (settings().whisper !== false && settings().groq && audio.length > 5) S.whisperJobs.push(whisperTurn(u, audio));
}
function closeAi(interrupted) {
  if (!S.ai) return;
  if (interrupted) S.ai.el.classList.add("interrupted");
  S.ai = null;
  // After a finished AI turn the next answer starts fresh. After an interruption
  // you are already talking, so keep what was recorded.
  if (!interrupted) S.turnAudio = [];
}
async function whisperTurn(turn, chunks) {
  const r = await transcribe(chunks, DEFAULTS.whisper).catch(() => null);
  if (!r) return;
  turn.live = turn.text; turn.text = r.text; turn.whisper = true;
  turn.metrics = metricsFor(r.text, r.spoken || turn.metrics.seconds);
  render(turn);
}

// ---------- Whisper listens (better with accents) ----------
// The phone detects when you speak, Whisper large-v3 transcribes the clip, and
// Gemini gets the text. Gemini still speaks, and talking over it still stops it.
const whisperListens = () => settings().listen !== "gemini" && !!settings().groq;
function vadReset() { S.vad = { speaking: false, voiced: 0, silentMs: 0, buf: [], pre: [], floor: 0.006 }; }
function vad({ pcm, rms }) {
  const v = S.vad, thr = Math.max(0.012, v.floor * 3);
  if (!v.speaking) {
    v.pre.push(pcm); if (v.pre.length > 3) v.pre.shift();      // keep 0.3 s before speech starts
    if (rms > thr) v.voiced++; else { v.voiced = 0; v.floor = 0.95 * v.floor + 0.05 * rms; }
    if (v.voiced >= 2) {                                          // 0.2 s above the noise floor
      v.speaking = true; v.buf = [...v.pre]; v.silentMs = 0;
      if (S.sources.size || S.generating) bargeIn();
      setStatus("hearing");
    }
    return;
  }
  v.buf.push(pcm);
  v.silentMs = rms > thr ? 0 : v.silentMs + 100;
  const long = v.buf.length >= 600;                               // cap one answer at 60 s
  if (v.silentMs >= S.cfg.silence_ms || long) {
    const chunks = v.buf, ms = chunks.length * 100 - v.silentMs; // each chunk is 0.1 s of audio
    v.speaking = false; v.voiced = 0; v.buf = []; v.pre = [];
    setStatus("listening");
    if (ms >= 400) heard(chunks, ms);
  }
}
function bargeIn() {
  stopPlayback(); closeAi(true);
  S.dropAudio = S.generating; // ignore what is still on its way for the old answer
}
async function heard(chunks, ms) {
  const turn = addTurn("user"); turn.text = "…"; render(turn);
  S.pendingTurns++;
  const r = await transcribe(chunks, DEFAULTS.listen).catch(() => null);
  S.pendingTurns--;
  if (!r?.text) { turn.el.remove(); S.transcript.splice(S.transcript.indexOf(turn), 1); return; }
  turn.text = r.text; turn.whisper = true;
  turn.metrics = metricsFor(r.text, r.spoken || ms / 1000);
  render(turn); S.lastUser = turn;
  if (S.sources.size || S.generating) bargeIn();
  send({ realtimeInput: { text: r.text } });
}
async function transcribe(chunks, model) {
  const s = settings(), fd = new FormData();
  fd.append("file", wav(chunks), "speech.wav");
  fd.append("model", model);
  fd.append("language", mode === "tutor" ? "de" : "en");
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");
  fd.append("prompt", whisperPrompt());
  const r = await fetch(`${GROQ}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${s.groq}` }, body: fd });
  if (!r.ok) return null;
  const d = await r.json();
  const segs = (d.segments || []).filter(x => (x.no_speech_prob ?? 0) < 0.6);
  const text = segs.map(x => x.text).join(" ").replace(/\s+/g, " ").trim();
  if (!text || WHISPER_JUNK.has(text.toLowerCase().replace(/[.!?]/g, "").trim()) || text === whisperPrompt()) return null;
  return { text, spoken: segs.reduce((a, x) => a + (x.end - x.start), 0) };
}
// Whisper uses the prompt as context: words it should expect, and the style to keep (fillers).
function whisperPrompt() {
  const about = (settings().about || "").slice(0, 200);
  return `${about ? about + ". " : ""}${WHISPER_PROMPT[mode]}`;
}

// ---------- time ----------
function startClock() {
  S.startedAt = Date.now();
  S.clock = setInterval(() => {
    const s = Math.floor((Date.now() - S.startedAt) / 1000), mins = S.cfg.minutes;
    $("#clock").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")} / ${mins}:00`;
    if (!S.notes.soon && mins > 6 && s >= (mins - 5) * 60) { S.notes.soon = true; S.pendingNote = TIME_NOTES[mode].soon; }
    if (!S.notes.up && s >= mins * 60) { S.notes.up = true; S.pendingNote = TIME_NOTES[mode].up; }
    if (S.pendingNote && !S.user) flushNote();
  }, 500);
}
function flushNote() {
  if (!S.pendingNote || S.sources.size || S.ai || S.vad?.speaking || S.pendingTurns) return;
  send({ realtimeInput: { text: S.pendingNote } });
  S.pendingNote = null;
}

// ---------- start / end ----------
async function start() {
  if (!checkSetup()) { $("#settings").open = true; return; }
  S.cfg = readConfig(); store.set(`cfg-${mode}`, Object.fromEntries(new FormData(form()).entries()));
  S.speakerMode = $("#speaker-mode").checked; store.set("speakerMode", S.speakerMode);
  Object.assign(S, { running: true, ending: false, handle: null, kicked: false, transcript: [], user: null, ai: null,
    lastUser: null, turnAudio: [], whisperJobs: [], notes: { soon: false, up: false }, pendingNote: null, muted: false,
    generating: false, dropAudio: false, pendingTurns: 0 });
  vadReset();
  $("#transcript").innerHTML = ""; $("#report").hidden = true; $("#setup").hidden = true;
  $("#settings").hidden = true; $("#history").hidden = true; $("#live").hidden = false;
  $("#mute").textContent = "Mute mic"; $("#clock").textContent = "00:00";
  setStatus("connecting");
  try {
    await startAudio();
    connect();
    S.wake = await navigator.wakeLock?.request("screen").catch(() => null);
  } catch (e) { fail(e.name === "NotAllowedError" ? "Microphone permission was denied." : e.message); }
}
async function end() {
  if (!S.running) return;
  S.ending = true; S.running = false;
  clearInterval(S.clock); closeUser(); closeAi(false);
  try { S.ws?.close(); } catch {}
  stopAudio(); S.wake?.release?.().catch(() => {});
  setStatus("ended");
  const rep = $("#report"); rep.hidden = false;
  rep.innerHTML = `<p class="muted">Finishing the transcript...</p>`;
  await Promise.allSettled(S.whisperJobs);
  const transcript = S.transcript.filter(t => t.text.trim())
    .map(t => ({ role: t.role, text: t.text.trim(), metrics: t.metrics }));
  if (!transcript.some(t => t.role === "user")) { rep.innerHTML = `<p class="muted">Nothing was said, so there is no report.</p>${againButton()}`; return; }
  rep.innerHTML = `<p class="muted">Writing your report...</p>`;
  try {
    const report = await writeReport(transcript);
    if (mode === "tutor" && Array.isArray(report.errors)) mergeErrors(report.errors);
    saveSession(transcript, report);
    rep.innerHTML = renderReport(mode, report, transcript) + againButton();
  } catch (e) {
    saveSession(transcript, null);
    rep.innerHTML = `<p class="warn">Report failed: ${esc(e.message)}. The transcript is saved under Past sessions.</p>${againButton()}`;
  }
}
async function writeReport(transcript) {
  const s = settings();
  if (!s.groq) throw new Error("no Groq key in Settings");
  const lines = transcript.map(t => {
    const who = t.role === "assistant" ? (mode === "tutor" ? "Teacher" : "Interviewer") : (mode === "tutor" ? "Learner" : "Candidate");
    const m = t.metrics && mode === "interview" ? `  [about ${t.metrics.wpm} wpm, ${t.metrics.fillers} fillers, ${t.metrics.seconds}s]` : "";
    return `${who}: ${t.text}${m}`;
  });
  const model = s.report || DEFAULTS.report;
  const body = { model, max_tokens: 4000, temperature: 0.3, response_format: { type: "json_object" },
    messages: [{ role: "system", content: mode === "tutor" ? tutorFeedbackPrompt(S.cfg) : interviewFeedbackPrompt(S.cfg) },
               { role: "user", content: "Transcript:\n" + lines.join("\n") }] };
  if (model.startsWith("openai/gpt-oss")) Object.assign(body, { reasoning_effort: "medium", include_reasoning: false });
  const r = await fetch(`${GROQ}/chat/completions`, { method: "POST",
    headers: { Authorization: `Bearer ${s.groq}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `Groq returned ${r.status}`);
  const raw = d.choices?.[0]?.message?.content || "";
  try { return JSON.parse(raw); } catch { return { raw }; }
}
function fail(msg) {
  S.running = false; clearInterval(S.clock); stopAudio();
  $("#live").hidden = true; $("#setup").hidden = false; $("#settings").hidden = false; $("#history").hidden = false;
  showWarn(msg);
}
function setStatus(s) {
  const el = $("#status");
  el.className = `pill ${s}`;
  el.textContent = { connecting: "connecting", listening: "listening", hearing: "hearing you",
    speaking: S.speakerMode ? "speaking" : "speaking · talk to interrupt", reconnecting: "reconnecting", ended: "ended" }[s] || s;
}
function showWarn(msg) { const w = $("#warn"); w.textContent = msg || ""; w.hidden = !msg; }
function againButton() { return `<button class="primary" onclick="location.reload()">New session</button>`; }

// ---------- history ----------
function saveSession(transcript, report) {
  const cfg = { ...S.cfg }; delete cfg.cv; delete cfg.jd;
  const list = store.get("sessions", []);
  list.unshift({ at: new Date().toISOString(), mode, cfg, transcript, report });
  store.set("sessions", list.slice(0, 40));
}
function renderHistory() {
  const list = store.get("sessions", []);
  $("#history-list").innerHTML = list.length ? list.map((s, i) => {
    const what = s.mode === "tutor" ? `German · ${s.cfg.level} · ${s.cfg.scenario}` : `${s.cfg.company || "Interview"} · ${s.cfg.round}`;
    return `<button class="hist" data-i="${i}">${new Date(s.at).toLocaleString()} · ${esc(what)}</button>`;
  }).join("") : `<p class="muted">No sessions yet.</p>`;
  document.querySelectorAll(".hist").forEach(b => b.onclick = () => {
    const s = list[Number(b.dataset.i)], rep = $("#report");
    rep.hidden = false;
    rep.innerHTML = (s.report ? renderReport(s.mode, s.report, s.transcript) : `<p class="muted">No report for this session.</p>`) +
      `<h3>Transcript</h3>${s.transcript.map(t => `<p><b>${t.role === "user" ? "You" : "AI"}:</b> ${esc(t.text)}</p>`).join("")}`;
    rep.scrollIntoView({ behavior: "smooth" });
  });
}

// ---------- reports ----------
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function list(items) { return `<ul>${(items || []).map(i => `<li>${esc(i)}</li>`).join("")}</ul>`; }
function renderReport(m, r, transcript) { return m === "tutor" ? tutorReport(r) : interviewReport(r, transcript); }
function interviewReport(r, transcript) {
  if (r.raw) return `<h2>Report</h2><pre>${esc(r.raw)}</pre>`;
  const answers = transcript.filter(t => t.role === "user" && t.metrics);
  const avg = answers.length ? Math.round(answers.reduce((a, t) => a + t.metrics.wpm, 0) / answers.length) : 0;
  const fillers = answers.reduce((a, t) => a + t.metrics.fillers, 0);
  return `<h2>Interview report</h2><p>${esc(r.overall)}</p>
    <div class="scores">${Object.entries(r.scores || {}).map(([k, v]) => `<span class="score">${esc(k)} <b>${esc(v)}/5</b></span>`).join("")}
    <span class="score">pace <b>~${avg} wpm</b></span><span class="score">fillers <b>${fillers}</b></span></div>
    <h3>Fix these first</h3>${list(r.top_fixes)}
    <h3>Answer by answer</h3>${(r.per_answer || []).map(a => `<details class="ans"><summary><span class="v-${esc(a.verdict)}">${esc(a.verdict)}</span> · ${esc(a.question)}</summary>
      <p><b>Worked:</b> ${esc(a.worked)}</p><p><b>Missing:</b> ${esc(a.missing)}</p><p><b>Stronger:</b> ${esc(a.better)}</p></details>`).join("")}
    <h3>Expect next round</h3>${list(r.questions_to_expect_next)}
    <p class="muted">Pace and filler counts are estimates.</p>`;
}
function tutorReport(r) {
  if (r.raw) return `<h2>Bericht</h2><pre>${esc(r.raw)}</pre>`;
  return `<h2>German report <span class="muted">· level ${esc(r.level_estimate)}</span></h2><p>${esc(r.summary)}</p>
    <h3>Corrections</h3>${(r.errors || []).length ? `<table><tr><th>You said</th><th>Correct</th><th>Rule</th></tr>${r.errors.map(e =>
      `<tr><td>${esc(e.wrong)}</td><td>${esc(e.right)}</td><td class="muted">${esc(e.rule)}</td></tr>`).join("")}</table>` : `<p>No mistakes found.</p>`}
    <h3>New words</h3>${(r.new_words || []).length ? `<table>${r.new_words.map(w => `<tr><td>${esc(w.de)}</td><td class="muted">${esc(w.en)}</td></tr>`).join("")}</table>` : `<p class="muted">None.</p>`}
    <h3>Next time</h3><p>${esc(r.next_focus)}</p>`;
}

// ---------- wiring ----------
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => { if (!S.running) setMode(b.dataset.mode); });
$("#start").onclick = start;
$("#end").onclick = end;
$("#save-settings").onclick = saveSettings;
$("#mute").onclick = () => { S.muted = !S.muted; $("#mute").textContent = S.muted ? "Unmute mic" : "Mute mic"; };
$("#history").addEventListener("toggle", () => { if ($("#history").open) renderHistory(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

loadSettings(); loadConfig(); setMode(mode); checkSetup();
