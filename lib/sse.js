const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

export function parseSseBlock(block) {
  let event = 'message';
  let id = null;
  const data = [];
  for (const line of String(block).split(/\r?\n/u)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value || 'message';
    else if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  const raw = data.join('\n');
  let payload = raw;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Preserve non-JSON SSE payloads for forward compatibility.
  }
  return { event, id, data: payload };
}

export class SseParser {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_SSE_BUFFER_BYTES) {
      this.buffer = '';
      throw new Error('SSE event exceeded the bounded parser buffer');
    }
    let delimiter = this.buffer.match(/\r?\n\r?\n/u);
    while (delimiter && delimiter.index !== undefined) {
      const block = this.buffer.slice(0, delimiter.index);
      this.buffer = this.buffer.slice(delimiter.index + delimiter[0].length);
      const message = parseSseBlock(block);
      if (message) this.onMessage(message);
      delimiter = this.buffer.match(/\r?\n\r?\n/u);
    }
  }

  finish() {
    const block = this.buffer;
    this.buffer = '';
    const message = parseSseBlock(block);
    if (message) this.onMessage(message);
  }
}

export async function consumeSseStream(body, onMessage) {
  if (!body?.getReader) throw new Error('SSE response body is unavailable');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser(onMessage);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.finish();
  } finally {
    reader.releaseLock();
  }
}
