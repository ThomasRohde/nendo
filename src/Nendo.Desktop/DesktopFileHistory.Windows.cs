namespace Nendo.Session;

internal sealed partial class DesktopFileHistory
{
    private static partial bool HeldByAnotherWindow(string path) => DesktopWindowHandoff.OwnerOf(path) is not null;
}
