# Offline dependency graph

This separately versioned, unsigned package reads the bounded projection approved
by Nendo and suggests record selections. It has no dependencies, downloads or write
operations. Native Open record and Studio navigation belong to the host.

[Authoring a custom view](../../docs/custom-view-authoring.md) is the guide this
package is the worked example for: the manifest, the message contract, the
`extensionGraphSurface` definition and the install/allow/open steps.

Build with `pwsh ./tools/Build-NendoGraphPackage.ps1`. The output is
`artifacts/extensions/org.nendo.dependency-graph-0.1.0.nendoview`; the command prints
its exact SHA-256. ZIP timestamps and manifest ordering are fixed so unchanged
source produces the same pin. The installer does not silently install this package.

In a development build, File → Custom views opens native installation, exact export,
removal and consent review. Author a matching `extensionGraphSurface` through the
canonical UI operations, using the package ID, version and printed digest. Fields
are bound by semantic ID; package installation and definition acceptance do not
grant execution. Choose File → Custom views → Open a custom view after reviewing
permission. The native window keeps Open record, Refresh, Studio, Disable and Close
outside the renderer. Its complete interaction and installed-host journeys remain
part of the unfinished release qualification.

The graph supports pointer pan, wheel/button zoom, keyboard record selection,
visible focus, a text relationship list, both themes and projection replacement.
Labels are text, including strings that resemble markup. Cycles, self-links and
parallel edges are preserved. Text view remains available for dense graphs.

`pwsh ./tools/Review-NendoGraph.ps1` uses pinned Playwright CLI tooling against a
task-owned local server, measures interactions and geometry, and captures both
themes. It is a package presentation check, not an AppContainer network test.
`DesktopExtensionProcessTests.OfflineGraphArchiveCompletesHandshakeInTheProductionHelper`
builds the actual archive and checks startup through the contained production
helper. Native end-to-end graph-window and host-navigation checks remain separate.
