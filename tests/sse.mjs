import assert from 'node:assert/strict';

import { SseParser, parseSseBlock } from '../lib/sse.js';

assert.equal(parseSseBlock(': keep-alive'), null);
assert.deepEqual(parseSseBlock('event: log\nid: 7\ndata: {"sequence":7}'), {
  event: 'log',
  id: '7',
  data: { sequence: 7 }
});
assert.deepEqual(parseSseBlock('event: gap\ndata: {"missed":2,\ndata: "resume_after":5}'), {
  event: 'gap',
  id: null,
  data: { missed: 2, resume_after: 5 }
});

const messages = [];
const parser = new SseParser((message) => messages.push(message));
parser.push('event: log\r\nid: 8\r\nda');
parser.push('ta: {"sequence":8}\r\n\r');
parser.push('\nevent: log\ndata: {"sequence":9}\n\n');
assert.deepEqual(messages.map((message) => message.data.sequence), [8, 9]);

console.log('sse parser tests passed');
