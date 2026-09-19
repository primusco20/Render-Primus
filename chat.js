/**
 * chat.js — Primus Smart Chat
 * ===========================================================================
 * Everything the in-page assistant does, in one file: the chat window UI,
 * voice replies (speech synthesis) and voice input (speech recognition), the
 * conversation persistence layer, the rule-based assistant itself, and the
 * guided booking flow that runs inside the chat.
 *
 * Extracted from index.html so this can be edited without scrolling through
 * 13,000 lines of unrelated page code. Nothing else changed in the move.
 *
 * ---------------------------------------------------------------------------
 * How this shares state with index.html
 * ---------------------------------------------------------------------------
 * index.html's main script is a CLASSIC (non-module) script at global scope,
 * and so is this one, so the two share one global scope. That means:
 *
 *   - Everything here can read index.html's globals directly — appSettings,
 *     escapeAttr(), persistSettings(), paidMembers, and so on. No imports, no
 *     window.* prefixing, no build step.
 *   - index.html can call into here the same way (its init calls
 *     restoreChatHistory(), and inline onclick handlers call toggleChat()).
 *
 * Two rules follow from that, and breaking either will break the page:
 *
 *   1. LOAD ORDER. This file must be loaded AFTER index.html's inline script.
 *      Top-level `const`/`let` in a classic script live in the shared global
 *      lexical environment but are in the temporal dead zone until their
 *      declaration runs — so if this loaded first, the code at the bottom of
 *      this file would throw on appSettings before index.html defined it.
 *
 *   2. NO DUPLICATE TOP-LEVEL NAMES. A `const` here with the same name as one
 *      in index.html is a SyntaxError that kills BOTH scripts, not a silent
 *      shadow. Verified clean at extraction time.
 *
 * The state below (chatSpeechEnabled, voiceRecognizer, chatFlow, chatBooking,
 * and the rest) was confirmed to be referenced only by this file's own code
 * before it moved, so nothing in index.html reaches into it.
 *
 * Not in here: the live call console (PeerJS / WebRTC). It's a separate
 * feature that happens to sit next to the chat in index.html — only
 * openSupportChat() below bridges to it.
 */


/* =========================================================================
   PART 1 — Voice replies, voice input, and the chat window itself
   (was index.html lines 5132-5882)
   ========================================================================= */
// ---------- Voice replies: on/off toggle + natural voice selection ----------
let chatSpeechEnabled = (function () {
  const saved = localStorage.getItem('primus_chat_speech_enabled');
  return saved === null ? true : saved === 'true';
})();

let cachedVoice = null;
function pickNaturalVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices || !voices.length) return null;

  // Prefer the most natural-sounding MALE system/browser voices first.
  // These "Online (Natural)" voices (Edge) and platform voices (macOS/Google)
  // are the closest a browser can get to a smooth, human, deep male voice —
  // browsers cannot access OpenAI's/ChatGPT's proprietary voice models, only
  // the voices installed on the visitor's own device.
  const preferredMaleNames = [
    'Microsoft Guy Online (Natural)', 'Microsoft Andrew Online (Natural)',
    'Microsoft Brian Online (Natural)', 'Microsoft Christopher Online (Natural)',
    'Microsoft Davis Online (Natural)', 'Microsoft Eric Online (Natural)',
    'Microsoft Roger Online (Natural)', 'Microsoft Steffan Online (Natural)',
    'Microsoft Tony Online (Natural)', 'Microsoft Jason Online (Natural)',
    'Google UK English Male', 'Daniel', 'Alex', 'Fred', 'Aaron', 'Arthur',
    'Oliver', 'David', 'Mark', 'James', 'George', 'Thomas', 'Ryan'
  ];
  for (const name of preferredMaleNames) {
    const match = voices.find(v => v.name === name || v.name.includes(name));
    if (match) return match;
  }
  // Any other voice explicitly labeled Natural/Neural + looks male by name.
  const naturalMale = voices.find(v => /natural|neural/i.test(v.name) && /male/i.test(v.name) && !/female/i.test(v.name));
  if (naturalMale) return naturalMale;
  // Any Natural/Neural English voice at all (still far more human than default robotic voices).
  const natural = voices.find(v => /natural|neural/i.test(v.name) && v.lang && v.lang.startsWith('en'));
  if (natural) return natural;
  // Fall back to any English voice, then whatever is available.
  return voices.find(v => v.lang && v.lang.startsWith('en')) || voices[0];
}
if ('speechSynthesis' in window) {
  // Voice lists load asynchronously in most browsers.
  window.speechSynthesis.onvoiceschanged = () => { cachedVoice = pickNaturalVoice(); };
  cachedVoice = pickNaturalVoice();
}

// Keeps the interrupt-hint pill locked to the top edge of the chat
// window itself — recalculated continuously while the hint is showing
// (see trackSpeakHintPosition below) — so it follows the widget through
// expand/collapse, the on-screen keyboard shifting it, etc. instead of
// sitting at one fixed spot on the page.
function positionSpeakHint() {
  const hint = document.getElementById('chatSpeakHint');
  const chatWin = document.getElementById('chatWindow');
  if (!hint || !chatWin) return;
  const winRect = chatWin.getBoundingClientRect();
  const hintRect = hint.getBoundingClientRect();
  const gap = 10;
  const halfWidth = (hintRect.width || 160) / 2;
  let left = winRect.left + winRect.width / 2;
  let top = winRect.top - (hintRect.height || 30) - gap;
  // Clamp so a very short screen, or the window sitting near an edge,
  // can never push the pill off the top or sides of the viewport.
  top = Math.max(gap, top);
  left = Math.min(Math.max(left, halfWidth + gap), window.innerWidth - halfWidth - gap);
  hint.style.left = left + 'px';
  hint.style.top = top + 'px';
}

let speakHintRaf = null;
function trackSpeakHintPosition() {
  positionSpeakHint();
  speakHintRaf = requestAnimationFrame(trackSpeakHintPosition);
}

// Small floating "you can interrupt me" banner shown only while a reply
// is actually being read out loud. Tapping its ✕ interrupts right away.
function showSpeakHint() {
  const hint = document.getElementById('chatSpeakHint');
  if (!hint) return;
  positionSpeakHint();
  hint.classList.add('show');
  if (!speakHintRaf) trackSpeakHintPosition();
}
function hideSpeakHint() {
  const hint = document.getElementById('chatSpeakHint');
  if (hint) hint.classList.remove('show');
  if (speakHintRaf) { cancelAnimationFrame(speakHintRaf); speakHintRaf = null; }
}

// The interrupt hint's ✕ — cuts the bot off immediately, same as
// tapping the mic or typing, then hands focus straight to the input.
function interruptSpeaking() {
  safeCancelSpeech();
  const input = document.getElementById('chatInput');
  if (input) input.focus();
}

// Cancels any in-progress speech, but ONLY if the engine is actually
// mid-utterance. Calling speechSynthesis.cancel() while nothing is
// speaking is what leaves Chrome's speech engine permanently "stuck" —
// every speak() call after that is silently swallowed (no audio, no
// onstart, no onerror, nothing) until the page is reloaded. That's what
// made voice replies go silent for good the first time the chat was
// closed and reopened: closing the widget used to call cancel()
// unconditionally, even when the bot wasn't speaking, which could tip
// the engine into that stuck state right then and there.
function safeCancelSpeech() {
  // Invalidates any sequence currently stepping through its parts, so it stops
  // between chunks instead of continuing underneath the next reply.
  speechRun++;
  if ('speechSynthesis' in window && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) {
    window.speechSynthesis.cancel();
  }
  hideSpeakHint();
}

// iOS Safari (and Chrome's autoplay policy) will only start speech if the
// FIRST speechSynthesis.speak() of the page session happens synchronously
// inside a real user gesture. Our replies are spoken after an await and a
// typing delay, so by then the gesture is long gone and every utterance is
// dropped silently — no audio, no onstart, no onerror. That is why voice
// appeared broken on iPhone regardless of which assistant produced the
// reply. Speaking one silent utterance from inside the tap unlocks the
// engine for the rest of the session.
let speechUnlocked = false;
function primeSpeechSynthesis() {
  if (speechUnlocked || !('speechSynthesis' in window)) return;
  try {
    // The warm-up used to be a single space. iOS Safari discards utterances
    // with no speakable content, so it never counted as the unlocking
    // gesture and the engine stayed locked for the whole session — which is
    // why replies were silent on iPhone even with the priming call in place.
    // A real (very short) string at volume 0 does unlock it and is inaudible.
    const warmup = new SpeechSynthesisUtterance('ok');
    warmup.volume = 0;
    warmup.rate = 2;
    window.speechSynthesis.speak(warmup);
    // iOS can also leave the queue paused after a backgrounded tab; resuming
    // inside the same gesture clears that.
    window.speechSynthesis.resume();
    speechUnlocked = true;
  } catch (e) {
    speechUnlocked = true;
  }

  // The Web Audio context behind the symbol cues needs a gesture of its own —
  // created outside one it starts 'suspended' and every cue is silent. Same
  // tap unlocks both.
  try {
    const ctx = getCueAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  } catch (e) {
    // Never let a warm-up failure block sending the message.
    speechUnlocked = true;
  }
}

// ---------------------------------------------------------------------------
// Making the voice sound less like a screen reader
// ---------------------------------------------------------------------------
// Browser speech engines read literally: "₱500" becomes "P five hundred",
// "✅" becomes "check mark button", "9:00 AM - 8:00 PM" runs together, and a
// URL is spelled out character by character. Normalising the text before it
// is spoken does more for how human this sounds than any voice setting.
// ---------------------------------------------------------------------------
// Symbol cues: play a sound instead of reading the symbol aloud
// ---------------------------------------------------------------------------
// Speech engines announce symbols by name — "✅" becomes "check mark button",
// "•" becomes "bullet", "→" becomes "rightwards arrow". Stripping them (what
// this did before) loses the meaning; reading them is worse. So the ones that
// carry meaning become a short tone, and the purely decorative ones are
// dropped.
//
// The tones are synthesised with the Web Audio API — no audio files to host,
// nothing to download, and they work offline.

let cueAudioCtx = null;

function getCueAudioCtx() {
  if (cueAudioCtx) return cueAudioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try { cueAudioCtx = new Ctx(); } catch (e) { return null; }
  return cueAudioCtx;
}

// Each cue is a little melody: [frequency in Hz, seconds].
const SPEECH_CUES = {
  success:   { type: 'sine',     gain: 0.10, tones: [[659, 0.07], [880, 0.13]] },
  error:     { type: 'sine',     gain: 0.10, tones: [[330, 0.10], [220, 0.16]] },
  warn:      { type: 'triangle', gain: 0.09, tones: [[540, 0.09], [0, 0.04], [540, 0.09]] },
  celebrate: { type: 'sine',     gain: 0.09, tones: [[523, 0.06], [659, 0.06], [784, 0.06], [1047, 0.15]] },
  info:      { type: 'sine',     gain: 0.08, tones: [[880, 0.09]] },
  bullet:    { type: 'sine',     gain: 0.05, tones: [[720, 0.045]] },
  arrow:     { type: 'sine',     gain: 0.06, tones: [[620, 0.05], [830, 0.07]] },
  star:      { type: 'triangle', gain: 0.07, tones: [[988, 0.06], [1319, 0.09]] },
  wave:      { type: 'sine',     gain: 0.07, tones: [[784, 0.08], [988, 0.10]] },
  waiting:   { type: 'sine',     gain: 0.07, tones: [[440, 0.09], [392, 0.11]] },
};

