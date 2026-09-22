using System.Security.AccessControl;
using System.Security.Principal;

namespace Nendo.LocalMcp;

/// <summary>
/// Restricts the discovery directory and entry to the owning Windows account. The entry carries no
/// credential; the DACL keeps another account from planting or tampering with an advertisement.
/// </summary>
internal static class NendoProtectedFiles
{
    internal static void SecureDirectory(string path)
    {
        Directory.CreateDirectory(path);
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var identity in AllowedIdentities())
        {
            security.AddAccessRule(new FileSystemAccessRule(
                identity,
                FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                AccessControlType.Allow));
        }
        new DirectoryInfo(path).SetAccessControl(security);
    }

    internal static void SecureFile(string path)
    {
        var security = new FileSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var identity in AllowedIdentities())
        {
            security.AddAccessRule(new FileSystemAccessRule(
                identity,
                FileSystemRights.FullControl,
                AccessControlType.Allow));
        }
        new FileInfo(path).SetAccessControl(security);
    }

    internal static IReadOnlyList<SecurityIdentifier> AllowedIdentities()
    {
        using var identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query);
        return
        [
            identity.User ?? throw new InvalidOperationException(
                "The current Windows user identity is unavailable."),
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
        ];
    }
}
