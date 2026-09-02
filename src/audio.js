/*
 * Courtyard audio is deliberately event-based: recordings are selected by
 * what happened, then levelled through the same master path. The bundled
 * files are normalized copies of the user's recordings (48 kHz / PCM) so a
 * black stone, white stone, and captured group share a dependable baseline.
 */
const BASE = new URL('../public/audio/', import.meta.url).href;
const LEGACY_ENABLED_KEY = 'espresso-sound-v2';
const SETTINGS_KEY = 'espresso-audio-settings-v1';
const CAPTURE_LIMIT = 7;
const CAPTURE_INTERVAL_MS = 74;

export const AUDIO_ACTIONS = Object.freeze([
  'place-black',
  'place-white',
  'capture',
  'clean-board',
  'pass',
  'resign',
  'ambience',
]);

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  masterVolume: 0.62,
  actionVolumes: {
    'place-black': 0.82,
    'place-white': 0.78,
    capture: 0.68,
    'clean-board': 0.56,
    pass: 0.42,
    resign: 0.46,
    ambience: 0.24,
  },
  // Muting a cue is deliberately separate from reducing its level. This keeps
  // the user's preferred mix reversible and survives a reload.
  actionEnabled: Object.fromEntries(AUDIO_ACTIONS.map((action) => [action, true])),
});

const libraryTakes = (group, count) => Object.freeze(
  Array.from({ length: count }, (_, index) => `library/${group}-${String(index + 1).padStart(2, '0')}.wav`),
);

const ACTION_ASSETS = Object.freeze({
  // Slate and shell recordings respectively: selecting without replacement
  // avoids the same take twice in a row when there is more than one source.
  // Every authored take is available to audition and can be removed alone.
  'place-black': libraryTakes('black', 11),
  'place-white': libraryTakes('white', 9),
  // A hand lifting/sweeping stones is materially correct for a capture.
  capture: libraryTakes('capture', 8),
  // The clearing and resignation recordings are distinct actions: a player
  // can keep one without being forced to keep the other.
  'clean-board': libraryTakes('clean', 20),
  resign: ['resign-1.wav'],
  ambience: libraryTakes('ambience', 9),
});

const ACTION_LABELS = Object.freeze({
  'place-black': 'Black stone',
  'place-white': 'White stone',
  capture: 'Capture',
  'clean-board': 'Board clean',
  resign: 'Resign',
  ambience: 'Ambience',
});

// Individual files, rather than just categories, are exposed so a player can
// keep the takes they like and remove the ones they do not from the rotation.
export const AUDIO_ASSETS = Object.freeze(
  Object.entries(ACTION_ASSETS).flatMap(([action, filenames]) => filenames.map((id, index) => Object.freeze({
    id,
    action,
    label: `${ACTION_LABELS[action]} — ${filenames.length > 1 ? `take ${index + 1}` : 'recording'}`,
  }))),
);

function clampVolume(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function loadSettings() {
  let stored = null;
  try {
    stored = JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) || 'null');
  } catch {
    // Invalid old state is no reason to prevent sound from working.
  }

  const legacyEnabled = (() => {
    try {
      const legacy = globalThis.localStorage?.getItem(LEGACY_ENABLED_KEY);
      return legacy === null || legacy === undefined ? undefined : legacy === 'on';
    } catch {
      return undefined;
    }
  })();

  return {
    enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : legacyEnabled ?? DEFAULT_SETTINGS.enabled,
    masterVolume: clampVolume(stored?.masterVolume, DEFAULT_SETTINGS.masterVolume),
    actionVolumes: Object.fromEntries(AUDIO_ACTIONS.map((action) => [
      action,
      clampVolume(stored?.actionVolumes?.[action], DEFAULT_SETTINGS.actionVolumes[action]),
    ])),
    actionEnabled: Object.fromEntries(AUDIO_ACTIONS.map((action) => [
      action,
      typeof stored?.actionEnabled?.[action] === 'boolean'
        ? stored.actionEnabled[action]
        : DEFAULT_SETTINGS.actionEnabled[action],
    ])),
    assetEnabled: Object.fromEntries(AUDIO_ASSETS.map(({ id }) => [
      id,
      typeof stored?.assetEnabled?.[id] === 'boolean' ? stored.assetEnabled[id] : true,
    ])),
    assetVolumes: Object.fromEntries(AUDIO_ASSETS.map(({ id }) => [
      id,
      clampVolume(stored?.assetVolumes?.[id], 1),
    ])),
  };
}