// Order matters: the first pattern that matches a character wins.
const SYMBOL_CUES = [
  [/[\u2705\u2713\u2714]/u,                 'success'],   // ✅ ✓ ✔
  [/[\u274C\u2715\u2716\u2717\u2718]/u,     'error'],     // ❌ ✕ ✖ ✗ ✘
  [/[\u26A0\u26A1]/u,                        'warn'],      // ⚠ ⚡
  [/[\u{1F389}\u{1F38A}\u{1F973}]/u,         'celebrate'], // 🎉 🎊 🥳
  [/[\u2139\u{1F4A1}]/u,                      'info'],      // ℹ 💡
  [/[\u2605\u2606\u2B50\u2726\u2727]/u,     'star'],      // ★ ☆ ⭐ ✦ ✧
  [/[\u2190-\u2199\u25B8\u25B6\u27A1]/u,    'arrow'],     // ← → ▸ ▶ ➡
  [/[\u2022\u00B7\u25CF\u25CB\u25AA]/u,     'bullet'],    // • · ● ○ ▪
  [/[\u{1F44B}\u{1F64C}\u{1F44D}]/u,          'wave'],      // 👋 🙌 👍
  [/[\u23F3\u231B\u23F1]/u,                  'waiting'],   // ⏳ ⌛ ⏱
];

function cueForChar(ch) {
  for (const [re, name] of SYMBOL_CUES) if (re.test(ch)) return name;
  return null;
}

// Plays one cue and resolves when it has finished, so speech can be sequenced
// around it. Resolves immediately (rather than rejecting) if audio is
// unavailable — a missing cue must never stall a reply.
function playCue(name) {
  return new Promise((resolve) => {
    const spec = SPEECH_CUES[name];
    const ctx = getCueAudioCtx();
    if (!spec || !ctx) { resolve(); return; }
    try {
      if (ctx.state === 'suspended') ctx.resume();
      let t = ctx.currentTime + 0.01;
      for (const [freq, dur] of spec.tones) {
        if (freq > 0) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = spec.type;
          osc.frequency.setValueAtTime(freq, t);
          // Short fade in/out — a hard start or stop clicks audibly.
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(spec.gain, t + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t);
          osc.stop(t + dur + 0.02);
        }
        t += dur;
      }
      const totalMs = spec.tones.reduce((s, [, d]) => s + d, 0) * 1000 + 40;
      setTimeout(resolve, totalMs);
    } catch (e) { resolve(); }
  });
}

// Splits a reply into an ordered list of things to say and sounds to play:
//   [{ text: 'All set' }, { cue: 'success' }, { text: 'See you Friday' }]
function splitForSpeech(text) {
  const parts = [];
  let buf = '';
  const flush = () => {
    const t = speechFriendly(buf);
    if (t) parts.push({ text: t });
    buf = '';
  };
  for (const ch of String(text || '')) {
    const cue = cueForChar(ch);
    if (cue) { flush(); parts.push({ cue }); }
    else buf += ch;
  }
  flush();
  // Collapse runs of the same cue ("✅✅") into one sound.
  return parts.filter((p, i) => !(p.cue && parts[i - 1] && parts[i - 1].cue === p.cue));
}

function speechFriendly(text) {
  let t = String(text || '');

  // Whatever pictographs are left after splitForSpeech() has extracted the
  // meaningful ones. These carry no meaning worth a sound, and reading them
  // by name ("barber pole", "variation selector") is noise.
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{FE0F}\u{2022}]/gu, ' ');

  // Currency and numbers the way a person would say them.
  const cur = (appSettings && appSettings.currency) || '₱';
  const curWord = cur === '₱' ? 'pesos' : cur === '$' ? 'dollars' : '';
  if (curWord) {
    t = t.replace(new RegExp('\\' + cur + '\\s?([\\d,]+(?:\\.\\d+)?)', 'g'),
                  (_, n) => `${n.replace(/,/g, '')} ${curWord}`);
  }

  // Ranges and separators read as pauses rather than as dashes.
  t = t.replace(/\s+[–—-]\s+/g, ', ');
  t = t.replace(/\s*·\s*/g, ', ');

  // Bare URLs and emails get spelled out letter by letter otherwise.
  t = t.replace(/https?:\/\/\S+/g, 'the link on screen');
  t = t.replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, 'the email address on screen');

  // Membership IDs like MEM-12345 are read as one run-on word.
  t = t.replace(/\bMEM-(\d+)/gi, (_, n) => 'member ' + n.split('').join(' '));

  // A short pause after each sentence, which is most of what makes synthesised
  // speech sound rushed and flat.
  t = t.replace(/([.!?])\s+/g, '$1  ');

  return t.replace(/\s{3,}/g, '  ').trim();
}

// Every reason speech can silently do nothing, in one place. Run
// primusVoiceDiagnostics() in the browser console to see which one applies —
// this class of bug produces no audio, no onstart and no onerror, so without
// it there is nothing to go on.
function primusVoiceDiagnostics() {
  const chatWin = document.getElementById('chatWindow');
  const voices = ('speechSynthesis' in window) ? window.speechSynthesis.getVoices() : [];
  const report = {
    supported: 'speechSynthesis' in window,
    speechToggleOn: chatSpeechEnabled,
    chatWindowOpen: !!(chatWin && chatWin.classList.contains('open')),
    tabVisible: !document.hidden,
    unlockedByGesture: speechUnlocked,
    voicesLoaded: voices.length,
    chosenVoice: (cachedVoice || pickNaturalVoice() || {}).name || '(browser default)',
    engineSpeaking: ('speechSynthesis' in window) ? window.speechSynthesis.speaking : false,
  };
  const blockers = [];
  if (!report.supported) blockers.push('This browser has no speech synthesis.');
  if (!report.speechToggleOn) blockers.push('Voice replies are muted — tap the speaker icon in the chat header.');
  if (!report.chatWindowOpen) blockers.push('The chat window is closed; replies are never spoken to a closed window.');
  if (!report.tabVisible) blockers.push('This tab is in the background.');
  if (!report.unlockedByGesture) blockers.push('No tap has primed the engine yet — send one message first.');
  if (!report.voicesLoaded) blockers.push('No voices installed/loaded yet.');
  console.table(report);
  console.log(blockers.length ? 'Blocked by: ' + blockers.join(' | ')
    : 'Nothing is blocking speech here. If it is still silent on iPhone, check the physical mute switch — iOS routes speech through the ringer channel and silences it when muted.');
  return report;
}
if (typeof window !== 'undefined') window.primusVoiceDiagnostics = primusVoiceDiagnostics;

// Bumped every time speech is cancelled. A sequence that is mid-flight checks
// this between parts and abandons itself, so a new reply can never be heard
// interleaved with the tail of the previous one.
let speechRun = 0;

// Speaks one chunk and resolves when it ends. Keeps the two safety nets the
// single-utterance version had: the periodic pause/resume that stops Chrome
// dropping anything over ~15s, and the one retry for the case where speak()
// is silently swallowed right after a cancel().
function speakChunk(str, runId) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };

    const attempt = (isRetry) => {
      if (runId !== speechRun) { done(); return; }
      const utterance = new SpeechSynthesisUtterance(str);
      const voice = cachedVoice || pickNaturalVoice();
      if (voice) utterance.voice = voice;
      // Was rate 1.22 / pitch 0.82 — fast and artificially deepened, which is
      // most of what made this sound synthetic. Human conversational pace is
      // close to the engine's default, and leaving pitch alone avoids the
      // "processed" timbre that pitch-shifting introduces.
      utterance.rate = 0.98;
      utterance.pitch = 1.0;
      utterance.volume = 1;

      const resumeTimer = setInterval(() => {
        if (!('speechSynthesis' in window) || !window.speechSynthesis.speaking) { clearInterval(resumeTimer); return; }
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }, 12000);
      const stop = () => clearInterval(resumeTimer);

      utterance.onstart = showSpeakHint;
      utterance.onend = () => { stop(); done(); };
      utterance.onerror = () => { stop(); done(); };
      window.speechSynthesis.speak(utterance);

      if (!isRetry) {
        setTimeout(() => {
          if (settled || runId !== speechRun) return;
          if ('speechSynthesis' in window && !window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
            window.speechSynthesis.cancel();
            attempt(true);
          }
        }, 300);
      }
    };

    attempt(false);
  });
}

function speakText(text, onDone) {
  const finish = () => { if (typeof onDone === 'function') onDone(); };
  if (!chatSpeechEnabled || !text) { finish(); return; }
  if (!('speechSynthesis' in window)) { finish(); return; }
  // Never read a reply out loud unless the Smart Chat window is actually
  // open on screen and the tab itself is visible. A reply that arrives
  // (or finishes "thinking") after the customer closed the widget, or
  // after they minimized/switched away from the browser tab, should stay
  // silent rather than talking to a closed window.
  const chatWin = document.getElementById('chatWindow');
  if (!chatWin || !chatWin.classList.contains('open') || document.hidden) { finish(); return; }

  safeCancelSpeech();
  const runId = ++speechRun;

  const parts = splitForSpeech(text);
  if (!parts.length) { finish(); return; }

  // A brief delay after cancel() lets the engine actually reset before the
  // next utterance is queued — queuing again in the very same tick is a
  // common way the "no audio, no error" bug gets triggered.
  setTimeout(async () => {
    for (const part of parts) {
      if (runId !== speechRun) return;           // superseded by a newer reply
      if (part.cue) await playCue(part.cue);
      else await speakChunk(part.text, runId);
    }
    if (runId !== speechRun) return;
    hideSpeakHint();
    finish();
  }, 50);
}

// If the browser tab is minimized or switched away from mid-reply, cut the
// voice off immediately instead of letting it keep talking in the
// background — it will only resume speaking for a *new* reply once the
// tab is visible and the chat window is open again.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) safeCancelSpeech();
});

const CHAT_ICON_SPEAKER_ON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
const CHAT_ICON_SPEAKER_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';

function updateSpeechToggleUI() {
  const btn = document.getElementById('speechToggleBtn');
  if (!btn) return;
  btn.innerHTML = chatSpeechEnabled ? CHAT_ICON_SPEAKER_ON : CHAT_ICON_SPEAKER_OFF;
  btn.classList.toggle('is-off', !chatSpeechEnabled);
  btn.title = chatSpeechEnabled ? 'Voice replies on — tap to mute' : 'Voice replies off — tap to unmute';
}

function toggleSpeechEnabled() {
  chatSpeechEnabled = !chatSpeechEnabled;
  localStorage.setItem('primus_chat_speech_enabled', String(chatSpeechEnabled));
  updateSpeechToggleUI();
  if (!chatSpeechEnabled) safeCancelSpeech();
}
updateSpeechToggleUI();

// ---------- Voice input (speech-to-text) ----------
// Uses the browser's own built-in speech recognition (the Web Speech API —
// the same engine Chrome/Edge/Safari use natively) to transcribe what the
// customer says into text. This runs entirely in the browser: no GPT,
// Claude, or Gemini API is involved in turning speech into text (none of
// them expose a speech-recognition endpoint a static page could call for
// free) — instead, the transcribed text becomes a normal chat message,
// which is then free to be answered by GPT/Claude/Gemini (see the
// "Advanced AI" section below) exactly like anything typed by hand.
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let voiceRecognizer = null;
let voiceListening = false;
let voiceFinalTranscript = '';
// Once true, the mic automatically re-opens after each bot reply instead
// of requiring a fresh tap of the mic button every turn — a hands-free,
// back-and-forth "conversation mode" like a voice assistant. Turned on by
// tapping the mic to start, turned off by tapping it again mid-listen,
// closing the chat, or clearing the conversation.
let voiceConvoMode = false;

function isVoiceInputSupported() { return !!SpeechRecognitionAPI; }

// True for the brief window between calling recognizer.start() and the
// browser confirming it actually started (or rejecting it). Stops a fast
// second tap of the mic from calling start() on top of a start that's
// still pending, which is one of the ways this used to end up silently
// wedged so a second attempt wouldn't do anything either.
let voiceStarting = false;

