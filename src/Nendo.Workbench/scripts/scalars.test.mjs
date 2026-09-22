import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: 'src/scalars.ts', write: false, rollupOptions: { output: { codeSplitting: false } } } });
const { parseScalar } = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));

test('integers and decimals preserve all digits and reject overflow or partial input', () => {
  for (const text of ['9223372036854775807', '-9223372036854775808']) assert.deepEqual(parseScalar('Integer', text), { $nendoNumber: text });
  assert.throws(() => parseScalar('Integer', '9223372036854775808'));
  assert.throws(() => parseScalar('Integer', '12.5'));
  assert.throws(() => parseScalar('Integer', '12cats'));
  const exact = '0.1234567890123456789012345678';
  assert.deepEqual(parseScalar('Decimal', exact), { $nendoNumber: exact });
  assert.throws(() => parseScalar('Decimal', '79228162514264337593543950336'));
  assert.throws(() => parseScalar('Decimal', '0.12345678901234567890123456789'));
});
test('empty text, whitespace and nullable booleans remain distinct', () => {
  assert.equal(parseScalar('Text', ''), '');
  assert.equal(parseScalar('Text', '  æøå 🌱\nnext  '), '  æøå 🌱\nnext  ');
  assert.equal(parseScalar('Boolean', ''), null);
  assert.equal(parseScalar('Boolean', 'false'), false);
  assert.equal(parseScalar('Boolean', 'true'), true);
});
