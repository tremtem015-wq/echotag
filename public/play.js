(() => {
  'use strict';

  const audio = document.getElementById('audio');
  const noteCard = document.getElementById('noteCard');
  const playBtn = document.getElementById('playBtn');
  const wave = document.getElementById('wave');
  const seek = document.getElementById('seek');
  const currentEl = document.getElementById('currentTime');
  const totalEl = document.getElementById('totalTime');
  const statusLine = document.getElementById('statusLine');
  const hint = document.getElementById('hint');
  const blockedPanel = document.getElementById('playerBlocked');
  const blockedReason = document.getElementById('playerBlockedReason');

  if (!audio || !noteCard || !playBtn) return;

  const bars = wave ? Array.from(wave.querySelectorAll('span')) : [];
  const autoplayWanted = document.body.dataset.autoplay === '1';
  const metaDuration = Number(document.body.dataset.duration) || 0;
  const shareCode = document.body.dataset.code || '';
  const PRESENCE_INTERVAL_MS = 45000;

  let duration = metaDuration;
  let autoplayTried = false;
  let hasPlayed = false;
  let presenceTimer = 0;
  let presenceBusy = false;
  let blockedState = false;

  totalEl.textContent = formatDuration(duration);

  function formatTime(seconds) {
    const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const total = Math.floor(value);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function formatDuration(seconds) {
    const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const total = Math.round(value);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function setStatus(text) {
    statusLine.textContent = text;
  }

  function setHint(text, callout) {
    hint.textContent = text;
    hint.classList.toggle('is-callout', Boolean(callout));
  }

  function setPlaying(playing) {
    document.body.classList.toggle('is-playing', playing);
    playBtn.setAttribute('aria-label', playing ? 'Pause voice note' : 'Play voice note');
  }

  function paint(ratio, time) {
    const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
    seek.value = String(Math.round(clamped * 1000));
    seek.style.setProperty('--progress', `${(clamped * 100).toFixed(2)}%`);
    currentEl.textContent = formatTime(time);

    const lit = Math.round(clamped * bars.length);
    bars.forEach((bar, index) => {
      bar.classList.toggle('is-played', index < lit);
    });
  }

  function updateProgress() {
    const knownDuration = duration || metaDuration;
    const time = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    paint(knownDuration > 0 ? time / knownDuration : 0, time);
  }

  function blocked() {
    setPlaying(false);
    setStatus('Ready to play');
    setHint('Your browser needs a tap before sound can start.', true);
  }

  async function playAudio() {
    try {
      await audio.play();
      setHint('Tap anywhere to pause.');
    } catch {
      blocked();
    }
  }

  function pauseAudio() {
    audio.pause();
  }

  playBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (audio.paused) playAudio();
    else pauseAudio();
  });

  noteCard.addEventListener('click', (event) => {
    if (event.target.closest('button, a, input, .wave')) return;
    if (audio.paused) playAudio();
    else pauseAudio();
  });

  if (wave) {
    wave.addEventListener('click', (event) => {
      const knownDuration = duration || metaDuration;
      if (!knownDuration) {
        if (audio.paused) playAudio();
        return;
      }

      const rect = wave.getBoundingClientRect();
      if (!rect.width) return;
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const target = ratio * knownDuration;

      try {
        audio.currentTime = target;
      } catch {
        // Some browsers need the metadata first; the play attempt below still helps.
      }

      paint(ratio, target);
      if (audio.paused) playAudio();
    });
  }

  seek.addEventListener('input', () => {
    const knownDuration = duration || metaDuration;
    if (!knownDuration) return;

    const ratio = Number(seek.value) / 1000;
    const target = ratio * knownDuration;
    try {
      audio.currentTime = target;
    } catch {
      // Ignore: the next timeupdate will resync.
    }
    paint(ratio, target);
  });

  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('seeked', updateProgress);

  audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      duration = audio.duration;
      totalEl.textContent = formatDuration(duration);
    }
    updateProgress();
  });

  audio.addEventListener('play', () => {
    hasPlayed = true;
    setPlaying(true);
    setStatus('Now playing');
    setHint('Tap anywhere to pause.');
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = 'playing';
      } catch {
        // Ignore unsupported media session calls.
      }
    }
  });

  audio.addEventListener('pause', () => {
    if (audio.ended) return;
    setPlaying(false);
    setStatus(hasPlayed ? 'Paused' : 'Ready to play');
    setHint(hasPlayed ? 'Tap anywhere to keep listening.' : 'Tap the play button to listen.', hasPlayed);
  });

  audio.addEventListener('ended', () => {
    setPlaying(false);
    setStatus('Finished');
    setHint('Tap the play button to hear it again.', true);
    updateProgress();
  });

  audio.addEventListener('error', () => {
    setPlaying(false);
    setStatus('Audio unavailable');
    setHint('This recording could not be loaded.', true);
    playBtn.disabled = true;
  });

  function tryAutoplay() {
    if (!autoplayWanted || autoplayTried) return;
    autoplayTried = true;
    setStatus('Warming up');
    setHint('Trying to play automatically…');

    const attempt = audio.play();
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(blocked);
    }
  }

  if (autoplayWanted) {
    if (audio.readyState >= 2) tryAutoplay();
    else audio.addEventListener('canplay', tryAutoplay, { once: true });
  } else {
    setStatus('Ready to play');
    setHint('Tap the play button to listen.', true);
  }

  if ('mediaSession' in navigator) {
    try {
      if (typeof MediaMetadata !== 'undefined') {
        const title = document.querySelector('.note-title');
        navigator.mediaSession.metadata = new MediaMetadata({
          title: title && title.textContent ? title.textContent.trim() : 'Voice note',
          artist: 'EchoTag',
          album: 'Voice note',
        });
      }
      navigator.mediaSession.setActionHandler('play', () => {
        playAudio();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        audio.pause();
      });
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        audio.currentTime = Math.min(duration || audio.duration || 0, audio.currentTime + (details.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (typeof details.seekTime === 'number') audio.currentTime = details.seekTime;
      });
    } catch {
      // Media Session is a progressive enhancement.
    }
  }

  function sendPresence() {
    if (blockedState || presenceBusy) return;
    presenceBusy = true;
    fetch('/api/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ page: 'player', code: shareCode }),
    })
      .then(async (response) => {
        if (response.status !== 403) return;
        const data = await response.json().catch(() => null);
        if (data && data.blocked) showBlocked(data);
      })
      .catch(() => {
        // Presence is best-effort; playback continues when the heartbeat fails.
      })
      .finally(() => {
        presenceBusy = false;
      });
  }

  function showBlocked(data) {
    if (blockedState) return;
    blockedState = true;
    window.clearInterval(presenceTimer);
    presenceTimer = 0;
    audio.pause();
    playBtn.disabled = true;
    if (seek) seek.disabled = true;
    if (blockedPanel) {
      if (data && data.reason && blockedReason) {
        blockedReason.textContent = `An administrator blocked this IP address. Reason: ${data.reason}`;
      }
      blockedPanel.hidden = false;
    }
    document.body.classList.add('is-blocked');
    setStatus('Access blocked');
    setHint('An administrator has blocked this IP address.', true);
  }

  sendPresence();
  presenceTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') sendPresence();
  }, PRESENCE_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sendPresence();
  });

  updateProgress();
  setPlaying(false);
})();