// A SpeechRecognition instance is only really good for one listening
// session. Reusing the same object across multiple stop/start cycles is
// a well-documented way it goes silently dead in Chrome/Edge — no error,
// no onstart, no onresult, nothing — which is exactly what "closing the
// chat breaks it" and "pressing it again doesn't work" look like from
// the outside. So instead of one long-lived recognizer, a brand-new
// instance (with its own fresh event handlers) is built every time
// listening starts, and any previous one is fully torn down first.
function createVoiceRecognizer() {
  const recognizer = new SpeechRecognitionAPI();
  recognizer.continuous = false;      // stops on its own after a pause in speech
  recognizer.interimResults = true;   // stream partial words into the speech bar as they're heard
  recognizer.maxAlternatives = 1;
  recognizer.lang = (navigator.language || 'en-US');

  recognizer.onstart = () => { voiceStarting = false; };

  recognizer.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcriptPiece = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += transcriptPiece;
      else interim += transcriptPiece;
    }
    if (final) voiceFinalTranscript = (voiceFinalTranscript + ' ' + final).trim();
    updateSpeechBarText(voiceFinalTranscript || interim, !(voiceFinalTranscript || interim));
  };

  recognizer.onerror = (event) => {
    voiceStarting = false;
    stopVoiceListeningUI();
    const input = document.getElementById('chatInput');
    if (event.error === 'no-speech' || event.error === 'aborted') {
      // Nothing heard, or deliberately cut off (chat closed, mic tapped
      // again, bot interrupted mid-reply) — quietly reset, nothing to
      // alarm the customer with.
      return;
    }
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      voiceConvoMode = false;
      appendBotMessage('I need microphone access to hear you — please allow it in your browser, or just type your message instead.');
      return;
    }
    if (input && voiceFinalTranscript) input.value = voiceFinalTranscript;
  };

  recognizer.onend = () => {
    voiceStarting = false;
    stopVoiceListeningUI();
    // This instance is spent — always discard it rather than trying to
    // start() it again later. Trying to reuse it is exactly the pattern
    // that leaves voice input dead after the first use.
    if (voiceRecognizer === recognizer) voiceRecognizer = null;

    const input = document.getElementById('chatInput');
    const chatWin = document.getElementById('chatWindow');
    const chatIsOpen = !!(chatWin && chatWin.classList.contains('open'));
    const finalText = voiceFinalTranscript.trim();
    voiceFinalTranscript = '';
    // If the chat got closed while this was still listening, don't let a
    // leftover transcript quietly turn into a sent message (or keep the
    // mic auto-reopening) after the window is already gone.
    if (input && finalText && chatIsOpen) {
      input.value = finalText;
      // Voice input is a "say it and it's sent" flow — no extra tap on
      // Send needed. The short pause just lets the customer see the
      // recognized text land in the box for a beat before it's sent.
      setTimeout(() => sendChatMessage(), 350);
    } else if (voiceConvoMode && chatIsOpen) {
      // In conversation mode, a silent/empty turn (recognizer timed out
      // with nothing heard) shouldn't drop back to typing mode — just
      // keep listening, same as a real back-and-forth would.
      setTimeout(() => { if (voiceConvoMode && !voiceListening) resumeVoiceListening(); }, 400);
    }
  };

  return recognizer;
}

function updateSpeechBarText(text, isPlaceholder) {
  const el = document.getElementById('chatSpeechBarText');
  if (!el) return;
  el.textContent = text && text.trim() ? text : 'Listening…';
  el.classList.toggle('placeholder', !!isPlaceholder || !text || !text.trim());
}

// ---------- Voice input: live "vocal frequency" visualizer ----------
// SpeechRecognition (used above for transcription) never exposes the
// raw microphone audio, so a real, audio-reactive equalizer needs a
// second, separate mic stream purely for visualization via the Web
// Audio API's AnalyserNode. This never touches transcription — if it's
// denied or unsupported, voice input keeps working exactly as before
// and the bars just keep their idle CSS bounce instead of reacting to
// actual volume.
let vizAudioCtx = null;
let vizAnalyser = null;
let vizStream = null;
let vizRafId = null;
let vizDataArray = null;

async function startVoiceViz() {
  try {
    vizStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    vizAudioCtx = new AudioCtx();
    if (vizAudioCtx.state === 'suspended') { try { await vizAudioCtx.resume(); } catch (e) {} }
    const source = vizAudioCtx.createMediaStreamSource(vizStream);
    vizAnalyser = vizAudioCtx.createAnalyser();
    vizAnalyser.fftSize = 32;
    vizAnalyser.smoothingTimeConstant = 0.55;
    source.connect(vizAnalyser);
    vizDataArray = new Uint8Array(vizAnalyser.frequencyBinCount);
    const viz = document.getElementById('chatSpeechBarViz');
    if (viz) viz.classList.add('live');
    runVoiceVizFrame();
  } catch (e) {
    // Mic access for the visualizer only was denied/unavailable — the
    // idle CSS bounce (the bars' default look) carries the UI instead.
  }
}

function runVoiceVizFrame() {
  if (!vizAnalyser || !voiceListening) return;
  vizAnalyser.getByteFrequencyData(vizDataArray);
  const bars = document.querySelectorAll('#chatSpeechBarViz span');
  const step = Math.max(1, Math.floor(vizDataArray.length / bars.length));
  bars.forEach((bar, i) => {
    const level = vizDataArray[i * step] / 255; // 0..1
    bar.style.setProperty('--bar', Math.max(0.18, Math.min(1, level * 1.6)).toFixed(2));
  });
  vizRafId = requestAnimationFrame(runVoiceVizFrame);
}

function stopVoiceViz() {
  if (vizRafId) cancelAnimationFrame(vizRafId);
  vizRafId = null;
  if (vizStream) { vizStream.getTracks().forEach(t => t.stop()); vizStream = null; }
  if (vizAudioCtx) { vizAudioCtx.close().catch(() => {}); vizAudioCtx = null; }
  vizAnalyser = null;
  const viz = document.getElementById('chatSpeechBarViz');
  if (viz) {
    viz.classList.remove('live');
    viz.querySelectorAll('span').forEach(bar => bar.style.removeProperty('--bar'));
  }
}

function startVoiceListeningUI() {
  voiceListening = true;
  document.getElementById('chatWindow').classList.add('mic-listening');
  document.getElementById('chatMicBtn').classList.add('is-listening');
  document.getElementById('chatInputArea').style.display = 'none';
  document.getElementById('chatSpeechBar').classList.add('show');
  updateSpeechBarText('', true);
  startVoiceViz();
}

function stopVoiceListeningUI() {
  voiceListening = false;
  document.getElementById('chatWindow').classList.remove('mic-listening');
  document.getElementById('chatMicBtn').classList.remove('is-listening');
  document.getElementById('chatInputArea').style.display = '';
  document.getElementById('chatSpeechBar').classList.remove('show');
  stopVoiceViz();
}

function toggleVoiceInput() {
  if (!isVoiceInputSupported()) {
    appendBotMessage("Voice input isn't supported in this browser yet — Chrome, Edge, or Safari on iOS work best. You can still type your question here!");
    return;
  }
  // Tapping the mic always wins over the bot still talking — treat it as
  // a barge-in and cut the reply off immediately instead of letting it
  // keep narrating over the customer.
  safeCancelSpeech();
  if (voiceListening || voiceStarting) {
    // A manual tap while it's listening (or just about to start) ends
    // the whole hands-free conversation, not just this one turn.
    voiceConvoMode = false;
    stopVoiceInput();
    return;
  }
  voiceConvoMode = true;
  resumeVoiceListening();
}

// Starts (or restarts) listening without touching voiceConvoMode — used
// both by the initial mic tap and to automatically re-open the mic after
// each bot reply while conversation mode is active. Always builds a
// fresh recognizer instance (see createVoiceRecognizer() for why).
function resumeVoiceListening() {
  if (!isVoiceInputSupported()) return;
  if (voiceListening || voiceStarting) return; // already (about to be) listening

  // Fully tear down any previous instance before replacing it — having
  // two recognizers alive at once is another way browsers throw or wedge.
  if (voiceRecognizer) {
    const stale = voiceRecognizer;
    voiceRecognizer = null;
    stale.onresult = null;
    stale.onerror = null;
    stale.onend = null;
    stale.onstart = null;
    try { stale.abort(); } catch (e) {}
  }

  const startFresh = () => {
    voiceRecognizer = createVoiceRecognizer();
    voiceFinalTranscript = '';
    voiceStarting = true;
    try {
      voiceRecognizer.start();
      startVoiceListeningUI();
      return true;
    } catch (e) {
      voiceStarting = false;
      voiceRecognizer = null;
      return false;
    }
  };

  if (!startFresh()) {
    // Some browsers throw synchronously if start() lands in the same
    // tick as the previous instance's teardown. One short retry with a
    // completely new instance covers that instead of leaving voice
    // input silently broken until the page is reloaded.
    setTimeout(() => {
      if (!voiceListening && !voiceStarting) startFresh();
    }, 200);
  }
}

function stopVoiceInput() {
  voiceConvoMode = false;
  voiceStarting = false;
  if (voiceRecognizer) {
    try { voiceRecognizer.abort(); } catch (e) {}
  }
  stopVoiceListeningUI();
}

