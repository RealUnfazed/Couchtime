// Voice, camera and screen share between everyone in the call.
//
// Topology: a full mesh. Every participant has one RTCPeerConnection to every other participant.
// That needs no media server and works well for small groups (up to about 6 people).
//
// Each connection carries four fixed "slots" (transceivers), negotiated once, so turning the mic,
// camera or screen share on or off later is just replaceTrack(): no renegotiation, no glitches.
//   slot 0 microphone audio   slot 1 camera video   slot 2 screen video   slot 3 screen audio
//
// Who sends the offer: the peer whose id sorts first. That makes simultaneous offers ("glare")
// impossible without needing the "perfect negotiation" dance.

const SLOT = { mic: 0, cam: 1, screen: 2, screenAudio: 3 };
const BITRATE = { cam: 400_000, screen: 2_500_000 };
const rid = () => Math.random().toString(36).slice(2, 10);

export class CallManager {
  constructor({ selfId, signal, setPresence, getIceServers, onChange, onStream, onSpeaking, toast }) {
    this.selfId = selfId;
    this.signal = signal;             // (peerId, data) => void
    this.setPresence = setPresence;   // (flags) => void
    this.getIceServers = getIceServers;
    this.onChange = onChange;         // () => void  (UI should re-render controls)
    this.onStream = onStream;         // (peerId, kind, MediaStream | null)
    this.onSpeaking = onSpeaking;     // (peerId, boolean)
    this.toast = toast;

    this.inCall = false;
    this.local = { mic: null, cam: null, screen: null, screenAudio: null }; // MediaStreamTrack
    this.localStreams = { mic: null, cam: null, screen: null };             // MediaStream, for previews
    this.peers = new Map();
    this.members = new Map();
    this.iceServers = null;
    this.audioCtx = null;
    this.meters = new Map();          // key -> { analyser, data, speaking }
    this.meterTimer = null;
  }

