/**
 * A call about an order, in the browser: the guest on /orders, the supplier
 * on /supplier. Voice first; either side can turn a camera on — the animal,
 * the cuts — without the call starting over.
 *
 * The phones talk to each other (WebRTC), not through us. Basu carries the
 * handshake — the caller's offer, the answer of whoever picks up — and the
 * state both screens draw (src/api/calls.ts). A screen waiting on the other
 * side asks «anything after version N?» and is held until there is.
 *
 * Inside the app this file offers nothing: the shell rings with the system's
 * own call screen (`shell.calls`), and a shell that cannot ring yet shows no
 * button at all rather than one that rings nowhere.
 */
import { api, store, shell } from '/api.js';

const ask = (path, opts = {}) => api(path, { ...opts, token: store.guestToken });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const canRtc = () => typeof RTCPeerConnection === 'function' && Boolean(navigator.mediaDevices?.getUserMedia);
const OVER = new Set(['ended', 'declined', 'missed', 'cancelled']);

const ICON = {
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.5 9 3a1 1 0 0 1 1.1.6l1.2 2.9a1 1 0 0 1-.3 1.2L9.4 9a12 12 0 0 0 5.6 5.6l1.3-1.6a1 1 0 0 1 1.2-.3l2.9 1.2a1 1 0 0 1 .6 1.1l-.5 2.4a1.5 1.5 0 0 1-1.5 1.2A15.5 15.5 0 0 1 5.4 5a1.5 1.5 0 0 1 1.2-1.5Z"/></svg>',
  hangup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.3 13.6a13 13 0 0 1 17.4 0l-.9 2.3a1 1 0 0 1-1.2.6l-2.8-.9a1 1 0 0 1-.7-1v-1.7a10 10 0 0 0-6.2 0v1.7a1 1 0 0 1-.7 1l-2.8.9a1 1 0 0 1-1.2-.6l-.9-2.3Z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M5.5 11a6.5 6.5 0 0 0 10.4 5.2M18.5 11a6.4 6.4 0 0 1-.6 2.7M12 17.5V21M4 4l16 16"/></svg>',
  cam: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="m15.5 10.5 5-3v9l-5-3"/></svg>',
  camOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 6.5h5.5a2.5 2.5 0 0 1 2.5 2.5v5.5M15.5 10.5l5-3v9l-3.6-2.2M3.5 7.3A2.5 2.5 0 0 0 3 9v6a2.5 2.5 0 0 0 2.5 2.5H13M4 4l16 16"/></svg>',
};

/** How a call ended, as the other side reads it on the way out. */
function endWords(call, role) {
  if (call.state === 'declined') return role === 'caller' ? 'Татгалзлаа.' : 'Дуудлагаас татгалзлаа.';
  if (call.state === 'missed') return role === 'caller' ? 'Хариу өгсөнгүй.' : 'Аваагүй дуудлага.';
  if (call.state === 'cancelled') return role === 'caller' ? 'Дуудлагыг цуцаллаа.' : 'Залгагч тасаллаа.';
  if (call.end_reason === 'too_long') return 'Дуудлага хэт удсан тул тасаллаа.';
  return 'Дуудлага дууслаа.';
}

/* ── tones ── */

/**
 * The ring and the ringback, made rather than loaded: 425 Hz, the tone a
 * phone in Ulaanbaatar answers with. Returns the way to stop it.
 */
function tone(pattern) {
  let ctx;
  try {
    ctx = new (globalThis.AudioContext ?? globalThis.webkitAudioContext)();
  } catch {
    return () => {};
  }
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  const osc = ctx.createOscillator();
  osc.frequency.value = pattern === 'ring' ? 480 : 425;
  osc.connect(gain);
  osc.start();
  const [on, off] = pattern === 'ring' ? [0.4, 0.2] : [1, 4];
  let t = ctx.currentTime + 0.05;
  for (let i = 0; i < 60; i++) {
    const beeps = pattern === 'ring' ? 2 : 1;
    for (let b = 0; b < beeps; b++) {
      gain.gain.setValueAtTime(0.12, t);
      gain.gain.setValueAtTime(0, t + on);
      t += on + (b < beeps - 1 ? off : 0);
    }
    t += pattern === 'ring' ? 2 : off;
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try {
      osc.stop();
    } catch {
      /* never started */
    }
    void ctx.close().catch(() => {});
  };
}