// Renders a bot bubble directly (used by voice-input error states above,
// which can fire outside the normal sendChatMessage() request/response flow).
function appendBotMessage(html) {
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;
  const botMsg = document.createElement('div');
  botMsg.className = 'chat-msg bot';
  botMsg.innerHTML = html;
  chatMessages.appendChild(botMsg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

if (!isVoiceInputSupported()) {
  // Mark the mic button as unsupported once the DOM is ready, rather than
  // hiding it outright — seeing it (dimmed) is clearer than a button that
  // silently vanishes depending on which browser the customer is using.
  document.addEventListener('DOMContentLoaded', () => {
    const micBtn = document.getElementById('chatMicBtn');
    if (micBtn) { micBtn.classList.add('unsupported'); micBtn.title = 'Voice input not supported in this browser'; }
  });
}

// ---------- Smart Chat: stay above the on-screen keyboard ----------
// Mobile browsers don't shrink `100vh`/the layout viewport when the
// software keyboard opens — Safari never does, Chrome only does with
// interactive-widget=resizes-content (set on the <meta viewport> above,
// but not universally supported yet). Left alone, a position:fixed
// panel keeps sizing and placing itself against the *full* screen even
// while the keyboard covers the bottom of it, so the input row (or,
// once expanded, the header) can end up hidden behind the keyboard —
// what was showing up as the chat "expanding" and cutting into the
// page. window.visualViewport DOES shrink with the keyboard, so
// tracking it and feeding the numbers into --vv-height/--kb-inset lets
// the .chat-window rules push themselves up above the keyboard and cap
// their own height to whatever room is actually left, in both the
// compact and the expanded state.
(function () {
  const vv = window.visualViewport;
  function updateChatViewportVars() {
    const root = document.documentElement.style;
    if (vv) {
      root.setProperty('--vv-height', vv.height + 'px');
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.setProperty('--kb-inset', inset + 'px');
    } else {
      root.setProperty('--vv-height', window.innerHeight + 'px');
      root.setProperty('--kb-inset', '0px');
    }
  }
  updateChatViewportVars();
  if (vv) {
    vv.addEventListener('resize', updateChatViewportVars);
    vv.addEventListener('scroll', updateChatViewportVars);
  } else {
    window.addEventListener('resize', updateChatViewportVars, { passive: true });
  }
  document.addEventListener('DOMContentLoaded', () => {
    const chatInput = document.getElementById('chatInput');
    if (!chatInput) return;
    // iOS in particular can report the post-keyboard visualViewport size
    // a beat after focus/blur fires, so re-check shortly after too.
    chatInput.addEventListener('focus', () => setTimeout(updateChatViewportVars, 300));
    chatInput.addEventListener('blur', () => setTimeout(updateChatViewportVars, 300));
  });
})();

function toggleChat() {
  const chatWin = document.getElementById('chatWindow');
  chatWin.classList.toggle('open');
  if (chatWin.classList.contains('open')) {
    greetOnChatOpen();
  } else {
    // Closing the widget should immediately interrupt and end any reply
    // still being read out loud — it shouldn't keep talking once the
    // window is gone. Same for an in-progress hands-free voice
    // conversation: don't let it quietly keep listening in the background.
    safeCancelSpeech();
    if (typeof voiceListening !== 'undefined' && (voiceListening || voiceConvoMode)) stopVoiceInput();
    // Always reopen collapsed next time, rather than remembering an
    // expanded state from the previous session.
    setChatExpanded(false);
  }
}

const CHAT_ICON_EXPAND = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
const CHAT_ICON_COLLAPSE = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>';

// Toggles the Smart Chat window between its compact floating-card size
// and an enlarged bottom-sheet that takes up 60% of the viewport height —
// mainly useful on mobile, where the small default card gets cramped
// once a real back-and-forth conversation is going.
function toggleChatExpand() {
  const chatWin = document.getElementById('chatWindow');
  if (!chatWin) return;
  setChatExpanded(!chatWin.classList.contains('chat-expanded'));
}

function setChatExpanded(expanded) {
  const chatWin = document.getElementById('chatWindow');
  const btn = document.getElementById('chatExpandBtn');
  if (chatWin) chatWin.classList.toggle('chat-expanded', expanded);
  if (btn) {
    btn.innerHTML = expanded ? CHAT_ICON_COLLAPSE : CHAT_ICON_EXPAND;
    btn.title = expanded ? 'Collapse chat' : 'Expand chat';
    btn.setAttribute('aria-label', expanded ? 'Collapse chat' : 'Expand chat');
  }
  const chatMessages = document.getElementById('chatMessages');
  if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Greets the customer whenever the chat window opens. First time ever
// (or right after Clear Chat) they get the full opening spiel; if they
// already have a conversation going (they've sent at least one message
// since the last clear — same signal the launcher's pulsing-border badge
// uses) they just get a quick "welcome back" instead of hearing the
// whole intro repeated every time they close and reopen the widget.
function greetOnChatOpen() {
  const btn = document.getElementById('chatWidgetBtn');
  const hasOngoingConvo = !!(btn && btn.classList.contains('convo-active'));
  if (hasOngoingConvo) {
    appendBotMessage('Welcome back! Want to continue our conversation?');
    speakText('Welcome back! Want to continue our conversation?');
  } else {
    speakText(appSettings.chatWelcomeMessage);
  }
}

// Turns the launcher button's pulsing border-glow "blink" on or off.
// On = there's an actual ongoing conversation (the customer has sent at
// least one message since the last clear); off = nothing to draw
// attention to, e.g. right after clearChatConversation() wipes it.
// Persisted to localStorage so a reload (or coming back another day)
// still knows there's a conversation to welcome the customer back to.
function setChatWidgetActive(isActive) {
  const btn = document.getElementById('chatWidgetBtn');
  if (btn) btn.classList.toggle('convo-active', isActive);
  try { localStorage.setItem(CHAT_ACTIVE_KEY, String(isActive)); } catch (e) {}
}

// Always OPENS the support chat widget (never toggles it closed). Used
// when routing a customer here from elsewhere, e.g. a failed membership
// lookup, so a second click can't accidentally close it again.
function openSupportChat() {
  const chatWin = document.getElementById('chatWindow');
  if (chatWin.classList.contains('open')) return;
  chatWin.classList.add('open');
  greetOnChatOpen();
}

// Wipes the visible conversation back to just the welcome message. Also
// resets any in-progress guided flow (membership lookup, appointment
// lookup, renewal, or guided booking) so a fresh conversation doesn't
// pick up mid-flow, and stops anything mid-flight — a reply being read
// out loud, or the mic actively listening — before the messages under it
// disappear.
async function clearChatConversation() {
  const confirmed = await openGenericModal({
    title: 'Clear Chat',
    message: "Clear this conversation? This can't be undone.",
    confirmLabel: 'Clear',
    danger: true
  });
  if (!confirmed) return;

  safeCancelSpeech();
  if (typeof voiceListening !== 'undefined' && voiceListening) stopVoiceInput();

  const chatMessages = document.getElementById('chatMessages');
  if (chatMessages) {
    chatMessages.innerHTML = '';
    const welcome = document.createElement('div');
    welcome.className = 'chat-msg bot';
    welcome.id = 'chatInitialBotMsg';
    welcome.innerText = appSettings.chatWelcomeMessage;
    chatMessages.appendChild(welcome);
  }

  if (typeof chatFlow !== 'undefined') {
    chatFlow.intent = null;
    chatFlow.pendingMemNum = null;
  }
  if (typeof resetChatBooking === 'function') resetChatBooking();

  const input = document.getElementById('chatInput');
  if (input) input.value = '';

  setChatWidgetActive(false);
  // A genuine "start fresh" — this is the ONLY thing that should ever
  // wipe the stored conversation; simply closing the widget or reloading
  // the page must not.
  clearChatHistoryStorage();
}

// ---------- Smart Chat conversation persistence ----------
// Keeps the visible transcript in localStorage so it survives closing
// the widget, navigating to another page, or reloading the browser
// entirely — the ONLY thing that ever wipes it is the customer
// explicitly hitting "Clear Chat" above. Restored once, immediately
// below; kept in sync after that by a MutationObserver watching
// #chatMessages, so every place a message gets appended (typed replies,
// spoken replies, booking-flow chips, error messages) is covered without
// having to touch each individual call site.
const CHAT_HISTORY_KEY = 'primus_chat_history_html';
const CHAT_ACTIVE_KEY = 'primus_chat_convo_active';

function saveChatHistory() {
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;
  const clone = chatMessages.cloneNode(true);
  clone.querySelectorAll('.chat-typing').forEach(el => el.remove());
  try { localStorage.setItem(CHAT_HISTORY_KEY, clone.innerHTML); } catch (e) { /* storage full/unavailable — not critical, fail silently */ }
}

function clearChatHistoryStorage() {
  try {
    localStorage.removeItem(CHAT_HISTORY_KEY);
    localStorage.removeItem(CHAT_ACTIVE_KEY);
  } catch (e) {}
}

// Puts back whatever transcript was saved from the last visit (if any)
// before the customer ever opens the widget, so the moment they do, the
// conversation — and the "Welcome back" greeting/speech in
// greetOnChatOpen() — already has something to continue.
function restoreChatHistory() {
  let savedHtml = null;
  let savedActive = false;
  try {
    savedHtml = localStorage.getItem(CHAT_HISTORY_KEY);
    savedActive = localStorage.getItem(CHAT_ACTIVE_KEY) === 'true';
  } catch (e) { return; }
  if (!savedHtml) return;
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;
  chatMessages.innerHTML = savedHtml;
  if (savedActive) setChatWidgetActive(true);
}
restoreChatHistory();

(function initChatHistoryAutosave() {
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages || !('MutationObserver' in window)) return;
  let saveDebounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(saveChatHistory, 250);
  });
  observer.observe(chatMessages, { childList: true, subtree: true, characterData: true });
})();

// Typing while the bot is mid-reply is also a valid way to interrupt it
// (per the hint banner shown in showSpeakHint) — cut the voice off the
// moment the customer starts typing instead of talking over them.
(function initTypingInterruptsSpeech() {
  const input = document.getElementById('chatInput');
  if (!input) return;
  input.addEventListener('input', () => {
    if ('speechSynthesis' in window && window.speechSynthesis.speaking) safeCancelSpeech();
  });
})();

/* =========================================================================
   PART 2 — The assistant: knowledge base, intent matching, guided booking
   (was index.html lines 10527-11700)
   ========================================================================= */
// ---------- Chat "AI" knowledge base ----------
// Everything the assistant says is grounded in appSettings (the same data
// that powers the rest of this page), so its answers never drift from what's
// actually configured — services, prices, hours, barbers, membership, etc.

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fmtMoney(amount) {
  return `${appSettings.currency}${Number(amount).toLocaleString()}`;
}

// ---------- Matching helpers (no API, no network) ----------
// The old matcher was a bare `lower.includes(w)`, which misfires badly:
// 'hi' matched inside "this"/"which"/"shipping", 'open' inside "reopen",
// and any typo at all ("haircutt", "apointment") fell straight through to
// the generic fallback. These three helpers fix both problems for every
// intent at once, since all 17 of them route through matchesAny().

// Strips punctuation and pads with spaces so ' word ' boundary tests work.
function normalizeMsg(str) {
  return ' ' + String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() + ' ';
}

// Standard edit distance, bailing out early once it exceeds `max` — we only
// ever care about "off by one", so there's no need to fill the whole matrix.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Deliberately conservative: both words at least 5 characters, same first
// letter, one edit apart. Without those guards 'your' fuzzy-matches 'hour'
// and "what's your name" would get answered with the opening times.
function fuzzyWordMatch(token, target) {
  if (token.length < 5 || target.length < 5) return false;
  if (token[0] !== target[0]) return false;
  return editDistance(token, target, 1) <= 1;
}

// Crude singular form. Whole-word matching would otherwise regress on the
// commonest phrasings there are — "what are your hours" no longer matching
// the keyword 'hour', "prices" missing 'price' — which plain substring
// matching got right by accident.
function stemWord(w) {
  // '-es' only drops two letters after a sibilant (boxes -> box,
  // watches -> watch). Applying it blindly turns 'prices' into 'pric'.
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function matchesAny(lower, words) {
  const norm = normalizeMsg(lower);
  const tokens = norm.trim().split(' ').filter(Boolean);
  const stems = tokens.map(stemWord);
  return words.some(w => {
    const phrase = normalizeMsg(w).trim();
    if (!phrase) return false;
    // Multi-word phrases must appear intact — fuzzing those invites nonsense.
    if (phrase.includes(' ')) return norm.includes(' ' + phrase + ' ');
    if (norm.includes(' ' + phrase + ' ')) return true;
    const target = stemWord(phrase);
    return stems.some(t => t === target || fuzzyWordMatch(t, target));
  });
}

function findMentionedService(lower) {
  // Direct name match first, then a looser word-overlap match so things like
  // "how much for a shave" still find "Hot Towel Shave".
  let found = appSettings.services.find(s => lower.includes(s.name.toLowerCase()));
  if (found) return found;
  const stopWords = new Set(['the','a','an','and','with','for','of','service']);
  found = appSettings.services.find(s => {
    const words = s.name.toLowerCase().split(/\s+/).filter(w => !stopWords.has(w));
    return words.some(w => w.length > 3 && lower.includes(w));
  });
  return found || null;
}

function todaysHoursLine() {
  const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const match = appSettings.hours.find(h => h.day.toLowerCase().includes(dayName.toLowerCase()) ||
    (h.day.includes('–') && h.day.toLowerCase().includes('monday') && ['monday','tuesday','wednesday','thursday','friday'].includes(dayName.toLowerCase())));
  return match ? `Today (${dayName}), we're open ${match.time}.` : null;
}

function contactActionButtons() {
  return `<div class="chat-action-row">
    <button class="chat-action-btn is-call" onclick="startVoiceCall()"><svg viewBox="0 0 24 24" width="13" height="13" style="vertical-align:-2px;margin-right:4px;" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>Call now</button>
    <button class="chat-action-btn" onclick="startEmailContact()"><svg viewBox="0 0 24 24" width="13" height="13" style="vertical-align:-2px;margin-right:4px;" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/></svg>Email us</button>
  </div>`;
}

// Tracks a short-lived "waiting on the customer's next reply for a specific
// reason" state — membership-ID verification, appointment lookup, and the
// two-question renewal hand-off (membership ID, then email) all use this.
// Kept as its own object (rather than scattered booleans) so it's obvious
// at a glance what the chat is mid-way through. pendingMemNum only matters
// during the renewal_email step, where it holds the ID given in the
// previous turn while we wait for the matching email.
let chatFlow = { intent: null, pendingMemNum: null };

// Looks up a membership number by the email or phone the customer signed
// up with — the exact same matching rule the "I'm a member" lookup modal
// uses (see lookupMembershipId()), just returned as chat-ready text instead
// of being written into that modal's DOM. Never reveals *whether* a contact
// matches without also checking it's active — same "no partial info" rule
// as the modal.
// Asks the server to match the contact detail and return only this one
// person's membership number. This used to loop over a client-side copy of
// every member — which meant the "for your privacy, I'll verify you first"
// step was checking a list the visitor had already downloaded. The browser
// now never sees anyone's records, so the verification is real.
async function resolveMembershipLookupReply(contactRaw) {
  const contactVal = contactRaw.trim();
  const notFound = `I couldn't find an active membership under that phone number or email. If you think that's a mistake, our team can check manually:${contactActionButtons()}`;
  if (!contactVal || appSettings.membershipActive === false) return notFound;
  try {
    const resp = await fetch('/api/members/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: contactVal })
    });
    if (!resp.ok) throw new Error('lookup failed');
    const data = await resp.json();
    if (!data.found) return notFound;
    return `Found it! Your membership ID is <strong>${escapeAttr(data.membershipNumber)}</strong>. You can use that at checkout for your ${appSettings.discountRate}% discount.`;
  } catch (e) {
    return `I couldn't check that just now. Our team can look it up for you:${contactActionButtons()}`;
  }
}

