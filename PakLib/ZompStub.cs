// Stub attribute so [Zomp.SyncMethodGenerator.CreateSyncVersion] compiles without the NuGet generator.
// The generator is not needed: we only use async methods, except OpenGbxFile which is in PakSync.cs.
namespace Zomp.SyncMethodGenerator;

[AttributeUsage(AttributeTargets.Method, Inherited = false)]
internal sealed class CreateSyncVersionAttribute : Attribute { }
