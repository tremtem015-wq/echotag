(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const DEFAULT_GRADES = [
    'M.1', 'M.2', 'M.3', 'M.4', 'M.5', 'M.6',
    'G.7', 'G.8', 'G.9', 'G.10', 'G.11', 'G.12',
  ];

  const els = {
    form: $('identityForm'),
    studentNameInput: $('studentNameInput'),
    studentIdInput: $('studentIdInput'),
    gradeInput: $('gradeInput'),
    identityState: $('identityState'),
    identityHint: $('identityHint'),
    continueBtn: $('continueBtn'),
    blockedBanner: $('blockedBanner'),
    blockedReason: $('blockedReason'),
    retentionNote: $('retentionNote'),
    toast: $('toast'),
  };

  const config = {
    grades: DEFAULT_GRADES.slice(),
    retentionDays: 30,
  };

  const state = {
    blocked: false,
  };

  let toastTimer = 0;

  init();

  function init() {
    hydrateGrades();
    hydrateStoredIdentity();
    bindEvents();
    updateIdentityUi();
    applyRetention();
    loadConfig();
  }

  function bindEvents() {
    for (const field of [els.studentNameInput, els.studentIdInput, els.gradeInput]) {
      field.addEventListener('input', updateIdentityUi);
      field.addEventListener('change', updateIdentityUi);
      field.addEventListener('blur', updateIdentityUi);
    }

    els.form.addEventListener('submit', submitIdentity);
    document.addEventListener('echotag:language', () => {
      updateIdentityUi();
      applyRetention();
    });
  }

  function hydrateGrades() {
    const current = els.gradeInput.value;
    els.gradeInput.replaceChildren(new Option(EchoTagI18n.t('details.gradePlaceholder'), ''));
    for (const grade of config.grades) {
      els.gradeInput.append(new Option(grade, grade));
    }
    if (config.grades.includes(current)) els.gradeInput.value = current;
    els.gradeInput.options[0].setAttribute('data-i18n', 'details.gradePlaceholder');
  }

  function hydrateStoredIdentity() {
    const stored = EchoTagIdentity.load();
    if (!stored) return;
    els.studentNameInput.value = stored.name;
    els.studentIdInput.value = stored.id;
    if (config.grades.includes(stored.grade)) els.gradeInput.value = stored.grade;
  }

  function readForm() {
    return {
      name: els.studentNameInput.value,
      id: els.studentIdInput.value,
      grade: els.gradeInput.value,
    };
  }

  function updateIdentityUi() {
    if (state.blocked) {
      els.continueBtn.disabled = true;
      return;
    }

    const identity = EchoTagIdentity.validate(readForm(), config.grades);
    const hasAny = Boolean(
      els.studentNameInput.value.trim()
      || els.studentIdInput.value.trim()
      || els.gradeInput.value,
    );

    if (identity.ok) {
      els.identityState.textContent = EchoTagI18n.t('details.stateReady');
      els.identityState.dataset.state = 'ready';
      els.identityHint.textContent = EchoTagI18n.t('details.readyHint');
    } else {
      els.identityState.textContent = EchoTagI18n.t(
        hasAny ? 'details.stateIncomplete' : 'details.stateRequired',
      );
      els.identityState.dataset.state = hasAny ? 'incomplete' : 'required';
      els.identityHint.textContent = hasAny
        ? EchoTagI18n.t(`errors.${identity.errors[0]}`)
        : EchoTagI18n.t('details.hint');
    }

    els.continueBtn.disabled = !identity.ok;
    return identity;
  }

  function submitIdentity(event) {
    event.preventDefault();
    if (state.blocked) return;

    const identity = updateIdentityUi();
    if (!identity.ok) {
      els.identityHint.textContent = EchoTagI18n.t(`errors.${identity.errors[0]}`);
      focusFirstInvalid(identity);
      return;
    }

    if (!EchoTagIdentity.save(identity.student)) {
      showToast('This browser could not save your details. Allow site storage and try again.', 'error');
      return;
    }

    els.continueBtn.disabled = true;
    els.continueBtn.textContent = EchoTagI18n.t('details.readyHint');
    window.location.assign('/record');
  }

  function focusFirstInvalid(identity) {
    const field = identity.errors.includes('gradeRequired')
      ? els.gradeInput
      : identity.errors.some((error) => error.startsWith('name'))
        ? els.studentNameInput
        : els.studentIdInput;
    if (field && typeof field.focus === 'function') field.focus();
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
      if (Array.isArray(data.grades) && data.grades.length) {
        config.grades = data.grades.map((grade) => String(grade).toUpperCase());
      }
      if (Number.isFinite(data.retentionDays)) config.retentionDays = data.retentionDays;
      hydrateGrades();
      updateIdentityUi();
      applyRetention();
    } catch {
      // The form still works with the built-in grade list when offline.
    }
  }

  function applyRetention() {
    els.retentionNote.textContent = config.retentionDays > 0
      ? EchoTagI18n.t('footer.retentionDays', { days: config.retentionDays })
      : EchoTagI18n.t('footer.retentionForever');
  }

  function enterBlockedState(data) {
    state.blocked = true;
    els.continueBtn.disabled = true;
    document.body.classList.add('is-blocked');
    els.blockedReason.textContent = data && data.reason
      ? EchoTagI18n.t('blocked.apiReason', { reason: data.reason })
      : EchoTagI18n.t('blocked.defaultReason');
    els.blockedBanner.hidden = false;
    if (data && data.reason) showToast(EchoTagI18n.t('blocked.apiReason', { reason: data.reason }), 'error');
  }

  function showToast(message, variant = 'success') {
    els.toast.textContent = message;
    els.toast.classList.toggle('is-error', variant === 'error');
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => els.toast.classList.remove('show'), 3400);
  }
})();
