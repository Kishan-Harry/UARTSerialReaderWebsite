// Reassembles an arbitrary stream of text chunks into complete lines.
//
// Transports deliver data in whatever pieces the hardware/OS hands over: a USB
// serial read may contain half a record or several, and a BLE notification is
// typically at most 20 bytes, so one ~60-byte record arrives as ~3 chunks.
// Nothing downstream ever sees a chunk — only complete, terminator-delimited lines.

export class LineFramer {
  /**
   * @param {object} opts
   * @param {(line: string) => void} opts.onLine        called once per complete, non-empty line
   * @param {(dropped: string) => void} [opts.onOverflow] called when an unterminated run exceeds maxLineLength
   * @param {number} [opts.maxLineLength]
   */
  constructor({ onLine, onOverflow = () => {}, maxLineLength = 256 }) {
    this.onLine = onLine;
    this.onOverflow = onOverflow;
    this.maxLineLength = maxLineLength;
    this.buffer = '';
  }

  /** Append a chunk of received text. */
  push(chunk) {
    if (!chunk) return;
    this.buffer += chunk;

    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      // Records end in \r\n; strip the \r (and tolerate bare \n).
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);

      if (line.length > this.maxLineLength) {
        this.onOverflow(line);
      } else if (line.trim() !== '') {
        this.onLine(line.trim());
      }
    }

    // No terminator in sight and the partial line is already too long: discard it
    // so a noisy or mis-bauded link can't grow the buffer without bound.
    if (this.buffer.length > this.maxLineLength) {
      this.onOverflow(this.buffer);
      this.buffer = '';
    }
  }

  /** Discard any partial line (call when a new connection starts). */
  reset() {
    this.buffer = '';
  }
}
