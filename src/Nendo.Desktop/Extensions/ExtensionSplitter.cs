using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Data;
using Microsoft.UI.Xaml.Input;

namespace Nendo.Desktop;

/// <summary>
/// The boundary between the Workbench and a custom view, as something the person can move.
///
/// It is a class of its own for two reasons. The pointer shape lives on
/// <c>ProtectedCursor</c>, which only a subclass may set, and the lane that drives this
/// through UI Automation needs a peer to find it by. Both halves of the split are real
/// child windows drawn over the page, so the strip has a column to itself: an element
/// underneath either of them would never be clicked.
///
/// The visible line is a child rather than this control's own background. A lookless
/// control with nothing in it is arranged to nothing: it reports an empty rectangle to
/// accessibility and there is no pixel to press, while still appearing in the automation
/// tree and still taking focus and arrow keys. That is how a boundary the keyboard could
/// move and the pointer could not reached the owner on 2026-09-21.
/// </summary>
internal sealed partial class ExtensionSplitter : UserControl
{
    /// <summary>Slim enough to read as a seam, wide enough to take hold of at 150% scaling.</summary>
    internal const double Thickness = 8;

    internal ExtensionSplitter()
    {
        Width = Thickness;
        HorizontalAlignment = HorizontalAlignment.Stretch;
        VerticalAlignment = VerticalAlignment.Stretch;
        var line = new Border
        {
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Stretch,
        };
        // Bound rather than copied, so the ThemeResource on this control keeps following
        // Light and Dark. A null brush would also stop the line being hit-testable.
        line.SetBinding(Border.BackgroundProperty, new Binding { Path = new PropertyPath(nameof(Background)), Source = this });
        Content = line;
        // Reachable from the keyboard because the production lane drives it through UI
        // Automation, which cannot perform a pointer drag -- and because a boundary only a
        // mouse can move is a boundary some people cannot move.
        IsTabStop = true;
        UseSystemFocusVisuals = true;
        AutomationProperties.SetAutomationId(this, "extensions.splitter");
        AutomationProperties.SetName(this, "Resize the custom view");
        AutomationProperties.SetHelpText(this, "Left and right arrows move the boundary. Double click restores half the window.");
        ProtectedCursor = InputSystemCursor.Create(InputSystemCursorShape.SizeWestEast);
    }

    /// <summary>Without a peer the name and id above would reach nobody.</summary>
    protected override AutomationPeer OnCreateAutomationPeer() => new FrameworkElementAutomationPeer(this);
}
