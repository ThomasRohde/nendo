using System.Runtime.InteropServices;

namespace Nendo.Desktop;

/// <summary>One line of the taskbar menu: a file, and the name shown for it.</summary>
internal sealed record DesktopJumpListEntry(string Path, string Title);

/// <summary>
/// The Recent list Windows shows when the taskbar icon is right-clicked.
/// <para>
/// The shell keeps this list itself, in a file named after a hash of the application
/// identity, and hands it back the next time the taskbar button appears. So this is
/// written when the open file changes and not on a timer: there is nothing to say
/// when nothing has moved, and every rewrite is a round trip through the shell.
/// (Entries the person pinned are safe either way — the shell owns the Pinned
/// category and a rewrite of ours does not touch it.)
/// </para>
/// <para>
/// Two parts of the shell contract are easy to miss and both are fatal if skipped.
/// <c>BeginList</c> hands back the destinations the person has removed from this menu,
/// and re-adding one makes <c>CommitList</c> fail — so a removed file stays removed,
/// which is the behaviour a person asking for it expects anyway. And the slot count
/// the shell returns is what the menu has room for; offering more just loses the tail
/// silently.
/// </para>
/// </summary>
internal static class DesktopJumpList
{
    /// <summary>The most rows worth offering, whatever room the shell says it has.</summary>
    internal const int MaximumEntries = 10;

    /// <summary>
    /// How many recent files to confirm before planning, which is more than the menu
    /// holds. The shell's removed list is not known until <c>BeginList</c>, by which
    /// point the history has already been read: without a margin, somebody who removed
    /// three files from the menu would see seven and never the older ones underneath.
    /// </summary>
    internal const int Considered = MaximumEntries + 8;
    private const uint CLSCTX_INPROC_SERVER = 1;

    private static readonly Guid CLSID_DestinationList = new("77f10cf0-3db5-4966-b520-b7c54fd35ed6");
    private static readonly Guid CLSID_EnumerableObjectCollection = new("2d3468c1-36a7-43b6-ac24-d3f02fd9607a");
    private static readonly Guid CLSID_ShellLink = new("00021401-0000-0000-C000-000000000046");
    private static readonly Guid IID_ICustomDestinationList = new("6332debf-87b5-4670-90c0-5e57b408a49e");
    private static readonly Guid IID_IObjectArray = new("92CA9DCD-5622-4bba-A805-5E9F541BD8C9");
    private static readonly Guid IID_IObjectCollection = new("5632b1a4-e38a-400a-928a-d4cd63230295");
    private static readonly Guid IID_IShellLinkW = new("000214F9-0000-0000-C000-000000000046");

    /// <summary>
    /// Which recent files to offer, and under what names.
    /// </summary>
    /// <param name="files">Recent files, newest first.</param>
    /// <param name="removed">Full paths the person has taken off this menu.</param>
    /// <param name="slots">How many rows the shell says it has room for.</param>
    /// <remarks>
    /// Two files can share a name and often do — a backup beside its original. Where
    /// that happens the folder is added to both, because a menu offering "Work.nendo"
    /// twice tells a person nothing about which one they are about to open.
    /// </remarks>
    internal static IReadOnlyList<DesktopJumpListEntry> Plan(
        IReadOnlyList<DesktopShellRecentFile> files,
        IReadOnlyCollection<string> removed,
        int slots)
    {
        var limit = Math.Clamp(slots, 0, MaximumEntries);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var candidates = new List<DesktopShellRecentFile>();
        foreach (var file in files.OrderByDescending(file => file.LastOpened))
        {
            if (candidates.Count == limit) break;
            if (!seen.Add(file.Path)) continue;
            if (removed.Contains(file.Path, StringComparer.OrdinalIgnoreCase)) continue;
            candidates.Add(file);
        }
        var ambiguous = candidates
            .GroupBy(file => file.FileName, StringComparer.OrdinalIgnoreCase)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        return candidates
            .Select(file => new DesktopJumpListEntry(file.Path, ambiguous.Contains(file.FileName)
                ? $"{file.FileName} — {FolderOf(file.Path)}"
                : file.FileName))
            .ToArray();
    }

    private static string FolderOf(string path)
    {
        var folder = Path.GetDirectoryName(path);
        if (string.IsNullOrEmpty(folder)) return path;
        var leaf = Path.GetFileName(folder.TrimEnd(Path.DirectorySeparatorChar));
        return string.IsNullOrEmpty(leaf) ? folder : leaf;
    }