  get micOn() { return !!(this.local.mic && this.local.mic.enabled); }
  get camOn() { return !!this.local.cam; }
  get screenOn() { return !!this.local.screen; }
  get canShareScreen() { return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia); }
  get flags() { return { inCall: this.inCall, mic: this.micOn, cam: this.camOn, screen: this.screenOn }; }

  publish() { this.setPresence(this.flags); this.onChange(); }

  // ------------------------------------------------------------ joining and leaving

  async join() {
    if (this.inCall) return;
    if (!window.isSecureContext || !navigator.mediaDevices || !window.RTCPeerConnection) {
      this.toast('Voice, camera and screen share need a secure address: https, or localhost.', 'error', 6000);
      return;
    }
    if (!this.iceServers) {
      try { this.iceServers = (await this.getIceServers()).iceServers; } catch (_) { this.iceServers = [{ urls: ['stun:stun.cloudflare.com:3478'] }]; }
    }
    this.ensureAudioContext();
    this.inCall = true;
    await this.startMic(true); // listen-only is fine if the mic is blocked
    this.publish();
    this.connectAll();
  }

  leave() {
    if (!this.inCall) return;
    this.stopTrack('mic'); this.stopTrack('cam'); this.stopTrack('screen'); this.stopTrack('screenAudio');
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.inCall = false;
    this.publish();
  }

  destroy() {
    this.inCall = false;
    for (const k of Object.keys(this.local)) this.stopTrack(k);
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    clearInterval(this.meterTimer);
    if (this.audioCtx) this.audioCtx.close().catch(() => {});
  }

  // Called whenever the room's member list changes.
  syncMembers(list) {
    this.members = new Map(list.map((m) => [m.peerId, m]));
    for (const id of [...this.peers.keys()]) {
      const m = this.members.get(id);
      if (!m || !m.inCall || !this.inCall) this.closePeer(id);
    }
    if (this.inCall) this.connectAll();
  }

  connectAll() {
    for (const m of this.members.values()) {
      if (m.peerId === this.selfId || !m.inCall || this.peers.has(m.peerId)) continue;
      if (this.selfId < m.peerId) this.startOffer(m.peerId);
    }
  }

  // ------------------------------------------------------------ local media

  ensureAudioContext() {
    if (!this.audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) this.audioCtx = new Ctx();
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
  }

  async startMic(quiet = false) {
    if (this.local.mic) { this.local.mic.enabled = true; return true; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.local.mic = stream.getAudioTracks()[0];
      this.localStreams.mic = stream;
      this.local.mic.addEventListener('ended', () => { this.local.mic = null; this.localStreams.mic = null; this.publish(); });
      this.watch('self-mic', stream, (s) => this.onSpeaking(this.selfId, s && this.micOn));
      this.attachAll('mic');
      return true;
    } catch (err) {
      if (!quiet) this.toast('Microphone blocked. Allow it in your browser\'s address bar to talk.', 'error');
      else this.toast('Joined in listen-only mode. Allow the microphone to talk.');
      return false;
    }
  }

  async toggleMic() {
    if (!this.inCall) return;
    if (!this.local.mic) await this.startMic();
    else this.local.mic.enabled = !this.local.mic.enabled;
    this.publish();
  }

  async toggleCam() {
    if (!this.inCall) return;
    if (this.local.cam) { this.stopTrack('cam'); this.publish(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } },
      });
      this.local.cam = stream.getVideoTracks()[0];
      this.localStreams.cam = stream;
      this.local.cam.contentHint = 'motion';
      this.local.cam.addEventListener('ended', () => { this.stopTrack('cam'); this.publish(); });
      this.attachAll('cam');
    } catch (_) {
      this.toast('Camera blocked or not found.', 'error');
    }
    this.publish();
  }

  async toggleScreen() {
    if (!this.inCall) return;
    if (this.local.screen) { this.stopTrack('screen'); this.stopTrack('screenAudio'); this.publish(); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.local.screen = stream.getVideoTracks()[0];
      this.local.screenAudio = stream.getAudioTracks()[0] || null;
      this.localStreams.screen = stream;
      this.local.screen.contentHint = 'motion';
      this.local.screen.addEventListener('ended', () => { this.stopTrack('screen'); this.stopTrack('screenAudio'); this.publish(); });
      this.attachAll('screen');
      this.attachAll('screenAudio');
      if (!this.local.screenAudio) this.toast('Sharing without sound. Pick a browser tab and tick "Share tab audio" to include it.');
    } catch (err) {
      if (err && err.name !== 'NotAllowedError') this.toast('Could not start screen sharing.', 'error');
    }
    this.publish();
  }

  stopTrack(kind) {
    const t = this.local[kind];
    if (t) { try { t.stop(); } catch (_) { /* ignore */ } }
    this.local[kind] = null;
    if (kind === 'mic' || kind === 'cam' || kind === 'screen') {
      const s = this.localStreams[kind];
      if (s) s.getTracks().forEach((tr) => { try { tr.stop(); } catch (_) { /* ignore */ } });
      this.localStreams[kind] = null;
    }
    if (kind === 'mic') this.unwatch('self-mic');
    this.attachAll(kind);
  }

  // ------------------------------------------------------------ peer connections

  newPeer(peerId, initiator, cid) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers || [], bundlePolicy: 'max-bundle' });
    const peer = { id: peerId, pc, initiator, cid, queue: [], remoteSet: false, streams: {}, tries: 0 };
    this.peers.set(peerId, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(peerId, { type: 'candidate', cid, candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => this.onTrack(peer, e);
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') this.applyBitrates(peer);
      if (st === 'failed') this.recover(peer);
    };
    return peer;
  }

  async startOffer(peerId, tries = 0) {
    if (this.peers.has(peerId)) return;
    const cid = rid();
    const peer = this.newPeer(peerId, true, cid);
    peer.tries = tries;
    const pc = peer.pc;
    try {
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      this.attachLocal(peer);
      await pc.setLocalDescription(await pc.createOffer());
      this.signal(peerId, { type: 'offer', cid, sdp: pc.localDescription.toJSON() });
    } catch (err) {
      console.error('[rtc] offer failed', err);
      this.closePeer(peerId);
    }
  }

  async handleOffer(from, data) {
    this.closePeer(from);
    const peer = this.newPeer(from, false, data.cid); // registered synchronously so early ICE candidates are queued
    const pc = peer.pc;
    try {
      await pc.setRemoteDescription(data.sdp);
      peer.remoteSet = true;
      pc.getTransceivers().forEach((t) => { t.direction = 'sendrecv'; });
      this.attachLocal(peer);
      await pc.setLocalDescription(await pc.createAnswer());
      this.signal(from, { type: 'answer', cid: data.cid, sdp: pc.localDescription.toJSON() });
      await this.flush(peer);
    } catch (err) {
      console.error('[rtc] answer failed', err);
      this.closePeer(from);
    }
  }

  async handleSignal(from, data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'offer') {
      if (this.inCall) await this.handleOffer(from, data);
      return;
    }
    const peer = this.peers.get(from);
    if (data.type === 'reset') {
      if (peer && peer.initiator) { this.closePeer(from); this.startOffer(from, peer.tries + 1); }
      return;
    }
    if (!peer || peer.cid !== data.cid) return;
    if (data.type === 'answer') {
      try {
        await peer.pc.setRemoteDescription(data.sdp);
        peer.remoteSet = true;
        await this.flush(peer);
      } catch (err) { console.error('[rtc] bad answer', err); }
    } else if (data.type === 'candidate') {
      if (peer.remoteSet) peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.queue.push(data.candidate);
    }
  }

  async flush(peer) {
    const q = peer.queue.splice(0);
    for (const c of q) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  // A failed ICE connection is recreated from scratch (a few times), then given up on.
  recover(peer) {
    if (!this.peers.has(peer.id) || this.peers.get(peer.id) !== peer) return;
    const tries = peer.tries + 1;
    this.closePeer(peer.id);
    if (tries > 3 || !this.inCall) return;
    const m = this.members.get(peer.id);
    if (!m || !m.inCall) return;
    if (peer.initiator) setTimeout(() => this.inCall && this.startOffer(peer.id, tries), 1000 * tries);
    else this.signal(peer.id, { type: 'reset' });
  }

  closePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    try { peer.pc.close(); } catch (_) { /* ignore */ }
    for (const kind of ['mic', 'cam', 'screen']) {
      this.unwatch(`${peerId}:${kind}`);
      this.onStream(peerId, kind, null);
    }
    this.onSpeaking(peerId, false);
  }

  // ------------------------------------------------------------ tracks

  attachLocal(peer) {
    const tr = peer.pc.getTransceivers();
    if (tr.length < 4) return;
    for (const kind of Object.keys(SLOT)) this.setSender(peer, tr[SLOT[kind]], this.local[kind]);
  }

  attachAll(kind) {
    for (const peer of this.peers.values()) {
      const tr = peer.pc.getTransceivers();
      if (tr.length >= 4) this.setSender(peer, tr[SLOT[kind]], this.local[kind]);
    }
  }

  setSender(peer, transceiver, track) {
    transceiver.sender.replaceTrack(track || null)
      .then(() => { if (track) this.applyBitrates(peer); })
      .catch(() => {});
  }

  applyBitrates(peer) {
    if (peer.pc.connectionState !== 'connected') return;
    const tr = peer.pc.getTransceivers();
    for (const [kind, max] of [['cam', BITRATE.cam], ['screen', BITRATE.screen]]) {
      const sender = tr[SLOT[kind]] && tr[SLOT[kind]].sender;
      if (!sender || !sender.track) continue;
      try {
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = max;
        sender.setParameters(p).catch(() => {});
      } catch (_) { /* some browsers refuse before the first frame */ }
    }
  }

  onTrack(peer, e) {
    const idx = peer.pc.getTransceivers().indexOf(e.transceiver);
    const kind = idx === SLOT.mic ? 'mic' : idx === SLOT.cam ? 'cam' : 'screen'; // screen audio joins the screen stream
    if (!peer.streams[kind]) peer.streams[kind] = new MediaStream();
    const stream = peer.streams[kind];
    stream.addTrack(e.track);
    this.onStream(peer.id, kind, stream);
    if (kind === 'mic') this.watch(`${peer.id}:mic`, stream, (s) => this.onSpeaking(peer.id, s));
  }

  // ------------------------------------------------------------ "who is talking" meters

  watch(key, stream, cb) {
    if (!this.audioCtx || !stream.getAudioTracks().length) return;
    this.unwatch(key);
    try {
      const src = this.audioCtx.createMediaStreamSource(stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this.meters.set(key, { analyser, src, data: new Uint8Array(analyser.fftSize), speaking: false, cb, quiet: 0 });
      if (!this.meterTimer) this.meterTimer = setInterval(() => this.measure(), 160);
    } catch (_) { /* meters are cosmetic */ }
  }

  unwatch(key) {
    const m = this.meters.get(key);
    if (!m) return;
    try { m.src.disconnect(); } catch (_) { /* ignore */ }
    this.meters.delete(key);
    if (m.speaking) m.cb(false);
    if (!this.meters.size) { clearInterval(this.meterTimer); this.meterTimer = null; }
  }

  measure() {
    for (const m of this.meters.values()) {
      m.analyser.getByteTimeDomainData(m.data);
      let peak = 0;
      for (let i = 0; i < m.data.length; i++) peak = Math.max(peak, Math.abs(m.data[i] - 128));
      const loud = peak > 9;
      m.quiet = loud ? 0 : m.quiet + 1;
      const speaking = loud || (m.speaking && m.quiet < 4); // hold the highlight briefly so it does not flicker
      if (speaking !== m.speaking) { m.speaking = speaking; m.cb(speaking); }
    }
  }
}
