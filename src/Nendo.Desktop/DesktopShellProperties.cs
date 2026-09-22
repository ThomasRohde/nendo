using System.Runtime.InteropServices;

namespace Nendo.Desktop;

/// <summary>
/// The shell's property store, and the two properties Nendo writes into one.
/// <para>
/// Shared by the taskbar menu and the window identity because both write a string
/// property onto a shell object, and the one thing worth getting right is the same
/// for both: a <c>PROPVARIANT</c> is built here rather than by
/// <c>InitPropVariantFromString</c>, which looks like an API and is not — it is an
/// inline function in <c>propvarutil.h</c> with no export behind it, so a DllImport
/// of it throws at the first call.
/// </para>
/// </summary>
internal static class DesktopShellProperties
{
    private const ushort VT_LPWSTR = 31;

    /// <summary>PKEY_Title. What a Jump List row is called.</summary>
    internal static PropertyKey Title { get; } = new(new("F29F85E0-4FF9-1068-AB91-08002B27B3D9"), 2);

    /// <summary>PKEY_AppUserModel_ID. Who a window says it belongs to.</summary>
    internal static PropertyKey AppUserModelId { get; } = new(new("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);

    /// <summary>
    /// Writes one string property and commits it. The allocation is owned from the
    /// moment it is stored: <c>PropVariantClear</c> frees it in every path.
    /// </summary>
    internal static void SetString(IPropertyStore store, PropertyKey key, string value)
    {
        var variant = default(PropVariant);
        try
        {
            variant.Type = VT_LPWSTR;
            variant.Pointer = Marshal.StringToCoTaskMemUni(value);
            store.SetValue(key, ref variant);
            store.Commit();
        }
        finally
        {
            PropVariantClear(ref variant);
        }
    }

    [DllImport("ole32.dll", PreserveSig = false)]
    internal static extern void PropVariantClear(ref PropVariant pvar);

    // Both laid out by the shell, and both with public fields: an interop struct's
    // members are read by the marshaller rather than by this file, and private ones
    // would be warnings for being unused.
    [StructLayout(LayoutKind.Sequential)]
    internal struct PropertyKey(Guid formatId, uint propertyId)
    {
        public Guid FormatId = formatId;
        public uint PropertyId = propertyId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PropVariant
    {
        public ushort Type;
        public ushort Reserved1;
        public ushort Reserved2;
        public ushort Reserved3;
        public IntPtr Pointer;
        public IntPtr Padding;
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PropertyKey pkey);
        void GetValue(in PropertyKey key, out PropVariant pv);
        void SetValue(in PropertyKey key, ref PropVariant pv);
        void Commit();
    }
}
