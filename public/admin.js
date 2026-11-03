'use strict';

(() => {
  const search = document.getElementById('adminSearch');
  const list = document.getElementById('recordingList');
  const count = document.getElementById('visibleCount');

  if (search && list) {
    const rows = Array.from(list.querySelectorAll('.recording'));
    const total = Number(count && count.dataset.total) || rows.length;

    if (rows.length) {
      let empty = document.getElementById('searchEmpty');

      if (!empty) {
        empty = document.createElement('div');
        empty.id = 'searchEmpty';
        empty.className = 'empty-state';
        empty.hidden = true;

        const heading = document.createElement('h3');
        heading.textContent = 'No matching notes';
        const copy = document.createElement('p');
        copy.textContent = 'Try a different title or recording code.';

        empty.append(heading, copy);
        list.append(empty);
      }

      const update = () => {
        const query = search.value.trim().toLowerCase();
        let visible = 0;

        for (const row of rows) {
          const matches = !query || (row.dataset.search || '').includes(query);
          row.hidden = !matches;
          if (matches) visible += 1;
        }

        empty.hidden = visible !== 0;
        if (count) {
          count.textContent = query
            ? `${visible} of ${total} ${total === 1 ? 'note' : 'notes'}`
            : `${total} ${total === 1 ? 'note' : 'notes'}`;
        }
      };

      search.addEventListener('input', update);
      update();
    }
  }

  for (const form of document.querySelectorAll('form[data-confirm]')) {
    form.addEventListener('submit', (event) => {
      if (!window.confirm(form.dataset.confirm || 'Delete this recording?')) {
        event.preventDefault();
      }
    });
  }

  const players = Array.from(document.querySelectorAll('audio'));
  for (const player of players) {
    player.addEventListener('play', () => {
      for (const other of players) {
        if (other !== player) other.pause();
      }
    });
  }
})();
