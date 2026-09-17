/**
 * Minimal, dependency-free Server-Sent Events parser.
 *
 * Deliberately has no React Native / Node imports so it can be unit tested
 * in plain Node and reused by any transport (expo/fetch, XHR, whatever).
 *
 * Usage:
 *   const parser = createSseParser(evt => ...);
 *   parser.push(chunkString);
 *   parser.end();
 */

export interface SseEvent {
  /** The `event:` field, defaults to "message". */
  event: string;
  /** Concatenated `data:` lines (joined with "\n"). */
  data: string;
  id?: string;
  retry?: number;
}

export interface SseParser {
  push(chunk: string): void;
  /** Flush any trailing event that was not terminated by a blank line. */
  end(): void;
}

export function createSseParser(onEvent: (evt: SseEvent) => void): SseParser {
  // Bytes that have arrived but do not yet form a complete line.
  let buffer = '';

  // Fields of the event currently being assembled.
  let eventName = '';
  let dataLines: string[] = [];
  let lastId: string | undefined;
  let retry: number | undefined;
  let sawAnyField = false;

  function dispatch(): void {
    if (!sawAnyField) {
      resetEvent();
      return;
    }
    // Per spec an event with no data lines is not dispatched.
    if (dataLines.length === 0) {
      resetEvent();
      return;
    }
    onEvent({
      event: eventName || 'message',
      data: dataLines.join('\n'),
      id: lastId,
      retry,
    });
    resetEvent();
  }

  function resetEvent(): void {
    eventName = '';
    dataLines = [];
    retry = undefined;
    sawAnyField = false;
  }

  function handleLine(line: string): void {
    if (line === '') {
      dispatch();
      return;
    }
    // Comment / heartbeat, e.g. ": ping"
    if (line.startsWith(':')) return;

    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      // A single leading space after the colon is part of the framing.
      if (value.startsWith(' ')) value = value.slice(1);
    }

    switch (field) {
      case 'event':
        eventName = value;
        sawAnyField = true;
        break;
      case 'data':
        dataLines.push(value);
        sawAnyField = true;
        break;
      case 'id':
        // Spec: ignore ids containing NULL.
        if (!value.includes('\0')) lastId = value;
        sawAnyField = true;
        break;
      case 'retry': {
        const n = Number(value);
        if (Number.isFinite(n) && /^\d+$/.test(value)) retry = n;
        sawAnyField = true;
        break;
      }
      default:
        // Unknown fields are ignored per spec.
        break;
    }
  }

  return {
    push(chunk: string): void {
      if (!chunk) return;
      buffer += chunk;

      // Split on any of \r\n, \n, \r -- keeping an incomplete tail in `buffer`.
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer[i];
        if (c !== '\n' && c !== '\r') continue;

        // A \r at the very end of the buffer might be the first half of \r\n,
        // so wait for more bytes before deciding.
        if (c === '\r' && i === buffer.length - 1) break;

        handleLine(buffer.slice(start, i));
        if (c === '\r' && buffer[i + 1] === '\n') i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
    },

    end(): void {
      if (buffer.length > 0) {
        const tail = buffer;
        buffer = '';
        handleLine(tail);
      }
      dispatch();
    },
  };
}