// Looks up a customer's upcoming appointment(s) by the membership ID or
// email they booked with. Matches against the booking records saved by
// submitBooking() (see its appSettings.bookings.push call) — every
// booking made through either the full scheduler or the chat wizard is
// searchable here, since both funnel through the same submitBooking().
// Same shape as the membership lookup above: the server matches and returns
// only this customer's own upcoming bookings. The public /api/state now
// carries bookings stripped to { date, time, barber } for slot availability,
// so no customer's name, email or confirmation number is in the browser.
async function resolveAppointmentLookupReply(contactRaw) {
  const contactVal = contactRaw.trim();
  if (!contactVal) {
    return `I didn't catch that — what's the membership ID or email you booked with?`;
  }
  const none = `I couldn't find any upcoming appointments under that. If you think that's a mistake, our team can check manually:${contactActionButtons()}`;
  try {
    const resp = await fetch('/api/bookings/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: contactVal })
    });
    if (!resp.ok) throw new Error('lookup failed');
    const { bookings = [] } = await resp.json();
    if (!bookings.length) return none;

    const list = bookings.map(bk =>
      `\u2022 <strong>${escapeAttr(bk.service || 'Appointment')}</strong> with ${escapeAttr(bk.barber)} on ${escapeAttr(bk.date)} at ${escapeAttr(bk.time)}${bk.appointmentNumber ? ` (Confirmation #${escapeAttr(bk.appointmentNumber)})` : ''}`
    ).join('<br>');

    return bookings.length === 1
      ? `Found it! Here's your upcoming appointment:<br>${list}`
      : `Found ${bookings.length} upcoming appointments:<br>${list}`;
  } catch (e) {
    return `I couldn't check that just now. Our team can look it up for you:${contactActionButtons()}`;
  }
}

// Finds a paidMembers record by membership ID, ignoring case — membership
// numbers are stored like "MEM-12345" but a customer might type/say them
// in lowercase, so this can't just index paidMembers[id] directly.
function findMemberRecordCaseInsensitive(idRaw) {
  const idLower = (idRaw || '').trim().toLowerCase();
  if (!idLower) return null;
  for (const [memNum, data] of Object.entries(paidMembers || {})) {
    if (memNum.toLowerCase() === idLower) return { memNum, data };
  }
  return null;
}

// Second half of the renewal hand-off (see generateBotResponse's "Renew
// membership" step): verifies the membership ID given in the previous turn
// against the email given in this one, then — if they match — opens the
// real membership modal straight at the payment step so the customer can
// pick a method and pay, reusing this same membership number rather than
// minting a new one (see startMembershipRenewalPayment).
function resolveMembershipRenewalReply(memNumRaw, emailRaw) {
  const email = (emailRaw || '').trim().toLowerCase();
  const found = findMemberRecordCaseInsensitive(memNumRaw);
  if (!found || !found.data.email || found.data.email.toLowerCase() !== email) {
    return `I couldn't verify that membership ID and email together. If you think that's a mistake, our team can check manually:${contactActionButtons()}`;
  }
  startMembershipRenewalPayment(found.memNum, found.data);
  return `Found it${found.data.name ? ', ' + found.data.name : ''}! I've opened the payment page for your renewal — pick a method there to finish up.`;
}

function generateBotResponse(rawMsg) {
  const lower = rawMsg.toLowerCase().trim();

  // 1) Human handoff / support request — always take this seriously and
  // answer plainly, whether they explicitly ask for a person or just say
  // they need support/help with a problem.
  if (matchesAny(lower, [
    'human', 'agent', 'real person', 'representative', 'talk to someone', 'speak to someone',
    'support', 'customer support', 'need help', 'having an issue', 'having a problem',
    'issue with', 'problem with', 'complaint', 'not working', "isn't working", 'trouble with'
  ])) {
    return `Of course — I'll connect you with our team right away. Tap below to call us live or send an email, whichever's easier:${contactActionButtons()}`;
  }

  // 2) Greetings
  if (matchesAny(lower, ['hello', 'hi ', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening', 'yo', 'sup']) && lower.length < 25) {
    return pickRandom([
      `Hey there! 👋 Welcome to ${appSettings.businessName}. Ask me about our services, prices, hours, or booking — I'm happy to help.`,
      `Hi! Great to see you. I can help with booking, pricing, our hours, or membership — what do you need?`,
      `Hello! I'm the ${appSettings.businessName} chat assistant. Want to know about our services, book an appointment, or check our hours?`
    ]);
  }

  // 3) Thanks / goodbye
  if (matchesAny(lower, ['thank you', 'thanks', 'thank u', 'appreciate it'])) {
    return pickRandom([
      `You're very welcome! Anything else I can help with?`,
      `Anytime! Let me know if there's anything else you'd like to know.`,
      `Happy to help! We look forward to seeing you at ${appSettings.businessName}.`
    ]);
  }
  if (matchesAny(lower, ['bye', 'goodbye', 'see you', 'see ya', 'later'])) {
    return `Take care! We can't wait to see you at ${appSettings.businessName}. 👋`;
  }

  // 4) Membership ID lookup — the customer is asking to be told their own
  // membership ID. Never hand that out on request alone: ask for the phone
  // number or email they signed up with first, then verify on their next
  // message (handled in sendChatMessage()) before revealing anything.
  if (matchesAny(lower, [
    'my membership id', 'my membership number', 'find my membership', 'check my membership',
    "what's my membership", 'whats my membership', 'lookup my membership', 'look up my membership',
    'membership id', 'membership number'
  ])) {
    if (appSettings.membershipActive === false) {
      return `We don't have membership sign-ups open at the moment, so there's no membership ID to look up yet.`;
    }
    chatFlow.intent = 'membership_lookup';
    return `Sure — for your privacy, I'll need to verify you first. What's the phone number or email you signed up with?`;
  }

  // 5) "Check my appointment" — checked BEFORE the booking-trigger step
  // below since phrases like "check my booking" or "check my book
  // appointment" would otherwise also match that step's looser
  // 'appointment'/'book' keywords and incorrectly start a NEW booking.
  // Verified the same way as the membership lookup above: ask for the
  // membership ID or email first, then resolve it on their next message.
  if (matchesAny(lower, [
    'check my appointment', 'check my booking', 'check my book', 'my appointment', 'my booking',
    'my book appointment', 'find my appointment', 'find my booking', 'view my appointment',
    'view my booking', 'do i have an appointment', 'do i have a booking', 'upcoming appointment',
    'appointment status', 'booking status'
  ])) {
    chatFlow.intent = 'appointment_lookup';
    return `Sure — what's the membership ID or email you booked with?`;
  }

  // 6) Renew membership — a two-question hand-off (membership ID, then the
  // email it was signed up with) verified in sendChatMessage(), which then
  // opens the real membership modal straight at the payment step (see
  // startMembershipRenewalPayment) — same method picker, QR codes, and
  // live checkout every new sign-up uses, just pre-filled and flagged
  // to reuse this membership number instead of minting a new one.
  if (matchesAny(lower, [
    'renew my membership', 'renew membership', 'renew my subscription', 'membership renewal',
    'renew my id', 'renew it', 'renew'
  ])) {
    if (appSettings.membershipActive === false) {
      return `We don't have membership sign-ups or renewals open at the moment.`;
    }
    chatFlow.intent = 'renewal_id';
    return `Sure — what's your membership ID?`;
  }

  // 7) Specific service price/detail lookup — check before the general list.
  // If they named a particular service (by name, e.g. "haircut" or "shave"),
  // answer about that one specifically rather than dumping the whole menu.
  const mentionedService = findMentionedService(lower);
  if (mentionedService) {
    return `The <strong>${mentionedService.name}</strong> is ${fmtMoney(mentionedService.price)}. ${mentionedService.desc}${appSettings.membershipActive ? ` Members save ${appSettings.discountRate}% on that too.` : ''}`;
  }

  // 8) Pricing / services list
  if (matchesAny(lower, ['price', 'cost', 'how much', 'rate', 'rates', 'fee', 'charge', 'service', 'services', 'menu', 'what do you offer'])) {
    const list = appSettings.services.map(s => `• <strong>${s.name}</strong> — ${fmtMoney(s.price)}`).join('<br>');
    return `Here's what we offer:<br>${list}${appSettings.membershipActive ? `<br><br>Members get ${appSettings.discountRate}% off all of these!` : ''}`;
  }

  // 9) Booking / appointment — starts the fully conversational booking
  // flow (see beginNaturalLanguageBooking below), which parses whatever
  // the customer already said ("...on tuesday at 2pm") and only asks for
  // whatever's still missing — entirely through chat text, so it works
  // exactly the same whether typed or spoken (voice input turns into a
  // normal chat message, same as typing).
  if (matchesAny(lower, ['book', 'appointment', 'schedule', 'reserve', 'slot', 'availability'])) {
    return beginNaturalLanguageBooking(rawMsg, lower);
  }

  // 10) Hours
  if (matchesAny(lower, ['hour', 'open', 'close', 'opening', 'closing', 'what time'])) {
    const list = appSettings.hours.map(h => `• ${h.day}: ${h.time}`).join('<br>');
    const today = todaysHoursLine();
    return `Our hours are:<br>${list}${today ? `<br><br>${today}` : ''}`;
  }

  // 11) Membership / discount (pricing info — not an ID lookup, see #4)
  if (matchesAny(lower, ['member', 'membership', 'discount', 'subscribe', 'subscription'])) {
    if (!appSettings.membershipActive) {
      return `We don't have membership sign-ups open at the moment, but keep an eye out — that could change soon!`;
    }
    return `Members get ${appSettings.discountRate}% off every service and priority booking slots, for just ${fmtMoney(appSettings.subscriptionAmount)}. Just tap "Be a member" at the top of the page, or choose it at checkout when booking.`;
  }

  // 12) Barbers / staff
  if (matchesAny(lower, ['barber', 'staff', 'stylist', 'who cuts', 'team', 'who works'])) {
    const list = appSettings.barbers.join(', ');
    return `Our team includes: ${list}. You can pick your preferred barber right when you book an appointment.`;
  }

  // 13) Reviews
  if (matchesAny(lower, ['review', 'rating', 'feedback', 'testimonial'])) {
    if (!appSettings.reviews.length) {
      return `We're still gathering reviews — but we'd love for you to be one of our first!`;
    }
    const r = appSettings.reviews[appSettings.reviews.length - 1];
    return `Here's a recent one: "${r.rating}★ from ${r.author}" — you can read all our reviews further down the page. Come try us out and leave your own!`;
  }

  // 14) Gallery / work examples
  if (matchesAny(lower, ['gallery', 'photo', 'picture', 'portfolio', 'examples of work', 'before and after'])) {
    return `Take a look at our Gallery section on the page — you'll see recent cuts like ${appSettings.gallery.map(g => g.title).join(', ')}.`;
  }

  // 15) Contact
  if (matchesAny(lower, ['contact', 'email', 'phone', 'number', 'reach you', 'call you'])) {
    return `You can reach us right from here — tap to call live or send an email:${contactActionButtons()}`;
  }

  // 16) Owner
  if (matchesAny(lower, ['owner', 'who owns', 'who runs'])) {
    return `${appSettings.businessName} is run by ${appSettings.ownerName}.`;
  }

  // 17) Payment methods — answered from the merchant settings the owner
  // already filled in, so this stays correct without anyone maintaining a
  // second copy of the list.
  if (matchesAny(lower, ['pay', 'payment', 'gcash', 'maya', 'paypal', 'gotyme', 'maribank',
                         'cash', 'card', 'bank transfer', 'how do i pay', 'accept'])) {
    const m = appSettings.merchant || {};
    const wallets = [['GCash', m.gcash], ['Maya', m.maya], ['GoTyme', m.gotyme],
                     ['Maribank', m.maribank], ['PayPal', m.paypal]]
      .filter(([, v]) => v && (v.number || v.qrImage))
      .map(([label]) => label);
    if (m.paymongoEnabled || m.xenditEnabled) wallets.push('card');
    if (!wallets.length) {
      return `You can settle up in person at the shop — tap below if you'd like to check with the team first:${contactActionButtons()}`;
    }
    return `We accept ${wallets.join(', ')}, plus cash in store. You'll see the full list with QR codes at checkout.`;
  }

  // 18) Walk-ins vs appointments.
  if (matchesAny(lower, ['walk in', 'walkin', 'walk ins', 'without an appointment',
                         'do i need an appointment', 'need a booking', 'just show up', 'drop in'])) {
    const today = todaysHoursLine();
    return `Walk-ins are welcome when a chair is free, but booking ahead guarantees your slot and your preferred barber.${today ? ` ${today}` : ''} Say "book" and I'll set one up now.`;
  }

  // 19) Cancel / reschedule. There's no self-service path for this, so say
  // so plainly and hand them to a person rather than pretending otherwise.
  if (matchesAny(lower, ['cancel', 'reschedule', 'move my appointment', 'change my booking',
                         'change my appointment', 'postpone'])) {
    return `I can't change an existing booking from here yet — the team can sort it out in a moment though:${contactActionButtons()}`;
  }

  // 20) Location / directions. No address field exists in settings, so this
  // routes to a human instead of inventing one.
  if (matchesAny(lower, ['where are you', 'location', 'address', 'directions', 'how do i get there',
                         'where is the shop', 'map', 'parking'])) {
    return `Give us a call or drop us an email and we'll point you straight to us:${contactActionButtons()}`;
  }

  // 21) Fallback — still warm and helpful, and nudges toward what we can answer.
  return pickRandom([
    `I want to make sure I get that right for you — could you tell me a bit more? I can help with services, pricing, hours, booking, or membership.`,
    `Good question! I don't have that specific detail, but I can help with our services, prices, hours, booking, or membership — or say "human" and I'll connect you with our team.`,
    `Hmm, I'm not totally sure on that one. Try asking about our services, prices, hours, or booking, or just say "human" to reach our team directly.`
  ]);
}

// ---------- Advanced AI (GPT + Claude + Gemini) — optional, off by default ----------
// Why this calls a same-origin /api/ai-chat endpoint instead of OpenAI/
// Anthropic/Google directly from the browser: those providers' API keys
// are secret credentials billed per use. Putting them in this HTML file
// would publish them to anyone who views the page source or opens
// DevTools — they could be copied and run up charges on the business's
// account within minutes. This file already avoids that exact trap for
// PayMongo (see the Payment Merchant tab: "a PayMongo secret key set on
// the server, never entered here") — Advanced AI follows the same rule.
// The companion server.js is expected to expose:
//   POST /api/ai-chat   body: { message, history, knowledgeBase }
//                       reply: { reply: "<plain text or safe HTML>" }
// with the actual provider keys read from server-side environment
// variables. See ai-chat-server-example.js for a starting point that
// queries GPT, Claude, and Gemini and returns whichever answers first.
// If that endpoint isn't reachable (no server.js running, feature not
// configured yet, or the request fails for any reason), this silently
// falls back to the built-in generateBotResponse() above so the chat
// never breaks or shows an error to the customer.
function buildAIKnowledgeBase() {
  // The "source" for Advanced AI's answers: the same live admin panel
  // data the built-in assistant already uses (not the raw HTML file
  // itself — sending third-party APIs the entire page source on every
  // message would be slow, costly, and leak far more than needed). This
  // covers everything a customer could reasonably ask about.
  return {
    businessName: appSettings.businessName,
    ownerName: appSettings.ownerName,
    services: appSettings.services,
    hours: appSettings.hours,
    barbers: appSettings.barbers,
    membershipActive: appSettings.membershipActive,
    discountRate: appSettings.discountRate,
    subscriptionAmount: appSettings.subscriptionAmount,
    currency: appSettings.currency,
    contactPhone: appSettings.contactPhone,
    contactEmail: appSettings.contactEmail,
    reviews: (appSettings.reviews || []).slice(-5),
    gallery: (appSettings.gallery || []).map(g => g.title)
  };
}

async function fetchAdvancedAIReply(msgText, recentHistory) {
  try {
    const resp = await fetch('/api/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: msgText,
        history: recentHistory,
        knowledgeBase: buildAIKnowledgeBase()
      })
    });
    if (!resp.ok) throw new Error('ai-chat endpoint returned ' + resp.status);
    const data = await resp.json();
    if (!data || !data.reply) throw new Error('ai-chat endpoint returned no reply');
    return data.reply;
  } catch (e) {
    // No server, feature not set up yet, offline, or a provider error —
    // fall back to the built-in assistant rather than showing an error.
    console.warn('Advanced AI reply unavailable, falling back to built-in assistant:', e);
    return generateBotResponse(msgText);
  }
}