/** Waits until the browser has found its ways to be reached — or long enough that it has most. */
function gathered(pc, ms = 2500) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/* ── the screen ── */

let current = null;

class CallScreen {
  constructor({ role, peerName, about }) {
    this.role = role;
    this.closed = false;
    this.abort = new AbortController();
    this.stopTone = () => {};
    this.root = document.createElement('div');
    this.root.className = 'call-screen';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'call-peer');
    this.root.innerHTML = `
      <video class="call-remote" playsinline autoplay hidden></video>
      <video class="call-self" playsinline autoplay muted hidden></video>
      <audio class="call-audio" autoplay></audio>
      <div class="call-head">
        <span class="call-about">${esc(about)}</span>
        <h2 class="call-peer" id="call-peer">${esc(peerName)}</h2>
        <p class="call-status" role="status" aria-live="polite"></p>
      </div>
      <div class="call-acts"></div>`;
    this.$ = (sel) => this.root.querySelector(sel);
    document.body.append(this.root);
    document.documentElement.dataset.calling = '';
    this.onLeave = () => this.leaveQuietly();
    addEventListener('pagehide', this.onLeave);
    current = this;
  }

  status(text) {
    this.$('.call-status').textContent = text;
  }

  about(text) {
    this.$('.call-about').textContent = text;
  }

  /** The buttons of the moment: ringing at me, or talking. */
  buttons(kind) {
    const acts = this.$('.call-acts');
    const btn = (act, icon, label, k = '') =>
      `<button class="call-btn" type="button" data-act="${act}"${k ? ` data-k="${k}"` : ''} aria-label="${label}">${icon}<span>${label}</span></button>`;
    acts.innerHTML =
      kind === 'incoming'
        ? btn('end', ICON.hangup, 'Татгалзах', 'end') + btn('answer', ICON.phone, 'Авах', 'answer')
        : btn('mute', ICON.mic, 'Дуу хаах') + btn('camera', ICON.cam, 'Камер') + btn('end', ICON.hangup, 'Таслах', 'end');
    acts.querySelector('[data-act="end"]').addEventListener('click', () => void this.hangUp());
    acts.querySelector('[data-act="answer"]')?.addEventListener('click', () => void this.answer());
    acts.querySelector('[data-act="mute"]')?.addEventListener('click', () => this.toggleMute());
    acts.querySelector('[data-act="camera"]')?.addEventListener('click', () => void this.toggleCamera());
    acts.querySelector('button:last-child')?.focus();
  }

  async microphone() {
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  }

  async connection() {
    const { ice_servers: iceServers } = await ask('/v1/calls/ice');
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    pc.addEventListener('track', (event) => {
      if (event.track.kind === 'audio') {
        const audio = this.$('.call-audio');
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.play().catch(() => {});
        return;
      }
      const video = this.$('.call-remote');
      video.srcObject = new MediaStream([event.track]);
      // A camera turned off on the other side mutes its track a moment later.
      event.track.addEventListener('unmute', () => this.showRemote(true));
      event.track.addEventListener('mute', () => this.showRemote(false));
    });
    pc.addEventListener('connectionstatechange', () => {
      if (this.closed) return;
      if (pc.connectionState === 'connected') this.talking();
      else if (pc.connectionState === 'disconnected') this.status('Холболт сул байна…');
      else if (pc.connectionState === 'failed') void this.hangUp('Холболт тасарлаа.');
    });
    pc.addEventListener('datachannel', (event) => this.channel(event.channel));
  }

  /** A side line for what the picture alone does not say — the camera on or off. */
  channel(dc) {
    this.dc = dc;
    dc.addEventListener('message', (event) => {
      try {
        const said = JSON.parse(event.data);
        if (typeof said.camera === 'boolean') this.showRemote(said.camera);
      } catch {
        /* not ours */
      }
    });
  }

  tell(message) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(message));
  }

  showRemote(on) {
    this.$('.call-remote').hidden = !on;
    this.root.toggleAttribute('data-video', on);
  }

  talking() {
    if (this.started) return;
    this.started = Date.now();
    this.stopTone();
    const tick = () => {
      if (this.closed) return;
      const s = Math.floor((Date.now() - this.started) / 1000);
      this.status(`${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
      this.timer = setTimeout(tick, 1000 - ((Date.now() - this.started) % 1000));
    };
    tick();
  }

  toggleMute() {
    const track = this.mic?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const btn = this.$('[data-act="mute"]');
    btn.toggleAttribute('data-on', !track.enabled);
    btn.innerHTML = `${track.enabled ? ICON.mic : ICON.micOff}<span>${track.enabled ? 'Дуу хаах' : 'Дуу нээх'}</span>`;
    btn.setAttribute('aria-label', track.enabled ? 'Дуу хаах' : 'Дуу нээх');
  }

  async toggleCamera() {
    const sender = this.videoSender();
    if (!sender) return;
    const btn = this.$('[data-act="camera"]');
    if (this.cam) {
      await sender.replaceTrack(null);
      this.cam.getTracks().forEach((t) => t.stop());
      this.cam = null;
      this.$('.call-self').hidden = true;
      this.tell({ camera: false });
    } else {
      try {
        // The back camera on a phone: what is shown is the animal, not the face.
        this.cam = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } });
      } catch {
        this.status('Камерт хандах зөвшөөрөл алга.');
        return;
      }
      await sender.replaceTrack(this.cam.getVideoTracks()[0]);
      const self = this.$('.call-self');
      self.srcObject = this.cam;
      self.hidden = false;
      this.tell({ camera: true });
    }
    btn.toggleAttribute('data-on', Boolean(this.cam));
    btn.innerHTML = `${this.cam ? ICON.camOff : ICON.cam}<span>${this.cam ? 'Камер унтраах' : 'Камер'}</span>`;
    btn.setAttribute('aria-label', this.cam ? 'Камер унтраах' : 'Камер асаах');
  }

  videoSender() {
    return this.pc?.getTransceivers().find((t) => t.receiver.track?.kind === 'video')?.sender ?? null;
  }

  /** Follows the call on the server until it is over, whoever ends it. */
  async follow() {
    let after = this.call.version;
    while (!this.closed) {
      let call;
      try {
        call = await ask(`/v1/calls/${this.call.id}?after=${after}&wait=25`, { signal: this.abort.signal });
      } catch (error) {
        if (this.closed) return;
        if (error.status === 404) return this.finish('Дуудлага олдсонгүй.');
        await sleep(2000);
        continue;
      }
      after = call.version;
      this.call = call;
      if (call.state === 'answered') {
        if (this.role === 'caller' && !this.answered) {
          this.answered = true;
          this.stopTone();
          this.status('Холбогдож байна…');
          try {
            await this.pc.setRemoteDescription({ type: 'answer', sdp: call.answer });
          } catch {
            return void this.hangUp('Холбогдож чадсангүй.');
          }
        } else if (this.role === 'callee' && !call.answered_here && !this.answering) {
          return this.finish('Өөр хүн дуудлагыг авлаа.');
        }
      }
      if (OVER.has(call.state)) return this.finish(endWords(call, this.role));
    }
  }

  async answer() {
    if (this.answering) return;
    this.answering = true;
    this.stopTone();
    this.status('Холбогдож байна…');
    try {
      await this.microphone();
    } catch {
      this.answering = false;
      this.status('Микрофонд хандах зөвшөөрөл алга. Хөтчийн тохиргооноос зөвшөөрнө үү.');
      return;
    }
    try {
      await this.connection();
      await this.pc.setRemoteDescription({ type: 'offer', sdp: this.call.offer });
      this.pc.addTrack(this.mic.getAudioTracks()[0], this.mic);
      // Ready to send a picture from the start, so a camera turned on later needs no second handshake.
      const video = this.pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video');
      if (video) video.direction = 'sendrecv';
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await gathered(this.pc);
      await ask(`/v1/calls/${this.call.id}/answer`, { method: 'POST', body: { answer: this.pc.localDescription.sdp } });
      this.buttons('talking');
    } catch (error) {
      if (error.code === 'TAKEN') return this.finish('Өөр хүн дуудлагыг авлаа.');
      if (error.code === 'OVER') return this.finish('Дуудлага дууссан байна.');
      return void this.hangUp('Холбогдож чадсангүй.');
    }
  }

  /** Cancel, decline or end — the server knows which this is for me now. */
  async hangUp(words) {
    if (this.closed) return;
    const id = this.call?.id;
    this.finish(words ?? (this.role === 'callee' && !this.answering ? 'Дуудлагаас татгалзлаа.' : 'Дуудлага дууслаа.'));
    if (id) await ask(`/v1/calls/${id}/end`, { method: 'POST' }).catch(() => {});
  }

  /** The tab is closing mid-call: tell the server on the way out, or the other side rings on. */
  leaveQuietly() {
    if (this.closed || !this.call?.id) return;
    try {
      void fetch(`/v1/calls/${this.call.id}/end`, { method: 'POST', keepalive: true, headers: { authorization: `Bearer ${store.guestToken}` } });
    } catch {
      /* gone either way */
    }
  }

  finish(words) {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.stopTone();
    clearTimeout(this.timer);
    removeEventListener('pagehide', this.onLeave);
    this.pc?.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.cam?.getTracks().forEach((t) => t.stop());
    this.status(words);
    this.$('.call-acts').replaceChildren();
    this.root.toggleAttribute('data-video', false);
    setTimeout(() => {
      this.root.remove();
      if (current === this) current = null;
      delete document.documentElement.dataset.calling;
    }, 1800);
  }
}

/* ── ringing out ── */

async function ringOut(subject, subjectId, peerName) {
  if (current) return;
  const screen = new CallScreen({ role: 'caller', peerName, about: '' });
  screen.status('Микрофон асааж байна…');
  try {
    await screen.microphone();
  } catch {
    return screen.finish('Микрофонд хандах зөвшөөрөл алга. Хөтчийн тохиргооноос зөвшөөрнө үү.');
  }
  try {
    await screen.connection();
    const pc = screen.pc;
    pc.addTrack(screen.mic.getAudioTracks()[0], screen.mic);
    pc.addTransceiver('video', { direction: 'sendrecv' });
    screen.channel(pc.createDataChannel('basu'));
    await pc.setLocalDescription(await pc.createOffer());
    screen.status('Залгаж байна…');
    screen.buttons('talking');
    await gathered(pc);
    if (screen.closed) return;
    const call = await ask('/v1/calls', { method: 'POST', body: { subject, subject_id: subjectId, offer: pc.localDescription.sdp } });
    // Hung up while the ring was on its way: it must not ring on, unanswerable.
    if (screen.closed) return void ask(`/v1/calls/${call.id}/end`, { method: 'POST' }).catch(() => {});
    screen.call = call;
  } catch (error) {
    return screen.finish(error.message || 'Залгаж чадсангүй.');
  }
  screen.about(screen.call.about);
  screen.status('Дуугарч байна…');
  screen.stopTone = tone('ringback');
  void screen.follow();
}

/**
 * The button on an order, or null when this order cannot be called about
 * from here — calls closed, the order out of its window, a browser that
 * cannot, or an app that does not ring yet.
 */
export async function callButton(subject, subjectId, { className = 's-btn s-btn-line s-btn-block', label = 'Basu-гаар залгах' } = {}) {
  if (shell.present ? !shell.calls : !canRtc()) return null;
  let can;
  try {
    can = await ask(`/v1/calls/can?subject=${encodeURIComponent(subject)}&subject_id=${encodeURIComponent(subjectId)}`);
  } catch {
    return null;
  }
  if (!can?.can_call) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.call = '';
  button.innerHTML = `${ICON.phone}<span>${esc(label)}</span>`;
  button.setAttribute('aria-label', `${can.peer_name} руу Basu-гаар залгах`);
  button.addEventListener('click', () => {
    if (shell.calls) shell.call(subject, subjectId, can.peer_name);
    else void ringOut(subject, subjectId, can.peer_name);
  });
  return button;
}

/* ── ringing in ── */

let listening = false;

function ringIn(call) {
  const screen = new CallScreen({ role: 'callee', peerName: call.peer_name, about: call.about });
  screen.call = call;
  screen.status('Танд залгаж байна…');
  screen.buttons('incoming');
  screen.stopTone = tone('ring');
  void screen.follow();
}

/**
 * While this page is open, a call rung at this person rings here. Only in a
 * browser: inside the app the shell rings, with the phone's own screen.
 */
export function listenForCalls() {
  if (listening || shell.present || !canRtc() || !store.guestToken) return;
  listening = true;
  const seen = new Set();
  void (async () => {
    let known = [];
    for (;;) {
      let calls;
      try {
        ({ calls } = await ask(`/v1/calls/ringing?known=${known.join(',')}&wait=25`));
      } catch (error) {
        if (error.status === 401 || error.status === 403) return;
        await sleep(5000);
        continue;
      }
      known = calls.map((c) => c.id);
      const fresh = calls.find((c) => !seen.has(c.id));
      calls.forEach((c) => seen.add(c.id));
      if (fresh && !current) ringIn(fresh);
    }
  })();
}
