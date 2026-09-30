import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, decode, encode } from '../shared/protocol.js';

test('encode/decode round-trips', () => {
  const msg = decode(encode(MSG.HELLO, { name: 'Ada', protocol: 1 }));
  assert.deepEqual(msg, { t: 'hello', name: 'Ada', protocol: 1 });
});

test('decode rejects malformed frames without throwing', () => {
  for (const bad of ['', 'not json', 'null', '42', '[]', '{"x":1}', '{"t":5}']) {
    assert.equal(decode(bad), null, bad);
  }
});
