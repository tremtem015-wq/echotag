(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const DEFAULT_GRADES = ['M2', 'G8'];
  const DEFAULT_NUMBER_RANGE = { min: 1, max: 34 };

  const els = {
    form: $('identityForm'),
    studentNameInput: $('studentNameInput'),
    studentIdInput: $('studentIdInput'),
    gradeOptions: $('gradeOptions'),
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
    numberRange: { ...DEFAULT_NUMBER_RANGE },
    retentionDays: 30,
  };

  const state = {
    blocked: false,
    submitting: false,
  };

  let toastTimer = 0;

  init();

  function init() {
    hydrateGrades();
    hydrateNumbers();
    hydrateStoredIdentity();
    bindEvents();
    updateIdentityUi();
    applyRetention();
    loadConfig();
  }

  function bindEvents() {
    for (const field of [els.studentNameInput, els.studentIdInput]) {
      field.addEventListener('input', updateIdentityUi);
      field.addEventListener('change', updateIdentityUi);
      field.addEventListener('blur', updateIdentityUi);
    }

    els.gradeOptions.addEventListener('change', onGradeChange);
    els.form.addEventListener('submit', submitIdentity);
    document.addEventListener('echotag:language', () => {
      hydrateNumbers(els.studentIdInput.value);
      updateIdentityUi();
      applyRetention();
      if (!state.submitting) els.continueBtn.textContent = EchoTagI18n.t('details.continue');
    });
  }

  function onGradeChange(event) {
    const target = event.target;
    if (!target || target.name !== 'grade') return;

    if (target.checked) {
      for (const box of els.gradeOptions.querySelectorAll('input[name="grade"]')) {
        if (box !== target) box.checked = false;
      }
    }

    syncNumberField();
    updateIdentityUi();
  }

  function selectedGrade() {
    const checked = els.gradeOptions.querySelector('input[name="grade"]:checked');
    return checked ? checked.value : '';
  }

  function hydrateGrades() {
    const current = selectedGrade();
    els.gradeOptions.replaceChildren();

    for (const grade of config.grades) {
      const option = document.createElement('label');
      option.className = 'checkbox-option';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'grade';
      input.value = grade;
      input.checked = grade === current;

      const box = document.createElement('span');
      box.className = 'checkbox-box';
      box.setAttribute('aria-hidden', 'true');

      const text = document.createElement('span');
      text.className = 'checkbox-text';
      text.textContent = grade;

      option.append(input, box, text);
      els.gradeOptions.append(option);
    }

    syncNumberField();
  }

  function hydrateNumbers(selected = els.studentIdInput.value) {
    const { min, max } = config.numberRange;
    const placeholder = new Option(EchoTagI18n.t('details.numberPlaceholder'), '');
    placeholder.disabled = true;
    els.studentIdInput.replaceChildren(placeholder);

    for (let number = min; number <= max; number += 1) {
      els.studentIdInput.append(new Option(String(number), String(number)));
    }

    const numeric = Number(selected);
    els.studentIdInput.value = Number.isInteger(numeric) && numeric >= min && numeric <= max
      ? String(numeric)
      : '';

    syncNumberField();
  }

  function syncNumberField() {
    const grade = selectedGrade();
    els.studentIdInput.disabled = !grade;
    if (!grade) els.studentIdInput.value = '';
  }

  function hydrateStoredIdentity() {
    const stored = EchoTagIdentity.load();
    if (!stored) return;

    els.studentNameInput.value = stored.name;

    const gradeBox = config.grades.includes(stored.grade)
      ? els.gradeOptions.querySelector(`input[name="grade"][value="${stored.grade}"]`)
      : null;
    if (!gradeBox) return;

    gradeBox.checked = true;
    syncNumberField();
    els.studentIdInput.value = stored.id;
    if (els.studentIdInput.value !== stored.id) els.studentIdInput.value = '';
  }

  function readForm() {
    return {
      name: els.studentNameInput.value,
      id: els.studentIdInput.value,
      grade: selectedGrade(),
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
      || els.studentIdInput.value
      || selectedGrade(),
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

  async function submitIdentity(event) {
    event.preventDefault();
    if (state.blocked || state.submitting) return;

    const identity = updateIdentityUi();
    if (!identity.ok) {
      els.identityHint.textContent = EchoTagI18n.t(`errors.${identity.errors[0]}`);
      focusFirstInvalid(identity);
      return;
    }

    state.submitting = true;
    els.continueBtn.disabled = true;
    els.continueBtn.textContent = EchoTagI18n.t('details.signingIn');

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          studentName: identity.student.name,
          studentId: identity.student.id,
          grade: identity.student.grade,
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        if (data && data.blocked) {
          enterBlockedState(data);
          return;
        }
        throw new Error((data && data.error) || EchoTagI18n.t('details.loginError'));
      }

      const student = data && data.student ? data.student : identity.student;
      if (!EchoTagIdentity.save(student)) {
        showToast('This browser could not save your details. Allow site storage and try again.', 'error');
        return;
      }

      els.continueBtn.textContent = EchoTagI18n.t('details.readyHint');
      window.location.assign('/record');
    } catch (error) {
      showToast(error.message || EchoTagI18n.t('details.loginError'), 'error');
    } finally {
      state.submitting = false;
      if (!state.blocked) {
        els.continueBtn.textContent = EchoTagI18n.t('details.continue');
        updateIdentityUi();
      }
    }
  }

  function focusFirstInvalid(identity) {
    const gradeBox = els.gradeOptions.querySelector('input[name="grade"]');
    const field = identity.errors.includes('gradeRequired')
      ? gradeBox
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
      if (data.numberRange
        && Number.isInteger(data.numberRange.min)
        && Number.isInteger(data.numberRange.max)) {
        config.numberRange = { min: data.numberRange.min, max: data.numberRange.max };
      }
      if (Number.isFinite(data.retentionDays)) config.retentionDays = data.retentionDays;
      hydrateGrades();
      hydrateNumbers();
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
