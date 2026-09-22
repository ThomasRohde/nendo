using System.Globalization;
using System.Numerics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Nendo.Engine;

internal static class ExactDecimal
{
    internal static decimal Read(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Number) throw new NendoValidationException("Decimal values must be numbers.");
        var raw = value.GetRawText();
        if (raw.Length > 128) throw new NendoValidationException("Decimal input is too long.");
        var match = Regex.Match(raw, @"^(?<sign>-)?(?<whole>\d+)(?:\.(?<fraction>\d+))?(?:[eE](?<exponent>[+-]?\d+))?$", RegexOptions.CultureInvariant);
        if (!match.Success) throw new NendoValidationException("Invalid decimal value.");
        var exponent = 0;
        if (match.Groups["exponent"].Success &&
            (!int.TryParse(match.Groups["exponent"].Value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out exponent) || Math.Abs((long)exponent) > 128))
            throw new NendoValidationException("Decimal exponent is outside the supported range.");
        var fraction = match.Groups["fraction"].Value;
        var coefficient = BigInteger.Parse(match.Groups["whole"].Value + fraction, NumberStyles.None, CultureInfo.InvariantCulture);
        var scale = fraction.Length - exponent;
        if (scale < 0) { coefficient *= BigInteger.Pow(10, -scale); scale = 0; }
        var maximum = (BigInteger.One << 96) - 1;
        while (scale > 0 && (scale > 28 || coefficient > maximum) && coefficient % 10 == 0)
        { coefficient /= 10; scale--; }
        if (scale > 28 || coefficient > maximum)
            throw new NendoValidationException("Decimal value cannot be represented exactly in the supported precision.");
        return new decimal(unchecked((int)(uint)(coefficient & uint.MaxValue)),
            unchecked((int)(uint)((coefficient >> 32) & uint.MaxValue)), unchecked((int)(uint)(coefficient >> 64)),
            match.Groups["sign"].Success, (byte)scale);
    }
}
