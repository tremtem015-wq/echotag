(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const BASE_KEY = 'echotag:base';
  const HISTORY_KEY = 'echotag:history';
  const DEFAULT_MAX_SECONDS = 300;
  const PRESENCE_INTERVAL_MS = 45000;
  const DEFAULT_GRADES = ['M2', 'G8'];

  const els = {
    statusBadge: $('statusBadge'),
    statusText: $('statusText'),
    errorBanner: $('errorBanner'),
    errorText: $('errorText'),
    blockedBanner: $('blockedBanner'),
    blockedReason: $('blockedReason'),
    identitySummary: $('identitySummary'),
    identityName: $('identityName'),
    identityMeta: $('identityMeta'),
    recordLock: $('recordLock'),
    views: {
      idle: $('view-idle'),
      recording: $('view-recording'),
      preview: $('view-preview'),
      result: $('view-result'),
    },
    recordBtn: $('recordBtn'),
    secureNote: $('secureNote'),
    timer: $('timer'),
    viz: $('viz'),
    stopBtn: $('stopBtn'),
    cancelBtn: $('cancelBtn'),
    previewAudio: $('previewAudio'),
    previewDuration: $('previewDuration'),
    titleInput: $('titleInput'),
    autoplayToggle: $('autoplayToggle'),
    createBtn: $('createBtn'),
    retakeBtn: $('retakeBtn'),
    qrFrame: $('qrFrame'),
    qrImg: $('qrImg'),
    resultTitle: $('resultTitle'),
    resultMeta: $('resultMeta'),
    playLink: $('playLink'),
    copyBtn: $('copyBtn'),
    downloadBtn: $('downloadBtn'),
    openBtn: $('openBtn'),
    baseInput: $('baseInput'),
    applyBaseBtn: $('applyBaseBtn'),
    newBtn: $('newBtn'),
    deleteBtn: $('deleteBtn'),
    recentSection: $('recentSection'),
    recentList: $('recentList'),
    toast: $('toast'),
    retentionNote: $('retentionNote'),
    signOut: $('studentSignOut'),
    maxMinuteLabels: document.querySelectorAll('[data-max-minutes]'),
  };

  const config = {
    maxSeconds: DEFAULT_MAX_SECONDS,
    defaultBaseUrl: location.origin,
    retentionDays: 30,
    maxBytes: 25 * 1024 * 1024,
    uploadEnabled: true,
    grades: DEFAULT_GRADES.slice(),
  };

  const state = {
    view: 'idle',
    stream: null,
    recorder: null,
    chunks: [],
    mime: 'audio/webm',
    discardOnStop: false,
    audioCtx: null,
    analyser: null,
    sourceNode: null,
    rafId: 0,
    timerId: 0,
    canvasCtx: null,
    startedAt: 0,
    measuredDuration: 0,
    levels: [],
    lastLevelAt: 0,
    smoothedLevel: 0,
    qualitySamples: [],
    clippedSamples: 0,
    qualityPeak: 0,
    previewBlob: null,
    previewUrl: null,
    recording: null,
    qrBase: '',
    busy: false,
    blocked: false,
  };

  let toastTimer = 0;
  let presenceTimer = 0;
  let presenceBusy = false;
  let canvasCssWidth = 0;
  let canvasCssHeight = 0;
  let studentIdentity = null;

  const ICON_WAVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg>';
  const ICON_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

  init();

  function init() {
    document.body.classList.toggle(
      'on-localhost',
      ['localhost', '127.0.0.1', '::1'].includes(location.hostname),
    );

    if (!window.isSecureContext) els.secureNote.hidden = false;

    document.addEventListener('echotag:language', () => {
      applyConfigToUi();
      setView(state.view);
      renderIdentitySummary();
    });

    els.recordBtn.addEventListener('click', startRecording);
    els.stopBtn.addEventListener('click', stopRecording);
    els.cancelBtn.addEventListener('click', cancelRecording);
    els.retakeBtn.addEventListener('click', resetToIdle);
    els.newBtn.addEventListener('click', resetToIdle);
    els.createBtn.addEventListener('click', createQR);
    els.copyBtn.addEventListener('click', copyLink);
    els.applyBaseBtn.addEventListener('click', applyBase);
    els.deleteBtn.addEventListener('click', deleteCurrent);

    if (els.signOut) {
      els.signOut.addEventListener('click', signOut);
    }

    els.baseInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyBase();
      }
    });

    els.titleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        createQR();
      }
    });

    els.qrImg.addEventListener('load', () => els.qrFrame.classList.add('ready'));
    els.qrImg.addEventListener('error', () => {
      els.qrFrame.classList.remove('ready');
      toast('Could not load the QR image. Try applying the link again.', 'error');
    });

    window.addEventListener('resize', () => {
      if (state.view === 'recording') fitCanvas();
    });

    window.addEventListener('beforeunload', revokePreviewUrl);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        sendPresence();
      }
    });

    renderHistory();
    applyConfigToUi();
    loadIdentityGate()
      .then((identity) => {
        if (identity) startPresence();
      })
      .catch(() => {
        window.location.replace('/');
      });
    loadConfig();
  }

  async function loadConfig() {
    try {
      const response = await fetch('/api/config', { headers: { Accept: 'application/json' } });
      if (response.status === 403) {
        const data = await response.json().catch(() => null);
        if (data && data.blocked) enterBlockedState(data);
        return;
      }
      if (!response.ok) return;
      const data = await response.json();
      if (Number.isFinite(data.maxSeconds) && data.maxSeconds > 0) config.maxSeconds = data.maxSeconds;
      if (typeof data.defaultBaseUrl === 'string') config.defaultBaseUrl = data.defaultBaseUrl;
      if (Number.isFinite(data.retentionDays)) config.retentionDays = data.retentionDays;
      if (Number.isFinite(data.maxBytes) && data.maxBytes > 0) config.maxBytes = data.maxBytes;
      if (typeof data.uploadEnabled === 'boolean') config.uploadEnabled = data.uploadEnabled;
      if (Array.isArray(data.grades) && data.grades.length) {
        config.grades = data.grades.map((grade) => String(grade).toUpperCase());
      }
      applyConfigToUi();
    } catch {
      // Offline config fetch is non-fatal; the defaults still work.
    }
  }

  function applyConfigToUi() {
    const minutes = Math.max(1, Math.round(config.maxSeconds / 60));
    els.maxMinuteLabels.forEach((label) => {
      label.textContent = String(minutes);
    });

    els.retentionNote.textContent = config.retentionDays > 0
      ? EchoTagI18n.t('footer.retentionDays', { days: config.retentionDays })
      : EchoTagI18n.t('footer.retentionForever');

    if (!config.uploadEnabled) {
      showError('This deployment is not connected to storage yet. Add a Vercel Blob store, then redeploy.');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Student identity gate + presence                                   */
  /* ------------------------------------------------------------------ */

  function readStoredIdentity() {
    const stored = EchoTagIdentity.load();
    return EchoTagIdentity.validate(stored || {}, config.grades);
  }

  async function loadIdentityGate() {
    let identity = null;

    try {
      const response = await fetch('/api/session', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });

      if (response.status === 403) {
        const data = await response.json().catch(() => null);
        if (data && data.blocked) enterBlockedState(data);
        return null;
      }

      if (response.ok) {
        const data = await response.json().catch(() => null);
        if (data && data.signedIn && data.student) {
          const verified = EchoTagIdentity.validate(data.student, config.grades);
          if (verified.ok) {
            identity = verified;
            EchoTagIdentity.save(verified.student);
          }
        }
      }
    } catch {
      // If the session check cannot run, a freshly saved identity keeps the UI usable.
      const stored = readStoredIdentity();
      if (stored.ok) identity = stored;
    }

    if (!identity || !identity.ok) {
      studentIdentity = null;
      els.recordBtn.disabled = true;
      if (els.signOut) els.signOut.hidden = true;
      window.location.replace('/');
      return null;
    }

    studentIdentity = identity.student;
    renderIdentitySummary();
    els.recordLock.textContent = EchoTagI18n.t('recorder.identityUnlocked');
    els.recordLock.classList.add('is-ready');
    els.recordBtn.disabled = state.blocked;
    if (els.signOut) els.signOut.hidden = false;
    return identity;
  }

  async function signOut() {
    if (els.signOut) els.signOut.disabled = true;
    try {
      await fetch('/api/logout', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
    } catch {
      // Even if the request fails, clear the local identity and leave the recorder.
    }
    EchoTagIdentity.clear();
    window.location.replace('/');
  }

  function renderIdentitySummary() {
    if (!studentIdentity) return;
    els.identitySummary.hidden = false;
    els.identityName.textContent = studentIdentity.name;
    els.identityMeta.textContent = `${studentIdentity.id} · ${studentIdentity.grade}`;
  }

  function ensureIdentity() {
    const identity = EchoTagIdentity.validate(studentIdentity || {}, config.grades);
    if (identity.ok) {
      studentIdentity = identity.student;
      return identity;
    }
    showError('Enter your student details before recording.');
    window.location.replace('/');
    return null;
  }

  function startPresence() {
    window.clearInterval(presenceTimer);
    sendPresence();
    presenceTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') sendPresence();
    }, PRESENCE_INTERVAL_MS);
  }

  async function sendPresence() {
    if (state.blocked || presenceBusy) return;
    presenceBusy = true;
    try {
      const response = await fetch('/api/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ page: 'recorder' }),
      });
      if (response.status === 403) {
        const data = await response.json().catch(() => null);
        if (data && data.blocked) enterBlockedState(data);
      }
    } catch {
      // Presence is best-effort; recording still works when the heartbeat fails.
    } finally {
      presenceBusy = false;
    }
  }

  function enterBlockedState(data) {
    if (state.blocked) return;
    state.blocked = true;
    window.clearInterval(presenceTimer);
    presenceTimer = 0;

    if (state.recorder && state.recorder.state !== 'inactive') {
      state.discardOnStop = true;
      try {
        state.recorder.stop();
      } catch {
        // The page is locking anyway.
      }
    }

    stopMeter();
    stopStream();
    window.clearInterval(state.timerId);
    state.timerId = 0;
    els.recordBtn.disabled = true;
    document.body.classList.add('is-blocked');

    if (data && data.reason) {
      els.blockedReason.textContent = EchoTagI18n.t('blocked.apiReason', { reason: data.reason });
    } else {
      els.blockedReason.textContent = EchoTagI18n.t('blocked.defaultReason');
    }
    els.blockedBanner.hidden = false;
    if (data && data.reason) toast(EchoTagI18n.t('blocked.apiReason', { reason: data.reason }), 'error');
  }

  function qualityStats() {
    const samples = state.qualitySamples;
    if (!samples.length) return null;
    const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const silenceRatio = samples.filter((value) => value < 0.004).length / samples.length;
    return {
      averageLevel: Math.round(average * 10000) / 10000,
      peakLevel: Math.round(state.qualityPeak * 10000) / 10000,
      silenceRatio: Math.round(silenceRatio * 1000) / 1000,
      clippingRatio: Math.round((state.clippedSamples / samples.length) * 1000) / 1000,
      samples: samples.length,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Views, errors, toasts                                              */
  /* ------------------------------------------------------------------ */

  function setView(next) {
    if (next !== 'preview') els.previewAudio.pause();

    for (const [name, view] of Object.entries(els.views)) {
      view.hidden = name !== next;
    }

    state.view = next;
    els.statusBadge.dataset.state = next;
    const statusKeys = {
      idle: 'recorder.statusReady',
      recording: 'recorder.statusRecording',
      preview: 'recorder.statusPreview',
      result: 'recorder.statusResult',
    };
    els.statusText.textContent = EchoTagI18n.t(statusKeys[next] || 'recorder.statusReady');
    clearError();
  }

  function showError(message) {
    els.errorText.textContent = message;
    els.errorBanner.hidden = false;
  }

  function clearError() {
    els.errorText.textContent = '';
    els.errorBanner.hidden = true;
  }

  function toast(message, variant = 'success') {
    els.toast.textContent = message;
    els.toast.classList.toggle('is-error', variant === 'error');
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => els.toast.classList.remove('show'), 3400);
  }

  function setButtonBusy(button, busy, label) {
    if (busy) {
      if (!button.dataset.originalLabel) button.dataset.originalLabel = button.innerHTML;
      button.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span> ${label || 'Working…'}`;
      button.disabled = true;
    } else {
      if (button.dataset.originalLabel) button.innerHTML = button.dataset.originalLabel;
      button.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Recording                                                          */
  /* ------------------------------------------------------------------ */

  async function startRecording() {
    clearError();

    if (state.blocked) {
      showError('An administrator has blocked this IP address.');
      return;
    }

    if (!ensureIdentity()) return;

    if (!window.isSecureContext) {
      showError('Microphone access needs a secure page. Open this site via localhost or HTTPS.');
      return;
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      showError('This browser cannot access the microphone. Try Chrome, Edge, Firefox, or Safari.');
      return;
    }
    if (typeof window.MediaRecorder === 'undefined') {
      showError('This browser does not support audio recording. Try a recent version of Chrome, Edge, Firefox, or Safari.');
      return;
    }

    els.recordBtn.disabled = true;
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      els.recordBtn.disabled = false;
      showError(microphoneErrorMessage(error));
      return;
    }
    els.recordBtn.disabled = false;

    state.chunks = [];
    state.levels = [];
    state.lastLevelAt = 0;
    state.smoothedLevel = 0;
    state.measuredDuration = 0;
    state.discardOnStop = false;
    state.qualitySamples = [];
    state.clippedSamples = 0;
    state.qualityPeak = 0;

    startMeter(state.stream);

    try {
      const mimeType = pickMimeType();
      state.recorder = mimeType
        ? new MediaRecorder(state.stream, { mimeType, audioBitsPerSecond: 96000 })
        : new MediaRecorder(state.stream);
    } catch {
      try {
        state.recorder = new MediaRecorder(state.stream);
      } catch {
        stopStream();
        stopMeter();
        showError('Your browser could not start a recording. Try a different browser.');
        return;
      }
    }

    state.mime = state.recorder.mimeType || 'audio/webm';

    state.recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) state.chunks.push(event.data);
    });
    state.recorder.addEventListener('stop', onRecorderStop);
    state.recorder.addEventListener('error', () => {
      state.discardOnStop = true;
      stopMeter();
      stopStream();
      window.clearInterval(state.timerId);
      state.timerId = 0;
      setView('idle');
      showError('The recording stopped unexpectedly. Please try again.');
    });

    setView('recording');
    els.timer.textContent = '0:00';
    state.startedAt = performance.now();

    try {
      state.recorder.start(500);
    } catch {
      stopStream();
      stopMeter();
      showError('The microphone could not start recording. Please try again.');
      setView('idle');
      return;
    }

    fitCanvas();
    drawMeter();
    state.timerId = window.setInterval(tickTimer, 200);
  }

  function pickMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ];

    for (const type of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(type)) return type;
      } catch {
        // Ignore and try the next candidate.
      }
    }
    return '';
  }

  function microphoneErrorMessage(error) {
    switch (error && error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Microphone access was blocked. Allow it in your browser, then tap the mic again.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No microphone was found. Plug one in and try again.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Your microphone is busy in another app. Close it and try again.';
      case 'OverconstrainedError':
        return 'Your microphone does not support the requested settings. Try a different input.';
      default:
        return 'Could not reach your microphone. Check browser permissions and try again.';
    }
  }

  function tickTimer() {
    const elapsed = (performance.now() - state.startedAt) / 1000;
    els.timer.textContent = formatClock(Math.min(elapsed, config.maxSeconds));
    if (elapsed >= config.maxSeconds) stopRecording();
  }

  function stopRecording() {
    if (!state.recorder || state.recorder.state === 'inactive') return;
    state.measuredDuration = Math.min((performance.now() - state.startedAt) / 1000, config.maxSeconds);
    els.timer.textContent = formatClock(state.measuredDuration);
    window.clearInterval(state.timerId);
    state.timerId = 0;
    stopMeter();
    try {
      state.recorder.stop();
    } catch {
      stopStream();
      setView('idle');
      showError('Could not finish the recording. Please try again.');
    }
  }

  function cancelRecording() {
    state.discardOnStop = true;
    window.clearInterval(state.timerId);
    state.timerId = 0;
    stopMeter();
    stopStream();

    if (state.recorder && state.recorder.state !== 'inactive') {
      try {
        state.recorder.stop();
      } catch {
        resetToIdle();
      }
    } else {
      resetToIdle();
    }
  }

  function onRecorderStop() {
    window.clearInterval(state.timerId);
    state.timerId = 0;
    stopMeter();
    stopStream();

    const discard = state.discardOnStop;
    state.discardOnStop = false;
    state.recorder = null;

    const blob = new Blob(state.chunks, { type: state.mime.split(';')[0] || 'audio/webm' });
    state.chunks = [];

    if (discard) {
      setView('idle');
      return;
    }
    if (!blob.size) {
      setView('idle');
      showError('The recording came back empty. Please try again.');
      return;
    }

    state.previewBlob = blob;
    setPreview();
  }

  function setPreview() {
    if (!state.previewBlob) return;

    revokePreviewUrl();
    state.previewUrl = URL.createObjectURL(state.previewBlob);
    els.previewAudio.src = state.previewUrl;
    els.previewAudio.load();
    els.previewDuration.textContent = formatClock(state.measuredDuration);
    els.titleInput.value = '';
    els.autoplayToggle.checked = true;
    els.createBtn.disabled = false;
    setView('preview');
  }

  function resetToIdle() {
    if (state.recorder && state.recorder.state !== 'inactive') {
      state.discardOnStop = true;
      try {
        state.recorder.stop();
      } catch {
        // The stop event may not fire; the cleanup below is enough.
      }
    }

    stopMeter();
    stopStream();
    window.clearInterval(state.timerId);
    state.timerId = 0;

    els.previewAudio.pause();
    els.previewAudio.removeAttribute('src');
    els.previewAudio.load();
    revokePreviewUrl();

    state.previewBlob = null;
    state.recording = null;
    state.recorder = null;
    state.chunks = [];
    state.levels = [];
    state.measuredDuration = 0;
    state.qualitySamples = [];
    state.clippedSamples = 0;
    state.qualityPeak = 0;

    els.qrFrame.classList.remove('ready');
    els.qrImg.removeAttribute('src');
    els.playLink.removeAttribute('href');
    els.openBtn.removeAttribute('href');
    els.downloadBtn.removeAttribute('href');
    els.baseInput.value = '';

    setView('idle');
    loadIdentityGate().catch(() => {
      window.location.replace('/');
    });
  }

  function stopStream() {
    if (!state.stream) return;
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }

  function revokePreviewUrl() {
    if (!state.previewUrl) return;
    URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
  }

  /* ------------------------------------------------------------------ */
  /* Live waveform + peaks                                              */
  /* ------------------------------------------------------------------ */

  function startMeter(stream) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    try {
      state.audioCtx = new AudioContextClass();
      if (state.audioCtx.state === 'suspended') state.audioCtx.resume().catch(() => {});
      state.sourceNode = state.audioCtx.createMediaStreamSource(stream);
      state.analyser = state.audioCtx.createAnalyser();
      state.analyser.fftSize = 1024;
      state.analyser.smoothingTimeConstant = 0.6;
      state.sourceNode.connect(state.analyser);
    } catch {
      stopMeter();
    }
  }

  function stopMeter() {
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
    if (state.sourceNode) {
      try {
        state.sourceNode.disconnect();
      } catch {
        // Already disconnected.
      }
      state.sourceNode = null;
    }
    state.analyser = null;
    if (state.audioCtx) {
      const context = state.audioCtx;
      state.audioCtx = null;
      context.close().catch(() => {});
    }
  }

  function drawMeter() {
    if (!state.analyser) return;

    const data = new Uint8Array(state.analyser.fftSize);
    state.analyser.getByteTimeDomainData(data);

    let sum = 0;
    let peak = 0;
    for (let i = 0; i < data.length; i += 1) {
      const value = (data[i] - 128) / 128;
      sum += value * value;
      const absolute = Math.abs(value);
      if (absolute > peak) peak = absolute;
    }
    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(1, rms * 3.6);
    state.smoothedLevel = state.smoothedLevel * 0.72 + level * 0.28;

    const now = performance.now();
    if (now - state.lastLevelAt >= 40) {
      state.levels.push(Math.max(0.015, state.smoothedLevel));
      state.qualitySamples.push(rms);
      state.qualityPeak = Math.max(state.qualityPeak, rms);
      if (peak >= 0.985) state.clippedSamples += 1;
      state.lastLevelAt = now;
    }

    paintWaveform();
    state.rafId = requestAnimationFrame(drawMeter);
  }

  function fitCanvas() {
    const canvas = els.viz;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasCssWidth = rect.width;
    canvasCssHeight = rect.height;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    state.canvasCtx = canvas.getContext('2d');
    if (state.canvasCtx) state.canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function paintWaveform() {
    const ctx = state.canvasCtx;
    if (!ctx || !canvasCssWidth || !canvasCssHeight) return;

    const width = canvasCssWidth;
    const height = canvasCssHeight;
    ctx.clearRect(0, 0, width, height);

    const mid = height / 2;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(0, mid - 0.5, width, 1);

    const gap = 2;
    const maxBars = Math.max(12, Math.floor(width / 7));
    const step = (width + gap) / maxBars;
    const barWidth = Math.max(2, step - gap);
    const history = state.levels.slice(-maxBars);

    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, 'rgba(139, 92, 246, 0.6)');
    gradient.addColorStop(0.55, '#a78bfa');
    gradient.addColorStop(1, '#22d3ee');

    for (let i = 0; i < history.length; i += 1) {
      const barHeight = Math.max(3, history[i] * (height - 10));
      const x = width - (history.length - i) * step;
      const radius = Math.min(barWidth / 2, 2.5);

      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, mid - barHeight / 2, barWidth, barHeight, radius);
      } else {
        ctx.rect(x, mid - barHeight / 2, barWidth, barHeight);
      }
      ctx.fillStyle = i === history.length - 1 ? '#e9d5ff' : gradient;
      ctx.fill();
    }
  }

  function buildPeaks(levels, barCount = 56) {
    const source = levels.filter((value) => Number.isFinite(value) && value >= 0);
    if (!source.length) return [];

    const buckets = [];
    for (let i = 0; i < barCount; i += 1) {
      const start = Math.floor((i / barCount) * source.length);
      const end = Math.max(start + 1, Math.floor(((i + 1) / barCount) * source.length));
      let sum = 0;
      let count = 0;
      for (let j = start; j < end && j < source.length; j += 1) {
        sum += source[j];
        count += 1;
      }
      buckets.push(count ? sum / count : 0);
    }

    const peak = Math.max(...buckets);
    if (!peak) return buckets.map(() => 0.1);

    return buckets.map((value) => {
      const normalized = Math.pow(value / peak, 0.72);
      return Math.max(0.08, Math.min(1, Math.round(normalized * 100) / 100));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Create + result                                                    */
  /* ------------------------------------------------------------------ */

  async function createQR() {
    if (!state.previewBlob || state.busy) return;

    if (state.blocked) {
      showError('An administrator has blocked this IP address.');
      return;
    }

    const identity = ensureIdentity();
    if (!identity) return;

    if (!config.uploadEnabled) {
      showError('This deployment is not connected to storage yet. Add a Vercel Blob store, then redeploy.');
      return;
    }

    if (state.previewBlob.size > config.maxBytes) {
      showError(
        `This recording is ${formatBytes(state.previewBlob.size)}, but the server accepts up to ${formatBytes(config.maxBytes)}. Record a shorter note.`,
      );
      return;
    }

    state.busy = true;
    clearError();
    setButtonBusy(els.createBtn, true, 'Creating QR…');

    const payload = new FormData();
    payload.append('studentName', identity.student.name);
    payload.append('studentId', identity.student.id);
    payload.append('grade', identity.student.grade);
    payload.append('title', els.titleInput.value.trim());
    payload.append('duration', String(Math.max(0, state.measuredDuration)));
    payload.append('peaks', JSON.stringify(buildPeaks(state.levels)));
    const stats = qualityStats();
    if (stats) payload.append('quality', JSON.stringify(stats));
    payload.append('autoplay', els.autoplayToggle.checked ? '1' : '0');
    payload.append('audio', state.previewBlob, `voice-note.${extensionForMime(state.previewBlob.type)}`);

    try {
      const response = await fetch('/api/recordings', {
        method: 'POST',
        body: payload,
        headers: { Accept: 'application/json' },
      });

      let data = null;
      try {
        data = await response.json();
      } catch {
        // The server fell over before returning JSON.
      }

      if (!response.ok) {
        if (data && data.blocked) {
          enterBlockedState(data);
          return;
        }
        if (response.status === 401 && data && data.signInRequired) {
          EchoTagIdentity.clear();
          showError('Your sign-in expired. Returning to the sign-in page…');
          window.setTimeout(() => window.location.replace('/'), 900);
          return;
        }
        if (data && Array.isArray(data.fields) && data.fields.length) {
          throw new Error(data.fields.join(' '));
        }
        throw new Error((data && data.error) || 'Could not create the QR code. Please try again.');
      }

      state.recording = data;
      state.qrBase = normalizeBase(readSavedBase()) || config.defaultBaseUrl || location.origin;
      populateResult(data);
      setView('result');
      addToHistory(data);
      toast(
        data.underReview
          ? 'Recording saved. An administrator will screen it before public playback.'
          : 'QR code ready. Scan it with your phone.',
        'success',
      );
    } catch (error) {
      showError(error.message || 'Could not create the QR code. Please try again.');
    } finally {
      state.busy = false;
      setButtonBusy(els.createBtn, false);
    }
  }

  function populateResult(recording) {
    els.resultTitle.textContent = recording.title || 'Voice note';

    const meta = [];
    if (recording.duration) meta.push(formatClock(recording.duration));
    if (recording.size) meta.push(formatBytes(recording.size));
    if (recording.expiresAt) meta.push(`Expires ${formatDate(recording.expiresAt)}`);
    if (recording.underReview) meta.push('Awaiting admin screening');
    els.resultMeta.textContent = meta.join(' · ');

    updateResultLinks();
  }

  function updateResultLinks() {
    const recording = state.recording;
    if (!recording) return;

    const base = normalizeBase(state.qrBase) || normalizeBase(config.defaultBaseUrl) || location.origin;
    const playUrl = `${base}/p/${encodeURIComponent(recording.code)}`;
    const qrPath = `/api/recordings/${encodeURIComponent(recording.code)}/qr.png?base=${encodeURIComponent(base)}`;

    els.qrFrame.classList.remove('ready');
    els.qrImg.src = `${qrPath}&v=${Date.now()}`;
    els.playLink.href = playUrl;
    els.playLink.textContent = playUrl.replace(/^https?:\/\//, '');
    els.playLink.title = playUrl;
    els.openBtn.href = playUrl;
    els.downloadBtn.href = qrPath;
    els.downloadBtn.setAttribute('download', `echotag-${recording.code}.png`);
    els.baseInput.value = base;
  }

  function applyBase() {
    const base = normalizeBase(els.baseInput.value.trim());
    if (!base) {
      toast('Enter a full address starting with http:// or https://', 'error');
      return;
    }

    state.qrBase = base;
    try {
      localStorage.setItem(BASE_KEY, base);
    } catch {
      // Private mode may block localStorage; the in-memory value still works.
    }
    updateResultLinks();
    toast('QR link updated.', 'success');
  }

  async function copyLink() {
    const recording = state.recording;
    if (!recording) return;

    const base = normalizeBase(state.qrBase) || location.origin;
    const link = `${base}/p/${encodeURIComponent(recording.code)}`;

    try {
      await copyText(link);
      toast('Link copied.', 'success');
    } catch {
      toast('Could not copy. Select the link manually instead.', 'error');
    }
  }

  async function deleteCurrent() {
    const recording = state.recording;
    if (!recording) return;
    if (!window.confirm('Delete this recording? Its QR code will stop working.')) return;

    els.deleteBtn.disabled = true;
    try {
      const response = await fetch(`/api/recordings/${encodeURIComponent(recording.code)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${recording.deleteToken}` },
      });

      if (!response.ok && response.status !== 404) {
        let message = 'Could not delete the recording.';
        let blocked = null;
        try {
          const data = await response.json();
          if (data && data.error) message = data.error;
          if (data && data.blocked) blocked = data;
        } catch {
          // Keep the generic message.
        }
        if (blocked) {
          enterBlockedState(blocked);
          return;
        }
        throw new Error(message);
      }

      removeFromHistory(recording.code);
      toast('Recording deleted.', 'success');
      resetToIdle();
    } catch (error) {
      toast(error.message || 'Could not delete the recording.', 'error');
    } finally {
      els.deleteBtn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Local history                                                      */
  /* ------------------------------------------------------------------ */

  function readHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item) => item && typeof item.code === 'string' && /^[a-z0-9]{6,16}$/.test(item.code));
    } catch {
      return [];
    }
  }

  function addToHistory(recording) {
    const entry = {
      code: recording.code,
      title: recording.title,
      createdAt: recording.createdAt,
      duration: recording.duration,
    };
    const list = readHistory().filter((item) => item.code !== recording.code);
    list.unshift(entry);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 8)));
    } catch {
      // History is a convenience; ignore storage failures.
    }
    renderHistory();
  }

  function removeFromHistory(code) {
    try {
      const list = readHistory().filter((item) => item.code !== code);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch {
      // Ignore.
    }
    renderHistory();
  }

  function renderHistory() {
    const list = readHistory();
    els.recentSection.hidden = list.length === 0;
    els.recentList.textContent = '';

    for (const item of list) {
      const link = document.createElement('a');
      link.className = 'recent-item';
      link.href = `/p/${encodeURIComponent(item.code)}`;
      link.target = '_blank';
      link.rel = 'noopener';

      const icon = document.createElement('span');
      icon.className = 'recent-icon';
      icon.innerHTML = ICON_WAVE;

      const info = document.createElement('span');
      info.className = 'recent-info';

      const title = document.createElement('span');
      title.className = 'recent-title';
      title.textContent = item.title || 'Voice note';

      const meta = document.createElement('span');
      meta.className = 'recent-meta';
      const bits = [];
      if (item.createdAt) {
        const date = formatDate(item.createdAt);
        if (date) bits.push(date);
      }
      if (item.duration) bits.push(formatClock(item.duration));
      meta.textContent = bits.join(' · ') || 'Voice note';

      const arrow = document.createElement('span');
      arrow.className = 'recent-arrow';
      arrow.innerHTML = ICON_ARROW;

      info.append(title, meta);
      link.append(icon, info, arrow);
      els.recentList.append(link);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Small utilities                                                    */
  /* ------------------------------------------------------------------ */

  function readSavedBase() {
    try {
      return localStorage.getItem(BASE_KEY) || '';
    } catch {
      return '';
    }
  }

  function normalizeBase(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('copy failed');
  }

  function extensionForMime(mime) {
    const base = String(mime || '').split(';')[0].trim().toLowerCase();
    if (base === 'audio/mp4' || base === 'audio/aac' || base === 'audio/x-m4a') return 'm4a';
    if (base === 'audio/ogg') return 'ogg';
    if (base === 'audio/wav' || base === 'audio/x-wav') return 'wav';
    if (base === 'audio/mpeg') return 'mp3';
    return 'webm';
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDate(isoDate) {
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(date);
  }
})();