function audioContextConstructor() {
  return globalThis.AudioContext || globalThis.webkitAudioContext || null;
}

function shuffled(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const alternate = Math.floor(Math.random() * (index + 1));
    [result[index], result[alternate]] = [result[alternate], result[index]];
  }
  return result;
}

export class CourtyardAudio {
  constructor() {
    const settings = loadSettings();
    this.enabled = settings.enabled;
    this.masterVolume = settings.masterVolume;
    this.actionVolumes = settings.actionVolumes;
    this.actionEnabled = settings.actionEnabled;
    this.assetEnabled = settings.assetEnabled;
    this.assetVolumes = settings.assetVolumes;
    this.context = null;
    this.master = null;
    this.cache = new Map();
    this.lastAsset = new Map();
    this.timers = new Set();
    this.sources = new Set();
    this.ambienceSource = null;
    this.ambienceGain = null;
    this.ambienceVoices = new Set();
    this.ambienceTimer = null;
    this.ambienceGeneration = 0;
    this.ambienceStartPending = false;
    this.disposed = false;
  }

  persist() {
    try {
      globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify({
        enabled: this.enabled,
        masterVolume: this.masterVolume,
        actionVolumes: this.actionVolumes,
        actionEnabled: this.actionEnabled,
        assetEnabled: this.assetEnabled,
        assetVolumes: this.assetVolumes,
      }));
      // Kept in sync for sessions created before the per-action controls.
      globalThis.localStorage?.setItem(LEGACY_ENABLED_KEY, this.enabled ? 'on' : 'off');
    } catch {
      // Embedded/private contexts can simply use the current-session setting.
    }
  }

  getSettings() {
    return {
      enabled: this.enabled,
      masterVolume: this.masterVolume,
      actionVolumes: { ...this.actionVolumes },
      actionEnabled: { ...this.actionEnabled },
      assetEnabled: { ...this.assetEnabled },
      assetVolumes: { ...this.assetVolumes },
    };
  }

  getActionVolume(action) {
    return AUDIO_ACTIONS.includes(action) ? this.actionVolumes[action] : undefined;
  }

  getActionEnabled(action) {
    return AUDIO_ACTIONS.includes(action) ? this.actionEnabled[action] : undefined;
  }

  getAssetEnabled(assetId) {
    return AUDIO_ASSETS.some(({ id }) => id === assetId) ? this.assetEnabled[assetId] : undefined;
  }

  getAssetVolume(assetId) {
    return AUDIO_ASSETS.some(({ id }) => id === assetId) ? this.assetVolumes[assetId] : undefined;
  }

  setActionVolume(action, volume) {
    if (!AUDIO_ACTIONS.includes(action)) return false;
    this.actionVolumes[action] = clampVolume(volume, this.actionVolumes[action]);
    if (action === 'ambience' && this.context) {
      this.ambienceVoices.forEach((voice) => {
        voice.gain.gain.setTargetAtTime(this.actionVolumes.ambience * this.assetVolumes[voice.assetId], this.context.currentTime, 0.06);
      });
    }
    this.persist();
    return true;
  }

  setActionEnabled(action, enabled) {
    if (!AUDIO_ACTIONS.includes(action)) return false;
    this.actionEnabled[action] = Boolean(enabled);
    if (action === 'ambience') {
      if (this.actionEnabled.ambience && this.enabled) this.ensureAmbience().catch(() => {});
      else this.stopAmbience();
    }
    this.persist();
    return true;
  }

  setAssetEnabled(assetId, enabled) {
    const asset = AUDIO_ASSETS.find(({ id }) => id === assetId);
    if (!asset) return false;
    this.assetEnabled[assetId] = Boolean(enabled);
    if (asset.action === 'ambience') {
      this.stopAmbience();
      if (this.enabled && this.actionEnabled.ambience && AUDIO_ASSETS.some(({ action, id }) => action === 'ambience' && this.assetEnabled[id])) this.ensureAmbience().catch(() => {});
    }
    this.persist();
    return true;
  }

  setAssetVolume(assetId, volume) {
    if (!AUDIO_ASSETS.some(({ id }) => id === assetId)) return false;
    this.assetVolumes[assetId] = clampVolume(volume, this.assetVolumes[assetId]);
    this.persist();
    return true;
  }

  setMasterVolume(volume) {
    this.masterVolume = clampVolume(volume, this.masterVolume);
    if (this.master) this.master.gain.setTargetAtTime(this.masterVolume, this.context.currentTime, 0.015);
    this.persist();
  }

  async unlock() {
    if (this.disposed) return false;
    if (!this.context) {
      const Constructor = audioContextConstructor();
      if (!Constructor) return false;
      try {
        this.context = new Constructor();
        this.master = this.context.createGain();
        this.master.gain.value = this.masterVolume;
        this.master.connect(this.context.destination);
      } catch {
        this.context = null;
        this.master = null;
        return false;
      }
    }
    if (this.context.state === 'closed') return false;
    if (this.context.state === 'suspended') {
      try { await this.context.resume(); } catch { return false; }
    }
    return this.context.state === 'running' || this.context.state === 'interrupted';
  }

  async setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.persist();
    if (this.enabled) await this.unlock();
    else this.stopAmbience();
  }

  async load(url) {
    if (this.cache.has(url)) return this.cache.get(url);
    const pending = (async () => {
      if (!this.context || typeof globalThis.fetch !== 'function') return null;
      try {
        const response = await globalThis.fetch(url);
        if (!response.ok) return null;
        return await this.context.decodeAudioData(await response.arrayBuffer());
      } catch {
        return null;
      }
    })();
    this.cache.set(url, pending);
    return pending;
  }

  async ensureAmbience() {
    if (
      this.disposed
      || !this.enabled
      || !this.actionEnabled.ambience
      || !this.context
      || !this.master
      || this.ambienceSource
      || this.ambienceStartPending
    ) return;

    await this.startAmbiencePass();
  }

  async startAmbiencePass(previousVoice = null) {
    if (
      this.disposed
      || !this.enabled
      || !this.actionEnabled.ambience
      || !this.context
      || !this.master
      || this.ambienceStartPending
    ) return;

    const generation = this.ambienceGeneration;
    this.ambienceStartPending = true;
    try {
      const sound = await this.chooseAsset('ambience');
      if (
        !sound
        || generation !== this.ambienceGeneration
        || this.disposed
        || !this.enabled
        || !this.actionEnabled.ambience
        || !this.context
        || !this.master
      ) return;

      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      const fade = Math.min(0.8, Math.max(0.24, sound.buffer.duration * 0.1));
      const loops = 1 + Math.floor(Math.random() * 5);
      const duration = sound.buffer.duration * loops;
      source.buffer = sound.buffer;
      source.loop = loops > 1;
      gain.gain.setValueAtTime(0, this.context.currentTime);
      gain.gain.linearRampToValueAtTime(this.actionVolumes.ambience * this.assetVolumes[sound.id], this.context.currentTime + fade);
      source.connect(gain).connect(this.master);
      this.ambienceSource = source;
      this.ambienceGain = gain;
      const voice = { source, gain, assetId: sound.id };
      this.ambienceVoices.add(voice);
      source.onended = () => {
        this.ambienceVoices.delete(voice);
        if (this.ambienceSource === source) {
          this.ambienceSource = null;
          this.ambienceGain = null;
        }
      };
      source.start();
      source.stop(this.context.currentTime + duration + 0.05);
      if (previousVoice && this.ambienceVoices.has(previousVoice)) {
        previousVoice.gain.gain.cancelScheduledValues(this.context.currentTime);
        previousVoice.gain.gain.setValueAtTime(previousVoice.gain.gain.value, this.context.currentTime);
        previousVoice.gain.gain.linearRampToValueAtTime(0, this.context.currentTime + fade);
        try { previousVoice.source.stop(this.context.currentTime + fade + 0.05); } catch { /* It may have ended while blending. */ }
      }
      this.lastAsset.set('ambience', sound.url.replace(BASE, ''));
      this.ambienceTimer = globalThis.setTimeout(() => {
        this.ambienceTimer = null;
        if (generation === this.ambienceGeneration) this.startAmbiencePass(voice).catch(() => {});
      }, Math.max(80, (duration - fade) * 1000));
    } catch {
      // The game remains fully usable when a browser declines looped audio.
    } finally {
      this.ambienceStartPending = false;
    }
  }

  stopAmbience() {
    this.ambienceGeneration += 1;
    this.ambienceStartPending = false;
    if (this.ambienceTimer) globalThis.clearTimeout(this.ambienceTimer);
    this.ambienceTimer = null;
    if (!this.context) return;
    this.ambienceSource = null;
    this.ambienceGain = null;
    const voices = [...this.ambienceVoices];
    this.ambienceVoices.clear();
    voices.forEach(({ source, gain }) => {
      try {
        gain.gain.cancelScheduledValues(this.context.currentTime);
        gain.gain.setValueAtTime(gain.gain.value, this.context.currentTime);
        gain.gain.linearRampToValueAtTime(0, this.context.currentTime + 0.16);
        source.stop(this.context.currentTime + 0.18);
      } catch {
        // A source can finish between the state check and stop().
      }
    });
  }

  async chooseAsset(action) {
    const filenames = ACTION_ASSETS[action] || [];
    const previous = this.lastAsset.get(action);
    const enabledFilenames = filenames.filter((name) => this.assetEnabled[name]);
    for (const filename of shuffled(enabledFilenames.filter((name) => name !== previous))) {
      const url = `${BASE}${filename}`;
      const buffer = await this.load(url);
      if (buffer) return { buffer, url, id: filename };
    }
    for (const filename of enabledFilenames) {
      const url = `${BASE}${filename}`;
      const buffer = await this.load(url);
      if (buffer) return { buffer, url, id: filename };
    }
    return null;
  }

  async playAction(action, { col = 4, distant = false, impact = 1, waitForEnd = false } = {}) {
    if (!this.enabled || !this.actionEnabled[action] || !AUDIO_ACTIONS.includes(action) || !(await this.unlock())) return;
    if (action === 'ambience') {
      await this.ensureAmbience();
      return;
    }
    const filenames = ACTION_ASSETS[action] || [];
    if (filenames.length && !filenames.some((filename) => this.assetEnabled[filename])) return;
    const naturalImpact = Math.max(0.82, Math.min(1.18, Number.isFinite(impact) ? impact : 1));
    const sound = await this.chooseAsset(action);
    if (!this.context || !this.master || this.disposed) return;
    if (!sound) {
      this.playFallback(action, { col, distant, impact: naturalImpact });
      this.ensureAmbience().catch(() => {});
      return;
    }

    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = sound.buffer;
    source.playbackRate.value = 1 + (Math.random() - 0.5) * 0.014 + (naturalImpact - 1) * 0.008;
    gain.gain.setValueAtTime(this.actionVolumes[action] * this.assetVolumes[sound.id] * naturalImpact * (distant ? 0.66 : 1), this.context.currentTime);
    this.connectSpatially(source, gain, col);
    this.sources.add(source);
    const playbackEnded = new Promise((resolve) => {
      source.onended = () => {
        this.sources.delete(source);
        resolve();
      };
    });
    try {
      source.start();
      this.lastAsset.set(action, sound.url.replace(BASE, ''));
      this.ensureAmbience().catch(() => {});
      if (waitForEnd) await playbackEnded;
    } catch {
      this.sources.delete(source);
    }
  }

  async previewAsset(assetId) {
    const asset = AUDIO_ASSETS.find(({ id }) => id === assetId);
    if (!asset || !this.enabled || !(await this.unlock())) return false;
    const buffer = await this.load(`${BASE}${asset.id}`);
    if (!buffer || !this.context || !this.master || this.disposed) return false;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = buffer;
    gain.gain.setValueAtTime(this.actionVolumes[asset.action] * this.assetVolumes[asset.id] * 0.72, this.context.currentTime);
    source.connect(gain).connect(this.master);
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
    source.start();
    return true;
  }

  connectSpatially(source, gain, col) {
    if (!this.context || !this.master) return;
    if (typeof this.context.createStereoPanner === 'function') {
      const panner = this.context.createStereoPanner();
      panner.pan.setValueAtTime(Math.max(-0.18, Math.min(0.18, (col - 4) / 4 * 0.18)), this.context.currentTime);
      source.connect(gain).connect(panner).connect(this.master);
    } else {
      source.connect(gain).connect(this.master);
    }
  }

  async place({ color, row, col, distant = false, impact = 1 }) {
    if ((color !== 'black' && color !== 'white') || !Number.isInteger(row) || !Number.isInteger(col)) return;
    await this.playAction(color === 'black' ? 'place-black' : 'place-white', { col, distant, impact });
  }

  async capture(count) {
    if (!this.enabled || !this.actionEnabled.capture || !Number.isFinite(count) || count <= 0 || !(await this.unlock())) return;
    const total = Math.min(Math.floor(count), CAPTURE_LIMIT);
    for (let index = 0; index < total; index += 1) {
      const timer = globalThis.setTimeout(() => {
        this.timers.delete(timer);
        this.playAction('capture', { distant: index > 0, impact: index === 0 ? 1 : 0.78 });
      }, index * CAPTURE_INTERVAL_MS);
      this.timers.add(timer);
    }
  }

  pass() { return this.playAction('pass'); }

  resign() { return this.playAction('resign'); }

  cleanBoard({ waitForEnd = false } = {}) { return this.playAction('clean-board', { waitForEnd }); }

  clearBoard() { return this.cleanBoard(); }

  // No oscillator fallbacks: sine tones read as electrical on a tactile board.
  // A short, filtered-noise gesture stays recognisably physical if a file is
  // unavailable without trying to impersonate the recorded foley.
  playFallback(action, { col = 4, distant = false, impact = 1 } = {}) {
    if (!this.context || !this.master || this.disposed) return;
    const profile = {
      'place-black': [0.05, 0.1, 900],
      'place-white': [0.05, 0.09, 1300],
      capture: [0.1, 0.09, 720],
      'clean-board': [0.46, 0.055, 1100],
      pass: [0.035, 0.032, 1000],
      resign: [0.16, 0.045, 640],
    }[action];
    if (!profile) return;
    const [duration, gainValue, cutoff] = profile;
    const length = Math.max(1, Math.ceil(this.context.sampleRate * duration));
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const samples = buffer.getChannelData(0);
    let previous = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const progress = index / samples.length;
      const envelope = Math.pow(1 - progress, action === 'clean-board' ? 0.7 : 2.8);
      previous = previous * 0.78 + (Math.random() * 2 - 1) * 0.22;
      samples[index] = previous * envelope;
    }
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    source.buffer = buffer;
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    gain.gain.setValueAtTime(gainValue * this.actionVolumes[action] * impact * (distant ? 0.66 : 1), this.context.currentTime);
    source.connect(filter);
    this.connectSpatially(filter, gain, col);
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
    source.start();
  }

  dispose() {
    this.disposed = true;
    this.stopAmbience();
    for (const timer of this.timers) globalThis.clearTimeout(timer);
    this.timers.clear();
    for (const source of this.sources) {
      try { source.stop(); } catch { /* An already-ended source needs no work. */ }
    }
    this.sources.clear();
    this.master?.disconnect();
    if (this.context && this.context.state !== 'closed') this.context.close().catch(() => {});
    this.context = null;
    this.master = null;
  }
}