// Keeps a short rolling window of the visible conversation so Advanced AI
// has context for follow-up questions (e.g. "how much is that one, then?").
function getRecentChatHistory(maxTurns = 6) {
  const nodes = Array.from(document.querySelectorAll('#chatMessages .chat-msg')).filter(
    n => !n.classList.contains('chat-typing')
  );
  return nodes.slice(-maxTurns).map(n => ({
    role: n.classList.contains('user') ? 'user' : 'assistant',
    content: n.innerText
  }));
}

function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const msgText = input.value.trim();
  if (!msgText) return;

  // Still inside the user's tap/Enter keypress here — the only moment the
  // browser will let us unlock audio. Must stay ahead of any await.
  primeSpeechSynthesis();

  setChatWidgetActive(true);

  const chatMessages = document.getElementById('chatMessages');
  const userMsg = document.createElement('div');
  userMsg.className = 'chat-msg user';
  userMsg.innerText = msgText;
  chatMessages.appendChild(userMsg);
  input.value = '';
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // A brief "typing" indicator makes the reply feel like a person thinking,
  // rather than an instant canned response.
  const typing = document.createElement('div');
  typing.className = 'chat-msg bot chat-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  chatMessages.appendChild(typing);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  const thinkTime = 450 + Math.random() * 500;
  setTimeout(async () => {
    typing.remove();

    let replyHtml;
    if (chatFlow.intent === 'membership_lookup') {
      // The customer's *next* message after being asked is treated as
      // their verification contact, not a fresh question.
      replyHtml = await resolveMembershipLookupReply(msgText);
      chatFlow.intent = null;
    } else if (chatFlow.intent === 'appointment_lookup') {
      replyHtml = await resolveAppointmentLookupReply(msgText);
      chatFlow.intent = null;
    } else if (chatFlow.intent === 'renewal_id') {
      // First half of the renewal hand-off: remember the ID they gave,
      // then ask for the email that has to match it before moving on.
      chatFlow.pendingMemNum = msgText.trim();
      chatFlow.intent = 'renewal_email';
      replyHtml = `Thanks! And what email did you sign up with, so I can verify it's you?`;
    } else if (chatFlow.intent === 'renewal_email') {
      replyHtml = resolveMembershipRenewalReply(chatFlow.pendingMemNum, msgText);
      chatFlow.intent = null;
      chatFlow.pendingMemNum = null;
    } else if (chatBooking.active) {
      // Mid-booking-flow: every reply — typed or spoken — is parsed as the
      // answer to whatever's currently being asked (service, date, time,
      // name, etc.), same as the membership/appointment lookups above take
      // priority over a fresh question. Checked ahead of Advanced AI too,
      // since the flow's own deterministic parsing needs to own these
      // turns rather than handing them to an external model.
      replyHtml = handleChatBookingReply(msgText);
    } else if (appSettings.aiAssistant && appSettings.aiAssistant.advancedEnabled) {
      replyHtml = await fetchAdvancedAIReply(msgText, getRecentChatHistory());
    } else {
      replyHtml = generateBotResponse(msgText);
    }

    const botMsg = document.createElement('div');
    botMsg.className = 'chat-msg bot';
    botMsg.innerHTML = replyHtml;
    chatMessages.appendChild(botMsg);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Speak the message text only — skip reading button labels (like "Call now")
    // out loud, since those aren't part of the actual reply.
    const speechClone = botMsg.cloneNode(true);
    const actionRow = speechClone.querySelector('.chat-action-row');
    if (actionRow) actionRow.remove();
    speakText(speechClone.innerText, () => {
      // Conversation mode: once the reply has finished being read out
      // (or immediately, if voice replies are off/unsupported), hand the
      // mic back to the customer automatically instead of waiting for
      // another tap — same back-and-forth feel as a voice assistant.
      if (voiceConvoMode && !voiceListening) resumeVoiceListening();
    });
  }, thinkTime);
}

