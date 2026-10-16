// Rolling list of the latest received lines with their parse outcome.
// Line content is untrusted device data, so it is only ever inserted as text.

import { CONFIG } from '../config.js';

export class RawLog {
  constructor(list, maxLines = CONFIG.ui.rawLogLines) {
    this.list = list;
    this.maxLines = maxLines;
  }

  /** @param {'ok'|'warn'|'bad'} kind */
  add(kind, line, reason = '') {
    const li = document.createElement('li');
    li.className = kind;

    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = new Date().toLocaleTimeString();

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = kind === 'ok' ? 'OK' : kind === 'warn' ? 'WARN' : 'REJECT';

    const text = document.createElement('span');
    text.className = 'line';
    text.textContent = printable(line);
    if (reason) {
      const r = document.createElement('span');
      r.className = 'reason';
      r.textContent = reason;
      text.appendChild(r);
    }

    li.append(ts, tag, text);
    this.list.prepend(li);
    while (this.list.childElementCount > this.maxLines) this.list.lastElementChild.remove();
  }

  clear() {
    this.list.replaceChildren();
  }
}

// Make control characters visible instead of silently dropping them.
function printable(s) {
  const clipped = s.length > 160 ? `${s.slice(0, 160)}…` : s;
  return clipped.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
