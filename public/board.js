(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    list: $('boardList'),
    status: $('boardStatus'),
    refresh: $('boardRefresh'),
    blockedBanner: $('blockedBanner'),
    blockedReason: $('blockedReason'),
  };

  let posts = [];
  let loaded = false;
  let loading = false;
  let blocked = false;

  init();

  function init() {
    if (els.refresh) els.refresh.addEventListener('click', () => loadPosts({ force: true }));
    document.addEventListener('echotag:language', () => render());

    if (typeof window.EchoTagI18n === 'undefined') return;
    loadPosts();
  }

  async function loadPosts({ force = false } = {}) {
    if (loading || blocked) return;
    loading = true;
    if (els.refresh) els.refresh.disabled = true;

    if (!loaded || force) {
      els.status.hidden = false;
      els.status.textContent = EchoTagI18n.t('board.loading');
    }

    try {
      const response = await fetch('/api/board', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });

      const data = await response.json().catch(() => null);

      if (response.status === 403 && data && data.blocked) {
        enterBlockedState(data);
        return;
      }

      if (!response.ok) throw new Error((data && data.error) || 'Board unavailable.');

      posts = Array.isArray(data && data.posts) ? data.posts : [];
      loaded = true;
      render();
    } catch {
      if (!blocked) {
        els.list.replaceChildren();
        els.status.hidden = false;
        els.status.textContent = EchoTagI18n.t('board.error');
        els.status.classList.add('is-error');
      }
    } finally {
      loading = false;
      if (els.refresh) els.refresh.disabled = false;
    }
  }

  function render() {
    if (!loaded || blocked) return;
    els.status.classList.remove('is-error');
    els.list.replaceChildren();

    if (!posts.length) {
      els.status.hidden = true;

      const empty = document.createElement('div');
      empty.className = 'board-empty';

      const title = document.createElement('h3');
      title.textContent = EchoTagI18n.t('board.emptyTitle');

      const body = document.createElement('p');
      body.textContent = EchoTagI18n.t('board.emptyBody');

      empty.append(title, body);
      els.list.append(empty);
      return;
    }

    els.status.hidden = true;

    for (const post of posts) {
      const article = document.createElement('article');
      article.className = 'board-post';

      const head = document.createElement('div');
      head.className = 'board-post-head';

      const title = document.createElement('h3');
      title.textContent = String(post.title || '');
      head.append(title);

      const meta = document.createElement('p');
      meta.className = 'board-post-meta';
      const author = String(post.author || 'Administrator');
      const createdAt = formatDate(post.createdAt);
      meta.textContent = createdAt
        ? `${EchoTagI18n.t('board.postedBy')} ${author} · ${createdAt}`
        : `${EchoTagI18n.t('board.postedBy')} ${author}`;
      if (post.createdAt) meta.title = String(post.createdAt);

      const body = document.createElement('p');
      body.className = 'board-post-body';
      body.textContent = String(post.body || '');

      article.append(head, meta, body);
      els.list.append(article);
    }
  }

  function formatDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(EchoTagI18n.language === 'th' ? 'th-TH' : 'en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
    } catch {
      return date.toLocaleString();
    }
  }

  function enterBlockedState(data) {
    blocked = true;
    els.list.replaceChildren();
    els.status.hidden = true;
    if (els.refresh) els.refresh.disabled = true;
    document.body.classList.add('is-blocked');
    els.blockedReason.textContent = data && data.reason
      ? EchoTagI18n.t('blocked.apiReason', { reason: data.reason })
      : EchoTagI18n.t('blocked.defaultReason');
    els.blockedBanner.hidden = false;
  }
})();
