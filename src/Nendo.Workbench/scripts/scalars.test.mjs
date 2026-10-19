import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: 'src/scalars.ts', write: false, rollupOptions: { output: { codeSplitting: false } } } });
const { parseScalar, useNumberLocale } = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));

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
test('a decimal comma is the decimal separator the numpad types, and grouping is still refused', () => {
  assert.deepEqual(parseScalar('Decimal', '12,5'), { $nendoNumber: '12.5' });
  assert.deepEqual(parseScalar('Decimal', ' -0,25 '), { $nendoNumber: '-0.25' });
  assert.deepEqual(parseScalar('Decimal', '3,1415'), { $nendoNumber: '3.1415' });
  assert.deepEqual(parseScalar('Decimal', '12.5'), { $nendoNumber: '12.5' });
  useNumberLocale(() => 'en-US');
  assert.throws(() => parseScalar('Decimal', '1,234'), /thousands separator/, 'en-US: 1,234 may be a thousands grouping');
  assert.throws(() => parseScalar('Decimal', '-12,345'), /thousands separator/);
  assert.deepEqual(parseScalar('Decimal', '0,125'), { $nendoNumber: '0.125' }, 'a leading zero is no grouping');
  assert.deepEqual(parseScalar('Decimal', '-0,125'), { $nendoNumber: '-0.125' });
  assert.deepEqual(parseScalar('Decimal', '1234,567'), { $nendoNumber: '1234.567' }, 'four digits before the comma are no grouping');
  useNumberLocale(() => 'da-DK');
  assert.deepEqual(parseScalar('Decimal', '1,234'), { $nendoNumber: '1.234' }, 'da-DK: the comma is the decimal separator');
  assert.deepEqual(parseScalar('Decimal', '12,5'), { $nendoNumber: '12.5' });
  assert.throws(() => parseScalar('Decimal', '1.234,5'), /dot or a comma/, 'grouping is still refused');
  useNumberLocale(() => 'en-US');
  assert.throws(() => parseScalar('Decimal', '1,234,567'), /dot or a comma/);
  assert.throws(() => parseScalar('Decimal', '1.234,5'), /dot or a comma/);
  assert.throws(() => parseScalar('Decimal', '12,'), /dot or a comma/);
  assert.throws(() => parseScalar('Decimal', '1e3'), /exponent/);
  assert.throws(() => parseScalar('Integer', '12,5'), /whole number/);
  assert.throws(() => parseScalar('Integer', '1.5'), /whole number/);
});
test('empty text, whitespace and nullable booleans remain distinct', () => {
  assert.equal(parseScalar('Text', ''), '');
  assert.equal(parseScalar('Text', '  æøå 🌱\nnext  '), '  æøå 🌱\nnext  ');
  assert.equal(parseScalar('Boolean', ''), null);
  assert.equal(parseScalar('Boolean', 'false'), false);
  assert.equal(parseScalar('Boolean', 'true'), true);
});
