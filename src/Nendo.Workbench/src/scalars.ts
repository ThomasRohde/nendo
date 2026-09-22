export interface ExactNumber { $nendoNumber: string }

export function exactNumberText(value: unknown): string | null {
  return typeof value === 'object' && value !== null && '$nendoNumber' in value &&
    typeof value.$nendoNumber === 'string' ? value.$nendoNumber : null;
}

export function parseScalar(kind: string, raw: string): unknown {
  if (kind === 'Text') return raw;
  const text = raw.trim();
  if (!text) return null;
  if (kind === 'Boolean') {
    if (text === 'true') return true;
    if (text === 'false') return false;
    throw new Error('Choose Yes, No or Not set.');
  }
  if (kind === 'Integer') {
    if (!/^-?\d+$/.test(text)) throw new Error('Enter a whole number without separators.');
    const value = BigInt(text);
    if (value < -9223372036854775808n || value > 9223372036854775807n) throw new Error('The whole number is outside the supported 64-bit range.');
    return { $nendoNumber: value.toString() } satisfies ExactNumber;
  }
  if (kind === 'Decimal') {
    if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error('Enter a decimal using a dot, without separators or an exponent.');
    const negative = text.startsWith('-');
    const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
    const coefficient = BigInt(whole + fraction);
    if (fraction.length > 28 || coefficient > 79228162514264337593543950335n) throw new Error('The decimal exceeds the supported precision or 28 fractional places.');
    return { $nendoNumber: `${negative ? '-' : ''}${BigInt(whole)}${fraction ? `.${fraction}` : ''}` } satisfies ExactNumber;
  }
  return text;
}