    /// <summary>
    /// Publishes the taskbar menu for this application identity.
    /// </summary>
    /// <returns>
    /// How many entries the shell accepted, or null when the shell refused the list.
    /// Nothing in the product reads this; a lane does, so that "Windows said no" and
    /// "Nendo offered nothing" stop looking the same.
    /// </returns>
    /// <remarks>
    /// Everything here is best effort. A missing taskbar menu is a missing convenience;
    /// a window that failed to open because of one would be a defect.
    /// </remarks>
    internal static int? Publish(IReadOnlyList<DesktopShellRecentFile> files, string appUserModelId, string executablePath, string iconPath)
    {
        ICustomDestinationList? list = null;
        try
        {
            list = Create<ICustomDestinationList>(CLSID_DestinationList, IID_ICustomDestinationList);
            if (list is null) return null;
            list.SetAppID(appUserModelId);
            list.BeginList(out var slots, IID_IObjectArray, out var removedObject);
            var entries = Plan(files, PathsIn(removedObject as IObjectArray), (int)slots);
            if (entries.Count == 0)
            {
                // Still a commit: an empty list is how a menu with nothing worth
                // offering is cleared. Aborting would leave yesterday's files behind.
                list.CommitList();
                return 0;
            }
            var collection = Create<IObjectCollection>(CLSID_EnumerableObjectCollection, IID_IObjectCollection);
            if (collection is null) { list.AbortList(); return null; }
            foreach (var entry in entries)
            {
                var link = CreateLink(entry, executablePath, iconPath);
                if (link is not null) collection.AddObject(link);
            }
            list.AppendCategory("Recent", (IObjectArray)collection);
            list.CommitList();
            return entries.Count;
        }
        // Every exception, and the width is the point. This runs on the UI thread,
        // through the dispatcher, so anything that escapes it ends the process rather
        // than costing a menu. What stops a real defect hiding behind that is not a
        // narrower catch here but Review-ShellRuntime.ps1, which asserts that Windows
        // actually stored a list naming the open file.
        catch (Exception)
        {
            try { list?.AbortList(); } catch (Exception) { }
            return null;
        }
    }

    private static IReadOnlyCollection<string> PathsIn(IObjectArray? removed)
    {
        var paths = new List<string>();
        if (removed is null) return paths;
        uint count;
        // An unreadable removal list is read as empty. Worst case a file the person
        // removed comes back once, and CommitList refusing it is caught by the caller.
        try { removed.GetCount(out count); }
        catch (COMException) { return paths; }
        for (uint index = 0; index < count; index++)
        {
            // Per entry, because the shell may hand back something that is not a
            // shortcut at all, and one of those must not cost us the rest of the list.
            try
            {
                removed.GetAt(index, IID_IShellLinkW, out var item);
                if (item is not IShellLinkW link) continue;
                var buffer = new char[1024];
                link.GetArguments(buffer, buffer.Length);
                var terminator = Array.IndexOf(buffer, '\0');
                var argument = Unquote(new string(buffer, 0, terminator < 0 ? buffer.Length : terminator));
                if (argument.Length != 0) paths.Add(argument);
            }
            catch (Exception exception) when (exception is COMException or InvalidCastException)
            {
            }
        }
        return paths;
    }

    private static string Unquote(string value)
    {
        var trimmed = value.Trim();
        return trimmed.Length >= 2 && trimmed[0] == '"' && trimmed[^1] == '"' ? trimmed[1..^1] : trimmed;
    }

    private static IShellLinkW? CreateLink(DesktopJumpListEntry entry, string executablePath, string iconPath)
    {
        var link = Create<IShellLinkW>(CLSID_ShellLink, IID_IShellLinkW);
        if (link is null) return null;
        link.SetPath(executablePath);
        link.SetArguments('"' + entry.Path + '"');
        link.SetDescription(entry.Path.Length <= 259 ? entry.Path : entry.Title);
        link.SetIconLocation(iconPath, 0);
        // Without a title every row would read "Nendo.Desktop", because every row
        // targets the same executable.
        if (link is not DesktopShellProperties.IPropertyStore store) return link;
        try
        {
            DesktopShellProperties.SetString(store, DesktopShellProperties.Title, entry.Title);
        }
        catch (Exception exception) when (exception is COMException or InvalidCastException or OutOfMemoryException)
        {
            // An untitled row would read as the executable's name. Better a row the
            // person can still click than no menu at all.
        }
        return link;
    }

    private static T? Create<T>(Guid classId, Guid interfaceId) where T : class
    {
        var hr = CoCreateInstance(classId, IntPtr.Zero, CLSCTX_INPROC_SERVER, interfaceId, out var instance);
        return hr == 0 ? instance as T : null;
    }

    [DllImport("ole32.dll")]
    private static extern int CoCreateInstance(
        in Guid rclsid, IntPtr pUnkOuter, uint dwClsContext, in Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out object ppv);

    [ComImport, Guid("6332debf-87b5-4670-90c0-5e57b408a49e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ICustomDestinationList
    {
        void SetAppID([MarshalAs(UnmanagedType.LPWStr)] string pszAppID);
        void BeginList(out uint cMinSlots, in Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
        void AppendCategory([MarshalAs(UnmanagedType.LPWStr)] string pszCategory, IObjectArray poa);
        void AppendKnownCategory(int category);
        void AddUserTasks(IObjectArray poa);
        void CommitList();
        void GetRemovedDestinations(in Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
        void DeleteList([MarshalAs(UnmanagedType.LPWStr)] string pszAppID);
        void AbortList();
    }

    [ComImport, Guid("92CA9DCD-5622-4bba-A805-5E9F541BD8C9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IObjectArray
    {
        void GetCount(out uint pcObjects);
        void GetAt(uint uiIndex, in Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
    }

    [ComImport, Guid("5632b1a4-e38a-400a-928a-d4cd63230295"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IObjectCollection
    {
        void GetCount(out uint pcObjects);
        void GetAt(uint uiIndex, in Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
        void AddObject([MarshalAs(UnmanagedType.Interface)] object pvObject);
        void AddFromArray(IObjectArray poaSource);
        void RemoveObjectAt(uint uiIndex);
        void Clear();
    }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPArray)] char[] pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPArray)] char[] pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPArray)] char[] pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPArray)] char[] pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out ushort pwHotkey);
        void SetHotkey(ushort wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPArray)] char[] pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

}