function callAssistant() {
  const chatMessages = document.getElementById('chatMessages');
  const botMsg = document.createElement('div');
  botMsg.className = 'chat-msg bot';
  botMsg.innerHTML = `Want to talk live? Use the buttons below:${contactActionButtons()}`;
  chatMessages.appendChild(botMsg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  speakText('Want to talk live? Tap Call now, or email us.');
}

// ================= IN-CHAT GUIDED BOOKING =================
// A conversational booking flow that never leaves the Smart Chat window,
// and — critically — works exactly the same whether the customer types or
// speaks. Voice input (see "Voice input (speech-to-text)" above) just
// transcribes speech into a normal chat message, so as long as every step
// here can be answered with a plain sentence (not just a tap), speech mode
// gets the whole flow for free. Tapping a chip is still offered wherever
// there's a short list of options (nicer on a touchscreen), but typing or
// saying the same thing works identically — chatBookingPickX() (tap) and
// handleChatBookingReply() (typed/spoken) both just fill in the same field
// and move to askNextMissing(), so neither path is the "real" one.
//
// beginNaturalLanguageBooking() (called from generateBotResponse's
// booking-keyword step) also parses the *first* message itself — so
// "book me an appointment on tuesday at 2pm" already fills in date + time
// and jumps straight to whatever's still missing, instead of re-asking
// for things already said.
//
// Confirming at the end hands off to the real submitBooking() — the exact
// same function the full-page scheduler uses — so slot-taking, the
// membership discount, booking records, and the confirmation email all
// behave identically no matter which path the customer used to book.
let chatBooking = {
  active: false, step: null,
  service: '', price: 0, barber: '', date: '', time: '', availableSlots: [],
  name: '', phone: '', email: '', membership: '', membershipAsked: false,
  pendingTimeMinutes: null
};

function resetChatBooking() {
  chatBooking = {
    active: false, step: null,
    service: '', price: 0, barber: '', date: '', time: '', availableSlots: [],
    name: '', phone: '', email: '', membership: '', membershipAsked: false,
    pendingTimeMinutes: null
  };
}

function appendUserMessage(text) {
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;
  const userMsg = document.createElement('div');
  userMsg.className = 'chat-msg user';
  userMsg.innerText = text;
  chatMessages.appendChild(userMsg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Entry point for the "📅 Book here in chat" button/quick action — no
// text to parse yet, so this just starts the flow and asks for whatever's
// needed first.
function startChatBooking() {
  if (!appSettings.services || !appSettings.services.length) {
    appendBotMessage(`We don't have any bookable services set up just yet — please reach out directly:${contactActionButtons()}`);
    return;
  }
  resetChatBooking();
  chatBooking.active = true;
  appendBotMessage(askNextMissing());
}

// Entry point for a typed/spoken trigger like "book me an appointment on
// tuesday at 2pm" (see generateBotResponse's booking-keyword step). Parses
// whatever the customer already told us in that same sentence — service,
// barber, date, and/or time — before asking for the rest.
function beginNaturalLanguageBooking(rawMsg, lower) {
  if (!appSettings.services || !appSettings.services.length) {
    return `We don't have any bookable services set up just yet — please reach out directly:${contactActionButtons()}`;
  }
  resetChatBooking();
  chatBooking.active = true;

  const svc = findMentionedService(lower);
  if (svc) { chatBooking.service = svc.name; chatBooking.price = svc.price; }

  const barber = findMentionedBarber(lower);
  if (barber) chatBooking.barber = barber;

  const parsedDate = parseDateFromText(lower);
  if (parsedDate) {
    const todayStr = getLocalDateString();
    const blocked = (appSettings.blockedDates || []).includes(parsedDate);
    if (parsedDate >= todayStr && !blocked && appSettings.calendarActive !== false) {
      chatBooking.date = parsedDate;
    }
  }

  // A time mentioned up front ("...at 2pm") can't be validated until we
  // know the barber and date, so it's just parked here — askForTime()
  // picks it up once those are both known and applies it automatically
  // if that slot's actually open.
  const parsedMinutes = parseTimeFromText(lower);
  if (parsedMinutes !== null) chatBooking.pendingTimeMinutes = parsedMinutes;

  return askNextMissing();
}

// The single router every step (tap, typed, or spoken) funnels through:
// find the first thing we still don't know and ask for it. Both the tap
// handlers below and handleChatBookingReply() call this after filling in
// whatever field they just resolved.
function askNextMissing() {
  if (!chatBooking.service) return askForService();
  if (!chatBooking.barber) return askForBarber();
  if (!chatBooking.date) return askForDate();
  if (!chatBooking.time) return askForTime();
  if (!chatBooking.name) return askForName();
  if (!chatBooking.phone) return askForPhone();
  if (!chatBooking.email) return askForEmail();
  if (!chatBooking.membershipAsked) return askForMembership();
  if (chatBooking.step !== 'confirm') return askForConfirmation();
  return finalizeBooking();
}

function askForService() {
  if (appSettings.services.length === 1) {
    chatBooking.service = appSettings.services[0].name;
    chatBooking.price = appSettings.services[0].price;
    return askNextMissing();
  }
  chatBooking.step = 'service';
  const names = appSettings.services.map(s => `${s.name} (${fmtMoney(s.price)})`).join(', ');
  const chips = appSettings.services.map((s, i) =>
    `<button class="chat-action-btn" onclick="chatBookingPickService(${i})">${s.name} — ${fmtMoney(s.price)}</button>`
  ).join('');
  // The option list is spelled out in the sentence itself (not just the
  // chips below) because speakText() strips .chat-action-row before
  // reading a reply aloud — so a voice-mode customer needs the choices in
  // the actual words, not just as tappable buttons.
  return `Great — let's get you booked! Which service would you like — ${names}?<div class="chat-action-row" style="flex-wrap:wrap;">${chips}</div>`;
}

function chatBookingPickService(i) {
  if (!chatBooking.active) return;
  const s = appSettings.services[i];
  if (!s) return;
  chatBooking.service = s.name;
  chatBooking.price = s.price;
  appendUserMessage(s.name);
  appendBotMessage(askNextMissing());
}

function askForBarber() {
  if (!appSettings.barbers || !appSettings.barbers.length) {
    chatBooking.barber = appSettings.businessName;
    return askNextMissing();
  }
  if (appSettings.barbers.length === 1) {
    chatBooking.barber = appSettings.barbers[0];
    return askNextMissing();
  }
  chatBooking.step = 'barber';
  const names = appSettings.barbers.join(', ');
  const chips = appSettings.barbers.map((b, i) =>
    `<button class="chat-action-btn" onclick="chatBookingPickBarber(${i})">${b}</button>`
  ).join('');
  return `Got it — <strong>${chatBooking.service}</strong>. Who would you like to book with — ${names}, or any barber is fine?<div class="chat-action-row" style="flex-wrap:wrap;">${chips}</div>`;
}

function chatBookingPickBarber(i) {
  if (!chatBooking.active) return;
  const b = appSettings.barbers[i];
  if (!b) return;
  chatBooking.barber = b;
  appendUserMessage(b);
  appendBotMessage(askNextMissing());
}

function askForDate() {
  chatBooking.step = 'date';
  const todayStr = getLocalDateString();
  return `Which date works for you? You can say something like "tomorrow" or "next Tuesday", type a date, or use the picker below.
    <div style="display:flex; gap:8px; margin-top:8px; align-items:center; flex-wrap:wrap;">
      <input type="date" id="chatBookingDateInput" min="${todayStr}" style="flex:1; min-width:140px; padding:8px 10px; border-radius:8px; border:1px solid var(--glass-border); background:var(--input-bg); color:var(--text-main); font-family:inherit;">
      <button class="chat-action-btn is-call" onclick="chatBookingPickDate()">Next</button>
    </div>
    <div class="error-msg" id="chatBookingDateErr" style="display:none; margin-top:6px;">That date isn't available — please pick another.</div>`;
}

function chatBookingPickDate() {
  if (!chatBooking.active) return;
  // The date-picker markup (id="chatBookingDateInput") can appear more
  // than once in the chat log — e.g. if a chosen date turns out fully
  // booked and a fresh picker gets asked for again — so always grab the
  // most recently rendered one rather than getElementById's first match.
  const inputs = document.querySelectorAll('[id="chatBookingDateInput"]');
  const input = inputs.length ? inputs[inputs.length - 1] : null;
  const errBoxes = document.querySelectorAll('[id="chatBookingDateErr"]');
  const errBox = errBoxes.length ? errBoxes[errBoxes.length - 1] : null;
  if (!input || !input.value) return;
  const todayStr = getLocalDateString();
  const blocked = (appSettings.blockedDates || []).includes(input.value);
  if (input.value < todayStr || blocked || appSettings.calendarActive === false) {
    if (errBox) {
      errBox.innerText = appSettings.calendarActive === false
        ? "Online booking is temporarily paused — please call or email us instead."
        : "That date isn't available — please pick another.";
      errBox.style.display = 'block';
    }
    return;
  }
  chatBooking.date = input.value;
  appendUserMessage(input.value);
  appendBotMessage(askNextMissing());
}

// Mirrors validateTimeSlots()'s availability rules (past times today, and
// slots already booked for this barber on this date) so the chat wizard
// never offers a slot the real scheduler would reject.
function getAvailableChatSlots(barber, date) {
  const now = new Date();
  const todayStr = getLocalDateString(now);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return (appSettings.timeSlots || []).filter(slot => {
    if (date === todayStr && timeStringToMinutes(slot) <= currentMinutes) return false;
    const isBooked = (appSettings.bookings || []).some(
      bk => bk.barber === barber && bk.date === date && bk.time === slot
    );
    return !isBooked;
  });
}

function askForTime() {
  const slots = getAvailableChatSlots(chatBooking.barber, chatBooking.date);
  if (!slots.length) {
    chatBooking.date = '';
    chatBooking.pendingTimeMinutes = null;
    chatBooking.step = 'date';
    const todayStr = getLocalDateString();
    return `Looks like ${chatBooking.barber} is fully booked that day. What other date works for you?
      <div style="display:flex; gap:8px; margin-top:8px; align-items:center; flex-wrap:wrap;">
        <input type="date" id="chatBookingDateInput" min="${todayStr}" style="flex:1; min-width:140px; padding:8px 10px; border-radius:8px; border:1px solid var(--glass-border); background:var(--input-bg); color:var(--text-main); font-family:inherit;">
        <button class="chat-action-btn is-call" onclick="chatBookingPickDate()">Next</button>
      </div>`;
  }

  // If a time was already mentioned in the very first message ("...at
  // 2pm"), try to use it now that we can actually check availability.
  if (chatBooking.pendingTimeMinutes !== null) {
    const wanted = timeSlotLabelFromMinutes(chatBooking.pendingTimeMinutes);
    chatBooking.pendingTimeMinutes = null;
    if (wanted && slots.includes(wanted)) {
      chatBooking.time = wanted;
      return askNextMissing();
    }
  }

  chatBooking.availableSlots = slots;
  chatBooking.step = 'time';
  const chips = slots.map((t, i) => `<button class="chat-action-btn" onclick="chatBookingPickTime(${i})">${t}</button>`).join('');
  return `Here's what's open with <strong>${chatBooking.barber}</strong> on ${chatBooking.date}: ${slots.join(', ')}.<div class="chat-action-row" style="flex-wrap:wrap;">${chips}</div>`;
}

function chatBookingPickTime(i) {
  if (!chatBooking.active) return;
  const t = chatBooking.availableSlots[i];
  if (!t) return;
  chatBooking.time = t;
  appendUserMessage(t);
  appendBotMessage(askNextMissing());
}

function askForName() {
  chatBooking.step = 'name';
  return `Almost done! What name should I put the booking under?`;
}

function askForPhone() {
  chatBooking.step = 'phone';
  return `Thanks, ${chatBooking.name}! What's the best phone number to reach you?`;
}

function askForEmail() {
  chatBooking.step = 'email';
  return `And what email should I send your confirmation to?`;
}

function askForMembership() {
  chatBooking.step = 'membership';
  return `Last thing — do you have a membership ID? Tell me the number, or just say "no."`;
}

function askForConfirmation() {
  chatBooking.step = 'confirm';
  let priceLine = fmtMoney(chatBooking.price);
  const isMemberValid = chatBooking.membership && appSettings.membershipActive !== false
    && paidMembers[chatBooking.membership] && paidMembers[chatBooking.membership].active !== false;
  if (isMemberValid) {
    const discounted = chatBooking.price - Math.round(chatBooking.price * (appSettings.discountRate / 100));
    priceLine = `${fmtMoney(discounted)} (member discount applied)`;
  }
  return `Here's what I've got — ready to book this?<br>
    • <strong>Service:</strong> ${chatBooking.service}<br>
    • <strong>Barber:</strong> ${chatBooking.barber}<br>
    • <strong>When:</strong> ${chatBooking.date} at ${chatBooking.time}<br>
    • <strong>Name:</strong> ${chatBooking.name}<br>
    • <strong>Total:</strong> ${priceLine}<br>
    <div class="chat-action-row">
      <button class="chat-action-btn is-call" onclick="chatBookingConfirmYes()"><svg viewBox="0 0 24 24" width="13" height="13" style="vertical-align:-2px;margin-right:4px;" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>Yes, book it</button>
      <button class="chat-action-btn" onclick="chatBookingCancelFlow()">✕ Cancel</button>
    </div>
    Or just say "yes" or "cancel."`;
}

function chatBookingConfirmYes() {
  if (!chatBooking.active) return;
  appendUserMessage('Yes, book it');
  appendBotMessage(finalizeBooking());
}

function chatBookingCancelFlow() {
  if (!chatBooking.active) return;
  appendUserMessage('Cancel');
  resetChatBooking();
  appendBotMessage(`No problem — I've cancelled that. Let me know if you'd like to start over or need anything else.`);
}

// Hands off to the real booking pipeline — same function, same side
// effects (slot recorded, discount applied, confirmation email sent) as
// the full-page scheduler's "Confirm" button.
function finalizeBooking() {
  checkMembershipLifespan();
  let isMemberValid = false;
  if (chatBooking.membership && appSettings.membershipActive !== false
    && paidMembers[chatBooking.membership] && paidMembers[chatBooking.membership].active !== false) {
    isMemberValid = true;
  }

  state.service = chatBooking.service;
  state.price = chatBooking.price;
  state.barber = chatBooking.barber;
  state.date = chatBooking.date;
  state.time = chatBooking.time;
  state.custName = chatBooking.name;
  state.custPhone = chatBooking.phone;
  state.custEmail = chatBooking.email;
  state.membership = chatBooking.membership;
  state.isMemberValid = isMemberValid;

  const appointmentNumber = submitBooking();

  let finalPrice = chatBooking.price;
  if (isMemberValid) {
    finalPrice -= Math.round(chatBooking.price * (appSettings.discountRate / 100));
  }

  const name = chatBooking.name;
  const email = chatBooking.email;
  const summary = `🎉 You're all set, ${name}! Here's your booking:<br>
    • <strong>Service:</strong> ${chatBooking.service}<br>
    • <strong>Barber:</strong> ${chatBooking.barber}<br>
    • <strong>When:</strong> ${chatBooking.date} at ${chatBooking.time}<br>
    • <strong>Total:</strong> ${fmtMoney(finalPrice)}${isMemberValid ? ' (member discount applied)' : ''}<br>
    • <strong>Confirmation #:</strong> ${appointmentNumber}<br><br>
    We've sent a confirmation to ${email}. See you then!`;

  resetChatBooking();
  return summary;
}

// Finds a barber the customer mentioned by name, the same way
// findMentionedService() finds a service — used both by the initial
// trigger-message parse and by the 'barber' step below.
function findMentionedBarber(lower) {
  if (!appSettings.barbers) return null;
  return appSettings.barbers.find(b => lower.includes(b.toLowerCase())) || null;
}

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// Turns a natural phrase ("tomorrow", "next tuesday", "september 20",
// "9/20", "2026-09-20") into a YYYY-MM-DD string, or null if nothing in
// the text reads as a date. Deliberately covers just the common spoken
// forms rather than being a full date-parsing library.
function parseDateFromText(lower) {
  const base = new Date();
  base.setHours(0, 0, 0, 0);

  if (/\btoday\b/.test(lower)) return getLocalDateString(base);
  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(base); d.setDate(d.getDate() + 1);
    return getLocalDateString(d);
  }

  for (let i = 0; i < WEEKDAY_NAMES.length; i++) {
    const name = WEEKDAY_NAMES[i];
    // "next Tuesday" is treated the same as plain "Tuesday" (the nearest
    // upcoming one) — "next" is genuinely ambiguous in English (some
    // dialects push it out an extra week, most don't), so this matches
    // the more common, more predictable reading rather than surprising
    // the customer with a date a week later than expected.
    const re = new RegExp('\\b(?:next\\s+)?' + name + '\\b');
    const m = re.exec(lower);
    if (m) {
      const todayDow = base.getDay();
      let diff = (i - todayDow + 7) % 7;
      if (diff === 0) diff = 7; // saying "tuesday" ON a Tuesday means the upcoming one, not today
      const d = new Date(base); d.setDate(d.getDate() + diff);
      return getLocalDateString(d);
    }
  }

  let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(lower);
  if (m) {
    const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    if (!isNaN(d)) return getLocalDateString(d);
  }

  for (let i = 0; i < MONTH_NAMES.length; i++) {
    const name = MONTH_NAMES[i];
    // Most months' spoken abbreviation is just the first 3 letters, but
    // "Sept" (4 letters) is common enough for September that the plain
    // 3-letter slice alone would miss it — include both.
    const abbrs = name.slice(0, 3) === 'sep' ? 'sept|sep' : name.slice(0, 3);
    const re1 = new RegExp('\\b(' + name + '|' + abbrs + ')\\.?\\s+(\\d{1,2})(st|nd|rd|th)?\\b');
    const re2 = new RegExp('\\b(\\d{1,2})(st|nd|rd|th)?\\s+(of\\s+)?(' + name + '|' + abbrs + ')\\b');
    const mm1 = re1.exec(lower);
    const mm2 = mm1 ? null : re2.exec(lower);
    if (mm1 || mm2) {
      const day = parseInt(mm1 ? mm1[2] : mm2[1]);
      let year = base.getFullYear();
      let d = new Date(year, i, day);
      if (d < base) d = new Date(year + 1, i, day);
      if (!isNaN(d)) return getLocalDateString(d);
    }
  }

  m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(lower);
  if (m) {
    const month = parseInt(m[1]) - 1;
    const day = parseInt(m[2]);
    const year = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3])) : base.getFullYear();
    let d = new Date(year, month, day);
    if (m[3] === undefined && d < base) d = new Date(year + 1, month, day);
    if (!isNaN(d)) return getLocalDateString(d);
  }

  return null;
}

