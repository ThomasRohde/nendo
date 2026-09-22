using System.Text.Json;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class WorkbenchErrorPrivacyTests
{
    [TestMethod]
    [DataRow("existing", 4)]
    [DataRow("locked", 4)]
    [DataRow("corrupt", 4)]
    [DataRow("existing", 5)]
    [DataRow("locked", 5)]
    [DataRow("corrupt", 5)]
    public async Task NativeFileFailuresPreserveBytesAndReturnUsefulPathFreeErrors(string failure, int version)
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var original = "Private existing content"u8.ToArray();
        await File.WriteAllBytesAsync(workspace.FilePath, original);
        var handler = new WorkbenchProtocolHandler(session,
            () => Task.FromResult<string?>(workspace.FilePath),
            () => Task.FromResult<string?>(workspace.FilePath), _ => { },
            async action => new DesktopFileActionView(action.Action == WorkbenchFileAction.Create
                ? await session.CreateFromSavePickerAsync(workspace.FilePath)
                : await session.OpenAsync(workspace.FilePath), "Completed"));
        var fileSessionId = (await session.GetViewAsync()).FileSessionId;
        WorkbenchResponse response;
        if (failure == "locked")
        {
            using var locked = new FileStream(workspace.FilePath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            response = await handler.HandleAsync(Request(WorkbenchMethods.SessionCreateFile, fileSessionId, version));
        }
        else
        {
            response = await handler.HandleAsync(Request(failure == "corrupt"
                ? WorkbenchMethods.SessionOpenFile : WorkbenchMethods.SessionCreateFile, fileSessionId, version));
        }
        Assert.IsFalse(response.Ok);
        Assert.IsNotNull(response.Error);
        Assert.AreEqual(failure == "corrupt" ? "file-inspection" : "file-io", response.Error.Code, response.Error.Message);
        Assert.IsFalse(string.IsNullOrWhiteSpace(response.Error.Message));
        AssertPrivate(response, Path.GetDirectoryName(workspace.FilePath)!);
        Assert.DoesNotContain("Private existing content", WorkbenchProtocolHandler.Serialize(response));
        CollectionAssert.AreEqual(original, await File.ReadAllBytesAsync(workspace.FilePath));
        Assert.IsFalse((await session.GetViewAsync()).HasFile);
    }

    [TestMethod]
    [DataRow(false, "file-io", 4)]
    [DataRow(true, "file-access", 4)]
    [DataRow(false, "file-io", 5)]
    [DataRow(true, "file-access", 5)]
    public async Task NativeExceptionDetailsAreExcludedFromBridgeErrors(bool accessDenied, string expectedCode, int version)
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        const string sensitiveDetail = "Data Source=C:\\private\\secret.nendo; SELECT * FROM protected; bearer-secret; at Native.Stack";
        Exception failure = accessDenied
            ? new UnauthorizedAccessException(sensitiveDetail)
            : new IOException(sensitiveDetail);
        var handler = new WorkbenchProtocolHandler(session,
            () => Task.FromException<string?>(failure),
            () => Task.FromResult<string?>(null), _ => { },
            _ => Task.FromException<DesktopFileActionView>(failure));

        var response = await handler.HandleAsync(Request(WorkbenchMethods.SessionCreateFile,
            (await session.GetViewAsync()).FileSessionId, version));

        Assert.IsFalse(response.Ok);
        Assert.AreEqual(expectedCode, response.Error!.Code, response.Error.Message);
        AssertPrivate(response, "C:\\private");
        foreach (var secret in new[] { "Data Source", "SELECT", "protected", "bearer-secret", "Native.Stack" })
            Assert.DoesNotContain(secret, WorkbenchProtocolHandler.Serialize(response));
        Assert.Contains(accessDenied ? "accessible" : "file status", response.Error.Message);
        if (!accessDenied)
        {
            Assert.Contains("could not be confirmed", response.Error.Message);
            Assert.Contains("a result may already exist", response.Error.Message);
            Assert.DoesNotContain("choose a new destination", response.Error.Message);
        }
    }

    private static void AssertPrivate(WorkbenchResponse response, string directory)
    {
        Assert.DoesNotContain(directory, response.Error!.Message, StringComparison.OrdinalIgnoreCase);
        var serialized = WorkbenchProtocolHandler.Serialize(response);
        Assert.DoesNotContain(directory.Replace("\\", "\\\\"), serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("stackTrace", serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("connectionString", serialized, StringComparison.OrdinalIgnoreCase);
    }

    private static string Request(string method, string? fileSessionId, int version) => JsonSerializer.Serialize(new
    {
        protocolVersion = version,
        requestId = "privacy-check", method, fileSessionId, payload = new { },
    });
}
