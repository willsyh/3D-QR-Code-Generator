// Musik latar bernuansa Tiongkok tradisional, disintesis langsung di browser:
// melodi pentatonik dengan petikan mirip guzheng (sintesis senar Karplus-Strong),
// iringan nada rendah, dan gema lembut. Tidak memakai berkas audio.

const BEAT = 60 / 66; // detik per ketuk
const ROOT = 293.66; // D4
const PENTATONIC = [0, 2, 4, 7, 9]; // jarak semiton: D E F# A B

// Frasa melodi: [indeks tangga nada, panjang dalam ketuk]. Indeks 0 = D4, 5 = D5.
const PHRASES = {
  A: [[5, 1], [4, 0.5], [3, 0.5], [4, 1], [3, 0.5], [2, 0.5], [3, 1], [1, 1], [2, 2]],
  B: [[3, 0.5], [4, 0.5], [5, 1], [6, 1], [5, 0.5], [4, 0.5], [5, 1], [3, 1], [4, 2]],
  C: [[6, 1], [7, 0.5], [6, 0.5], [5, 1], [4, 0.5], [5, 0.5], [3, 1], [2, 0.5], [1, 0.5], [0, 2]],
  D: [[1, 0.5], [2, 0.5], [3, 1], [4, 0.5], [3, 0.5], [2, 1], [1, 1], [3, 1], [0, 2]],
};
const FORM = ['A', 'B', 'A', 'C', 'D', 'B', 'A', 'C'];
const PHRASE_BEATS = 8;

const frequency = (index) => {
  const octave = Math.floor(index / 5);
  const degree = ((index % 5) + 5) % 5;
  return ROOT * 2 ** (octave + PENTATONIC[degree] / 12);
};

// Satu petikan senar: derau pendek yang berputar dalam jalur tunda sepanjang satu
// periode nada dan dihaluskan tiap putaran, sehingga meluruh seperti senar asli.
export function pluckSamples(freq, sampleRate, seconds = 3) {
  const period = Math.max(2, Math.round(sampleRate / freq));
  const out = new Float32Array(Math.floor(sampleRate * seconds));
  let previous = 0;
  for (let i = 0; i < period; i++) {
    const noise = Math.random() * 2 - 1;
    out[i] = (noise + previous) / 2;
    previous = noise;
  }
  const damping = freq > 500 ? 0.4975 : 0.4985; // nada tinggi meluruh lebih cepat
  for (let i = period + 1; i < out.length; i++) {
    out[i] = damping * (out[i - period] + out[i - period - 1]);
  }
  return out;
}

// Seluruh lagu sebagai daftar peristiwa berurutan: { beat, index, gain, bend }.
function buildScore() {
  const events = [];
  FORM.forEach((name, p) => {
    let beat = p * PHRASE_BEATS;
    for (const [index, length] of PHRASES[name]) {
      events.push({ beat, index, gain: 0.5, ornament: length >= 1 });
      if (length >= 2) events.push({ beat, index: index - 5, gain: 0.22 }); // oktaf bawah di akhir frasa
      beat += length;
    }
    for (let bar = 0; bar < PHRASE_BEATS / 2; bar++) {
      events.push({ beat: p * PHRASE_BEATS + bar * 2, index: bar % 2 ? -2 : -5, gain: 0.3 });
    }
  });
  // Sapuan naik sebelum lagu berulang, khas guzheng.
  const total = FORM.length * PHRASE_BEATS;
  for (let i = 0; i < 7; i++) events.push({ beat: total - 0.8 + i * 0.1, index: 1 + i, gain: 0.16 });
  return { events: events.sort((a, b) => a.beat - b.beat), total };
}

export function createMusic() {
  const score = buildScore();
  const buffers = new Map();
  let ctx = null;
  let master = null;
  let echo = null;
  let timer = null;
  let enabled = false;
  let cursor = 0;
  let loopStart = 0;

  function setup() {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    // Gema: tunda dengan umpan balik yang diredam, memberi kesan ruang.
    echo = ctx.createDelay(1);
    echo.delayTime.value = 0.31;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2200;
    echo.connect(tone).connect(feedback).connect(echo);
    tone.connect(master);
  }

  function bufferFor(index) {
    if (!buffers.has(index)) {
      const samples = pluckSamples(frequency(index), ctx.sampleRate);
      const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buffer.copyToChannel(samples, 0);
      buffers.set(index, buffer);
    }
    return buffers.get(index);
  }

  function pluck(index, when, gain, bend) {
    const source = ctx.createBufferSource();
    source.buffer = bufferFor(index);
    if (bend) {
      // Senar ditekan lalu dilepas: nada meluncur naik ke nada tujuan.
      source.playbackRate.setValueAtTime(0.944, when);
      source.playbackRate.linearRampToValueAtTime(1, when + 0.09);
    }
    const level = ctx.createGain();
    level.gain.value = gain;
    source.connect(level);
    level.connect(master);
    level.connect(echo);
    source.start(when);
  }

  // Menjadwalkan nada sedikit lebih awal dari waktunya agar tempo tetap rata.
  function schedule() {
    const horizon = ctx.currentTime + 0.5;
    for (;;) {
      const event = score.events[cursor];
      const when = loopStart + event.beat * BEAT;
      if (when > horizon) break;
      const human = (Math.random() - 0.5) * 0.016;
      const ornament = event.ornament && Math.random() < 0.3;
      if (ornament) pluck(event.index + 1, when - 0.11 + human, event.gain * 0.45, false);
      pluck(event.index, when + human, event.gain * (0.85 + Math.random() * 0.3), ornament);
      cursor++;
      if (cursor === score.events.length) {
        cursor = 0;
        loopStart += score.total * BEAT;
      }
    }
  }

  let gestureSeen = false;

  // Mulai (atau lanjutkan) pemutaran begitu jam audio benar-benar berjalan.
  function begin() {
    if (!enabled || timer || ctx.state !== 'running') return;
    // Lanjutkan dari posisi terakhir; lagu tidak mengulang dari awal tiap kali dinyalakan.
    if (loopStart === 0) loopStart = ctx.currentTime + 0.3;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(0.55, ctx.currentTime, 0.4);
    schedule();
    timer = setInterval(schedule, 120);
  }

  function start() {
    // Browser hanya mengizinkan suara setelah ada interaksi pengguna, jadi
    // konteks audio baru dibuat saat interaksi pertama terjadi.
    const allowed = gestureSeen || navigator.userActivation?.hasBeenActive;
    if (!enabled || document.hidden || !allowed) return;
    if (!ctx) {
      setup();
      ctx.addEventListener('statechange', begin);
    }
    if (ctx.state === 'running') begin();
    else ctx.resume().then(begin, () => {});
  }

  function stop() {
    if (!ctx) return;
    clearInterval(timer);
    timer = null;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
    setTimeout(() => {
      if (!timer) ctx.suspend(); // jam audio ikut berhenti, jadi jadwal tetap sinkron
    }, 400);
  }

  const onGesture = () => {
    gestureSeen = true;
    start();
  };
  window.addEventListener('pointerdown', onGesture);
  window.addEventListener('keydown', onGesture);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  return {
    get enabled() {
      return enabled;
    },
    get playing() {
      return Boolean(timer);
    },
    setEnabled(on) {
      enabled = on;
      if (on) start();
      else stop();
    },
  };
}
