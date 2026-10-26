namespace Nendo.Session;

internal sealed partial class DesktopSessionController
{
    /// <summary>The Windows host answers the media origin itself (ExtensionAssetServer), over https.</summary>
    private static partial string MediaScheme() => "https://";
}