// Turns a natural phrase ("2pm", "2:30 pm", "14:00") into minutes-since-
// midnight, or null if no time reads out of the text. The shop only
// offers fixed slots (appSettings.timeSlots), so this is matched back to
// the nearest exact slot by timeSlotLabelFromMinutes() rather than
// treated as an arbitrary time.
function parseTimeFromText(lower) {
  let m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(lower);
  if (m) {
    let hour = parseInt(m[1]);
    const min = m[2] ? parseInt(m[2]) : 0;
    if (m[3] === 'pm' && hour < 12) hour += 12;
    if (m[3] === 'am' && hour === 12) hour = 0;
    return hour * 60 + min;
  }
  m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(lower);
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);
  return null;
}

function timeSlotLabelFromMinutes(mins) {
  return (appSettings.timeSlots || []).find(slot => timeStringToMinutes(slot) === mins) || null;
}

// Routes a typed/spoken message to whichever booking step is currently
// waiting on an answer. Called from sendChatMessage() whenever
// chatBooking.active is true — this is what makes the whole flow work
// identically in speech mode, since voice input becomes a plain chat
// message here exactly like typing does.
function handleChatBookingReply(msgText) {
  const lower = msgText.toLowerCase().trim();

  // Escape hatches — work from any step, so the customer's never stuck
  // inside the flow if they change their mind or need a person.
  if (matchesAny(lower, ['cancel', 'nevermind', 'never mind', 'stop', 'quit', 'start over'])) {
    resetChatBooking();
    return `No problem — I've cancelled that booking. Let me know if you'd like to start over, or ask me anything else.`;
  }
  if (matchesAny(lower, ['human', 'agent', 'real person', 'talk to someone', 'speak to someone'])) {
    resetChatBooking();
    return `Of course — I'll connect you with our team right away. Tap below to call us live or send an email, whichever's easier:${contactActionButtons()}`;
  }

  switch (chatBooking.step) {
    case 'service': {
      const svc = findMentionedService(lower);
      if (!svc) {
        const names = appSettings.services.map(s => s.name).join(', ');
        const chips = appSettings.services.map((s, i) =>
          `<button class="chat-action-btn" onclick="chatBookingPickService(${i})">${s.name} — ${fmtMoney(s.price)}</button>`
        ).join('');
        return `I didn't catch which service — we offer ${names}. Which one?<div class="chat-action-row" style="flex-wrap:wrap;">${chips}</div>`;
      }
      chatBooking.service = svc.name;
      chatBooking.price = svc.price;
      return askNextMissing();
    }
    case 'barber': {
      if (/\b(any|anyone|whoever|no preference|doesn'?t matter|don'?t care)\b/.test(lower)) {
        chatBooking.barber = appSettings.barbers[Math.floor(Math.random() * appSettings.barbers.length)];
        return askNextMissing();
      }
      const barber = findMentionedBarber(lower);
      if (!barber) {
        return `I didn't catch the barber's name — could you say one of: ${appSettings.barbers.join(', ')}? Or say "any barber is fine."`;
      }
      chatBooking.barber = barber;
      return askNextMissing();
    }
    case 'date': {
      const parsedDate = parseDateFromText(lower);
      if (!parsedDate) {
        return `I didn't catch a date — try something like "tomorrow", "this Friday", or "September 20".`;
      }
      const todayStr = getLocalDateString();
      const blocked = (appSettings.blockedDates || []).includes(parsedDate);
      if (parsedDate < todayStr || blocked || appSettings.calendarActive === false) {
        return appSettings.calendarActive === false
          ? `Online booking is temporarily paused — please call or email us instead.${contactActionButtons()}`
          : `That date isn't available — could you try another one?`;
      }
      chatBooking.date = parsedDate;
      // They may have said a time in the same breath ("tuesday at 2pm") —
      // grab it now that we know the date, since we can check availability.
      const parsedMinutes = parseTimeFromText(lower);
      if (parsedMinutes !== null) {
        const slotLabel = timeSlotLabelFromMinutes(parsedMinutes);
        const available = getAvailableChatSlots(chatBooking.barber, chatBooking.date);
        if (slotLabel && available.includes(slotLabel)) chatBooking.time = slotLabel;
      }
      return askNextMissing();
    }
    case 'time': {
      const available = chatBooking.availableSlots.length ? chatBooking.availableSlots : getAvailableChatSlots(chatBooking.barber, chatBooking.date);
      const parsedMinutes = parseTimeFromText(lower);
      let slotLabel = parsedMinutes !== null ? timeSlotLabelFromMinutes(parsedMinutes) : null;
      if (!slotLabel) slotLabel = available.find(s => lower.includes(s.toLowerCase()));
      if (!slotLabel || !available.includes(slotLabel)) {
        return `That time's not available — here's what's open: ${available.join(', ')}. Which works for you?`;
      }
      chatBooking.time = slotLabel;
      return askNextMissing();
    }
    case 'name': {
      chatBooking.name = msgText.trim();
      return askNextMissing();
    }
    case 'phone': {
      const digits = msgText.replace(/\D/g, '');
      if (digits.length < 7) {
        return `That doesn't look like a phone number — could you say/type it again?`;
      }
      chatBooking.phone = msgText.trim();
      return askNextMissing();
    }
    case 'email': {
      const emailMatch = /[^\s@]+@[^\s@]+\.[^\s@]+/.exec(msgText);
      if (!emailMatch) {
        return `That doesn't look like a valid email — could you say/type it again?`;
      }
      chatBooking.email = emailMatch[0];
      return askNextMissing();
    }
    case 'membership': {
      chatBooking.membershipAsked = true;
      if (!/\b(no|none|skip|n\/a|nope)\b/.test(lower)) {
        const idGuess = msgText.trim();
        if (idGuess) chatBooking.membership = idGuess;
      }
      return askNextMissing();
    }
    case 'confirm': {
      if (matchesAny(lower, ['yes', 'yeah', 'yep', 'confirm', 'book it', 'sure', 'go ahead'])) {
        return finalizeBooking();
      }
      if (matchesAny(lower, ['no', 'cancel', 'stop'])) {
        resetChatBooking();
        return `No problem — I've cancelled that. Let me know if you'd like to start over or need anything else.`;
      }
      return `Just let me know — should I go ahead and book this? (yes/no)`;
    }
    default:
      return askNextMissing();
  }
}
