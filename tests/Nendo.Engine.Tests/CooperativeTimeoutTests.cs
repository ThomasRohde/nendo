using System.Reflection;

namespace Nendo.Engine.Tests;

/// <summary>
/// TST-11: a cooperative [Timeout] only cancels a token, and waits for the method to notice. The
/// history-fold test asked for one and had no token to notice, so its ten-minute bound could not
/// stop it: a run took 14:13 and passed. Every such test here carries TestContext and reads its
/// CancellationToken.
/// </summary>
[TestClass]
public sealed class CooperativeTimeoutTests
{
    [TestMethod]
    public void EveryCooperativeTimeoutHasATokenItObserves()
    {
        var cooperative = typeof(CooperativeTimeoutTests).Assembly.GetTypes()
            .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .Where(method => method.GetCustomAttribute<TimeoutAttribute>() is { CooperativeCancellation: true })
            .ToArray();
        Assert.IsNotEmpty(cooperative, "No test asks for a cooperative timeout; retire this check or the pattern it reads.");
        var folder = Path.Combine(TestRepository.Root(), "tests", "Nendo.Engine.Tests");
        foreach (var method in cooperative)
        {
            var type = method.DeclaringType!;
            var context = type.GetProperty("TestContext", BindingFlags.Public | BindingFlags.Instance);
            Assert.IsTrue(context is { CanWrite: true } && context.PropertyType == typeof(TestContext),
                $"{type.Name}.{method.Name} asks for a cooperative timeout, but {type.Name} has no TestContext to carry its token.");
            var source = File.ReadAllText(Path.Combine(folder, type.Name + ".cs"));
            StringAssert.Contains(source, "TestContext.CancellationToken",
                $"{type.Name}.{method.Name} asks for a cooperative timeout and never reads the token it cancels.");
        }
    }
}
