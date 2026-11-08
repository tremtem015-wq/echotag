(() => {
  'use strict';

  const STORAGE_KEY = 'echotag:view';
  const MODES = ['web', 'app'];

  const ICONS = {
    view: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 5h3M11 18.5h2"/></svg>',
    details: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3.5" width="16" height="17" rx="2.5"/><circle cx="12" cy="10" r="2.4"/><path d="M8.5 16.5a3.5 3.5 0 0 1 7 0"/></svg>',
    record: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/></svg>',
    board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M7.5 20.5 10 16.5M16.5 20.5 14 16.5M7.5 8.5h6M7.5 12h9"/></svg>',
  };

  const NAV_ITEMS = [
    { id: 'details', href: '/', labelKey: 'nav.details', icon: 'details' },
    { id: 'recorder', href: '/record', labelKey: 'nav.record', icon: 'record' },
    { id: 'board', href: '/board', labelKey: 'nav.board', icon: 'board' },
  ];

  let mode = readMode();
  let toggle = null;
  let toggleLabel = null;

  init();

  function init() {
    if (!document.body) return;
    injectToggle();
    injectBottomNav();
    applyMode();
    document.addEventListener('echotag:language', updateToggleLabel);
  }

  function readMode() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return MODES.includes(stored) ? stored : 'web';
    } catch {
      return 'web';
    }
  }

  function saveMode() {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Private browsing may disable storage; the mode still applies to this page.
    }
  }

  function t(key) {
    return window.EchoTagI18n ? EchoTagI18n.t(key) : key;
  }

  function injectToggle() {
    const tools = document.querySelector('.header-tools');
    if (!tools) return;

    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'view-toggle';
    toggle.setAttribute('aria-label', t('appmode.aria'));
    toggle.setAttribute('aria-pressed', 'false');
    toggle.innerHTML = `${ICONS.view}<span class="view-toggle-label"></span>`;

    toggleLabel = toggle.querySelector('.view-toggle-label');
    toggle.addEventListener('click', () => {
      mode = mode === 'app' ? 'web' : 'app';
      saveMode();
      applyMode();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    const languageMenu = tools.querySelector('.language-menu');
    if (languageMenu) tools.insertBefore(toggle, languageMenu);
    else tools.append(toggle);

    updateToggleLabel();
  }

  function updateToggleLabel() {
    if (!toggle || !toggleLabel) return;
    const isApp = mode === 'app';
    toggleLabel.textContent = t(isApp ? 'appmode.exit' : 'appmode.enter');
    toggle.setAttribute('aria-pressed', isApp ? 'true' : 'false');
    toggle.setAttribute('aria-label', t('appmode.aria'));
  }

  function applyMode() {
    const isApp = mode === 'app';
    document.body.classList.toggle('app-mode', isApp);
    if (toggle) toggle.classList.toggle('is-active', isApp);
    updateToggleLabel();
  }

  function injectBottomNav() {
    if (document.querySelector('.app-bottom-nav')) return;

    const page = document.body.dataset.page || 'details';
    const nav = document.createElement('nav');
    nav.className = 'app-bottom-nav';
    nav.setAttribute('aria-label', 'App navigation');

    for (const item of NAV_ITEMS) {
      const link = document.createElement('a');
      link.href = item.href;
      link.className = 'app-nav-link';
      if (item.id === page) {
        link.classList.add('is-active');
        link.setAttribute('aria-current', 'page');
      }
      link.innerHTML = `${ICONS[item.icon]}<span></span>`;
      link.querySelector('span').textContent = t(item.labelKey);
      nav.append(link);
    }

    document.body.append(nav);
    document.addEventListener('echotag:language', () => {
      const links = nav.querySelectorAll('.app-nav-link span');
      NAV_ITEMS.forEach((item, index) => {
        if (links[index]) links[index].textContent = t(item.labelKey);
      });
    });
  }
})();
