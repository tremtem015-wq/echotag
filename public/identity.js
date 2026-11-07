(() => {
  'use strict';

  const STORAGE_KEY = 'echotag:identity';
  const NAME_PATTERN = /^[\p{L}\p{M} .'’\-]+$/u;
  const ID_PATTERN = /^(?=.*\d)[A-Z0-9][A-Z0-9._/-]{0,29}$/;

  function cleanName(raw) {
    return String(raw || '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  function cleanId(raw) {
    return String(raw || '')
      .trim()
      .replace(/\s+/g, '')
      .toUpperCase()
      .slice(0, 30);
  }

  function validate(value, grades) {
    const name = cleanName(value && value.name);
    const id = cleanId(value && value.id);
    const grade = String((value && value.grade) || '').trim().toUpperCase();
    const allowed = Array.isArray(grades) && grades.length ? grades : [];
    const errors = [];

    if (name.length < 2) {
      errors.push('nameRequired');
    } else if (!/\p{L}/u.test(name)) {
      errors.push('nameLetters');
    } else if (!NAME_PATTERN.test(name)) {
      errors.push('nameChars');
    }

    if (!ID_PATTERN.test(id)) {
      errors.push('idInvalid');
    }

    if (!allowed.includes(grade)) {
      errors.push('gradeRequired');
    }

    return {
      ok: errors.length === 0,
      errors,
      student: { name, id, grade },
    };
  }

  function load() {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        name: cleanName(parsed.name),
        id: cleanId(parsed.id),
        grade: String(parsed.grade || '').trim().toUpperCase(),
      };
    } catch {
      return null;
    }
  }

  function save(student) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        name: cleanName(student.name),
        id: cleanId(student.id),
        grade: String(student.grade || '').trim().toUpperCase(),
      }));
      return true;
    } catch {
      return false;
    }
  }

  function clear() {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // A blocked storage API means there is nothing to clear.
    }
  }

  window.EchoTagIdentity = {
    validate,
    load,
    save,
    clear,
    cleanName,
    cleanId,
    ID_PATTERN,
  };
})();
