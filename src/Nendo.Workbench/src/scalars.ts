export interface ExactNumber { $nendoNumber: string }

export function exactNumberText(value: unknown): string | null {
  return typeof value === 'object' && value !== null && '$nendoNumber' in value &&
    typeof value.$nendoNumber === 'string' ? value.$nendoNumber : null;
}

/** The person's locale, which says whether a comma is their decimal separator; a test sets its own. */
let numberLocale: () => string = () => (typeof navigator === 'object' && typeof navigator.language === 'string' && navigator.language !== '' ? navigator.language : 'en');

export function useNumberLocale(next: () => string): void {
  numberLocale = next;
}

/** Whether the locale writes 1.5 as 1,5, as Danish, German and French do. */
export function commaDecimalLocale(locale: string): boolean {
  try {
    return new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')?.value === ',';
  } catch {
    return false;
  }
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
    // A decimal comma is what the numpad types on Danish, German and French layouts (W-217), so
    // one comma stands for the dot. Where the person's locale writes its decimals with a dot,
    // '1,234' could be one thousand two hundred and thirty-four, so that one shape -- one to three
    // digits without a leading zero, a comma, then three -- is refused rather than guessed at.
    // '0,125' and '1234,567' cannot be a grouping and are read as decimals everywhere.
    if (!commaDecimalLocale(numberLocale()) && /^-?[1-9]\d{0,2},\d{3}$/.test(text))
      throw new Error('A comma before three digits reads as a thousands separator. Enter the number without separators, or with a dot for the decimal.');
    const lexeme = /^-?\d+,\d+$/.test(text) ? text.replace(',', '.') : text;
    if (!/^-?\d+(\.\d+)?$/.test(lexeme)) throw new Error('Enter a decimal with a dot or a comma, without thousands separators or an exponent.');
    const negative = lexeme.startsWith('-');
    const [whole, fraction = ''] = lexeme.replace(/^-/, '').split('.');
    const coefficient = BigInt(whole + fraction);
    if (fraction.length > 28 || coefficient > 79228162514264337593543950335n) throw new Error('The decimal exceeds the supported precision or 28 fractional places.');
    return { $nendoNumber: `${negative ? '-' : ''}${BigInt(whole)}${fraction ? `.${fraction}` : ''}` } satisfies ExactNumber;
  }
  return text;
}
