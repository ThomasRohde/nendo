using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;

Console.WriteLine("Nendo browser host started.");

public static partial class Host
{
    /// <summary>One JSON request in, one JSON answer out: the shape the Workbench's bridge speaks.</summary>
    [JSExport]
    public static string Invoke(string request)
    {
        using var document = JsonDocument.Parse(request);
        var method = document.RootElement.GetProperty("method").GetString();
        var path = "/work/probe.txt";
        Directory.CreateDirectory("/work");
        File.WriteAllText(path, $"written for {method}");
        return JsonSerializer.Serialize(new
        {
            ok = true,
            method,
            runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
            os = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
            isBrowser = OperatingSystem.IsBrowser(),
            fileRoundTrip = File.ReadAllText(path),
        });
    }
}
