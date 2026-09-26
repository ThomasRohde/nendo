namespace Nendo.Engine.Tests;

[TestClass]
public sealed class ObservedFileTests
{
    /// <summary>
    /// The shape of the gate failure on 2026-09-26: another handle with write access is open on
    /// the file, as a scanner's or a dying child's may be for a moment. File.ReadAllBytes asks
    /// for FileShare.Read and is refused; an observation that shares everything is not.
    /// </summary>
    [TestMethod]
    public void AnObservationReadsAFileAnotherHandleStillHasOpenForWriting()
    {
        var path = Path.Combine(Path.GetTempPath(), "nendo-observed-" + Guid.NewGuid().ToString("N") + ".bin");
        File.WriteAllBytes(path, [1, 2, 3]);
        try
        {
            using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete))
            {
                Assert.ThrowsExactly<IOException>(() => File.ReadAllBytes(path), "The plain read was expected to be refused, as it was in the gate.");
                CollectionAssert.AreEqual(new byte[] { 1, 2, 3 }, ObservedFile.ReadAllBytes(path));
            }
        }
        finally { File.Delete(path); }
    }
}
