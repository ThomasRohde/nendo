using Nendo.Engine;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class NendoFormatTests
{
    [TestMethod]
    public void VersionOneContractIsExplicit()
    {
        var format = NendoFormat.Describe();

        Assert.AreEqual(".nendo", format.FileExtension);
        Assert.AreEqual("nendo.sqlite.application", format.Identifier);
        Assert.AreEqual(1L, format.Version);
        Assert.AreEqual("1.0.0", format.MinimumHostVersion);
        Assert.AreEqual(0x4E454E44, format.SqliteApplicationId);
    }
}
