using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

// The parent process speaks UTF-8 JSON regardless of the Windows console page.
Console.InputEncoding = new UTF8Encoding(false);
Console.OutputEncoding = new UTF8Encoding(false);
var jsonOptions = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
};
try
{
    if (args.Contains("--persistent") || args.Contains("--server"))
    {
        var cache = new ParserCache();
        while (await Console.In.ReadLineAsync() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            var request = JsonSerializer.Deserialize<AnalyzerRequest>(line, jsonOptions)
                ?? throw new InvalidDataException("Request is required.");
            await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new Analyzer(request, cache).Run(), jsonOptions));
            await Console.Out.FlushAsync();
        }
    }
    else
    {
        var input = await Console.In.ReadToEndAsync();
        var request = JsonSerializer.Deserialize<AnalyzerRequest>(input, jsonOptions)
            ?? throw new InvalidDataException("Request is required.");
        var result = new Analyzer(request, new ParserCache()).Run();
        await Console.Out.WriteAsync(JsonSerializer.Serialize(result, jsonOptions));
    }
}
catch (Exception error)
{
    // Indexed source and request bodies are never logged.
    await Console.Error.WriteLineAsync($"C# analyzer failed: {error.GetType().Name}");
    if (Environment.GetEnvironmentVariable("EXPLORER_ANALYZER_DEBUG") == "1")
        await Console.Error.WriteLineAsync(error.StackTrace);
    Environment.ExitCode = 1;
}

sealed record SourceFile(string Path, string Content, string Hash);
sealed record AnalyzerRequest(string ScopeId, SourceFile[] Files, string[]? References,
    string[]? Defines, string? AssemblyName);
sealed class ArchitectureNode
{
    public required string Id { get; init; }
    public required string Kind { get; init; }
    public required string Label { get; init; }
    public required string QualifiedName { get; init; }
    public string Language { get; init; } = "csharp";
    public string? ParentId { get; set; }
    public string? ModuleId { get; init; }
    public string? FilePath { get; set; }
    public string? Signature { get; init; }
    public string? Summary { get; init; }
    public List<string> EvidenceIds { get; init; } = [];
}
sealed class ArchitectureEdge
{
    public required string Id { get; init; }
    public required string Source { get; init; }
    public required string Target { get; init; }
    public required string Kind { get; init; }
    public string Confidence { get; init; } = "static-confirmed";
    public List<string> EvidenceIds { get; init; } = [];
    public required string Rule { get; init; }
    public string? Dispatch { get; init; }
    public string? Condition { get; init; }
    public string[]? Limitations { get; init; }
}
sealed record Evidence(string Id, string FilePath, int StartLine, int StartColumn, int EndLine,
    int EndColumn, string FileHash, string Rule, string Excerpt);
sealed record AnalysisDiagnostic(string Id, string Severity, string Code, string Message,
    string? FilePath = null, int? Line = null);
sealed record AnalyzerResult(ArchitectureNode[] Nodes, ArchitectureEdge[] Edges,
    Evidence[] Evidence, AnalysisDiagnostic[] Diagnostics);

sealed class ParserCache
{
    public string? ScopeId;
    public string? ParseFingerprint;
    public string? ReferenceFingerprint;
    public CSharpCompilation? Compilation;
    public Dictionary<string, (string Hash, string Content, SyntaxTree Tree)> Trees = [];
}

sealed class Analyzer(AnalyzerRequest request, ParserCache cache)
{
    readonly Dictionary<string, ArchitectureNode> nodes = [];
    readonly Dictionary<string, ArchitectureEdge> edges = [];
    readonly Dictionary<string, Evidence> evidence = [];
    readonly List<AnalysisDiagnostic> diagnostics = [];
    readonly Dictionary<SyntaxTree, SourceFile> sources = [];
    readonly Dictionary<SyntaxTree, SemanticModel> models = [];
    readonly Dictionary<SyntaxNode, string> declaredNodes = [];
    readonly Dictionary<(SyntaxTree Tree, int Start), string> anonymousIds = [];
    readonly Dictionary<SyntaxTree, int> unresolvedCalls = [];
    CSharpCompilation compilation = null!;

    string Id(string category, string key) => category + ":" + Convert.ToHexString(
        SHA256.HashData(Encoding.UTF8.GetBytes($"{request.ScopeId}|{category}|{key}")))[..24].ToLowerInvariant();

    void Diagnostic(string code, string message, string severity = "warning", SyntaxNode? syntax = null)
    {
        var path = syntax?.SyntaxTree.FilePath;
        // Inactive preprocessor regions can make the root's full location span
        // unsuitable for a point diagnostic. Only the bounded start is needed.
        int? line = syntax is null ? null : syntax.SyntaxTree.GetText().Lines.GetLineFromPosition(
            Math.Clamp(syntax.SpanStart, 0, syntax.SyntaxTree.GetText().Length)).LineNumber + 1;
        diagnostics.Add(new(Id("diagnostic", $"{code}|{path}|{line}|{message}"), severity, code, message, path, line));
    }

    string EvidenceFor(SyntaxNode syntax, string rule)
    {
        var source = sources[syntax.SyntaxTree];
        var span = syntax.GetLocation().GetLineSpan();
        var start = span.StartLinePosition;
        var end = span.EndLinePosition;
        var id = Id("evidence", $"{source.Path}|{source.Hash}|{start.Line+1}:{start.Character+1}-{end.Line+1}:{end.Character+1}|{rule}");
        evidence.TryAdd(id, new(id, source.Path, start.Line+1, start.Character+1, end.Line+1,
            end.Character+1, source.Hash, rule, syntax.ToString()[..Math.Min(syntax.ToString().Length, 1200)]));
        return id;
    }

    static ISymbol Canonical(ISymbol symbol)
    {
        if (symbol is IMethodSymbol method)
        {
            method = method.ReducedFrom ?? method;
            method = method.PartialDefinitionPart ?? method;
            return method.OriginalDefinition;
        }
        return symbol.OriginalDefinition;
    }

    static string Kind(ISymbol symbol) => symbol switch
    {
        INamedTypeSymbol { TypeKind: TypeKind.Interface } => "interface",
        INamedTypeSymbol { TypeKind: TypeKind.Struct } => "struct",
        INamedTypeSymbol { TypeKind: TypeKind.Enum } => "enum",
        INamedTypeSymbol => "class",
        IMethodSymbol { MethodKind: MethodKind.LocalFunction or MethodKind.AnonymousFunction } => "function",
        IMethodSymbol => "method",
        IFieldSymbol => "field",
        IPropertySymbol => "property",
        IEventSymbol => "event",
        IParameterSymbol => "parameter",
        _ => "data"
    };

    static string Label(ISymbol symbol)
    {
        if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor or MethodKind.StaticConstructor })
            return (symbol.ContainingType?.IsAnonymousType == true ? "匿名类型" : symbol.ContainingType?.Name ?? "构造器") + "()";
        if (!string.IsNullOrWhiteSpace(symbol.Name)) return symbol.Name;
        if (symbol is INamedTypeSymbol { IsAnonymousType: true }) return "匿名类型";
        if (symbol is IMethodSymbol { MethodKind: MethodKind.AnonymousFunction }) return "λ 回调";
        var display = symbol.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
        return string.IsNullOrWhiteSpace(display) ? "未命名符号" : display;
    }

    string SymbolKey(ISymbol original)
    {
        var symbol = Canonical(original);
        if (symbol is IMethodSymbol { MethodKind: MethodKind.AnonymousFunction })
        {
            var syntax = symbol.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
            if (syntax is not null && anonymousIds.TryGetValue((syntax.SyntaxTree, syntax.SpanStart), out var lambdaId))
                return "csharp|anonymous|" + lambdaId;
        }
        var identity = symbol.GetDocumentationCommentId();
        if (identity is null && symbol is IParameterSymbol parameter)
            identity = SymbolKey(parameter.ContainingSymbol) + "|parameter|" + parameter.Ordinal;
        if (identity is null && symbol is IMethodSymbol { MethodKind: MethodKind.LocalFunction } local)
            identity = SymbolKey(local.ContainingSymbol) + "|local|" + local.Name + "|" +
                string.Join(",", local.Parameters.Select(p => p.RefKind + ":" + p.Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)));
        identity ??= symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        var assembly = symbol.ContainingAssembly?.Identity.Name ?? request.AssemblyName ?? "source";
        return $"csharp|{assembly}|{symbol.Kind}|{identity}";
    }

    string EnsureSymbol(ISymbol original, SyntaxNode? declaration = null)
    {
        var symbol = Canonical(original);
        if (symbol is IMethodSymbol { MethodKind: MethodKind.AnonymousFunction })
        {
            var syntax = symbol.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
            if (syntax is not null && anonymousIds.TryGetValue((syntax.SyntaxTree, syntax.SpanStart), out var lambdaId))
                return lambdaId;
        }
        var id = Id("symbol", SymbolKey(symbol));
        if (!nodes.TryGetValue(id, out var node))
        {
            var syntaxRef = symbol.DeclaringSyntaxReferences.FirstOrDefault(r => sources.ContainsKey(r.SyntaxTree));
            var ownSyntax = declaration ?? syntaxRef?.GetSyntax();
            string? parent = null;
            if (symbol.ContainingSymbol is INamedTypeSymbol or IMethodSymbol or IPropertySymbol or IEventSymbol)
                parent = EnsureSymbol(symbol.ContainingSymbol);
            else if (ownSyntax is not null)
                parent = Id("file", sources[ownSyntax.SyntaxTree].Path);
            node = new ArchitectureNode
            {
                Id = id, Kind = Kind(symbol), Label = Label(symbol),
                QualifiedName = symbol.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat) is { Length: > 0 } qualified ? qualified : Label(symbol),
                Signature = symbol.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
                ParentId = parent, FilePath = ownSyntax is null ? null : sources[ownSyntax.SyntaxTree].Path
            };
            nodes.Add(id, node);
        }
        if (declaration is not null)
        {
            var eid = EvidenceFor(declaration, "csharp.declaration");
            if (!node.EvidenceIds.Contains(eid)) node.EvidenceIds.Add(eid);
            node.FilePath ??= sources[declaration.SyntaxTree].Path;
        }
        return id;
    }

    string? Conditions(SyntaxNode syntax)
    {
        var conditions = new List<string>();
        var child = syntax;
        foreach (var parent in syntax.Ancestors())
        {
            if (parent is BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax) break;
            if (parent is IfStatementSyntax branch)
                conditions.Add(branch.Else is not null && branch.Else.Span.Contains(child.Span)
                    ? $"!({branch.Condition})" : branch.Condition.ToString());
            if (parent is WhileStatementSyntax loop) conditions.Add(loop.Condition.ToString());
            if (parent is ConditionalExpressionSyntax conditional)
                conditions.Add(conditional.WhenFalse.Span.Contains(child.Span)
                    ? $"!({conditional.Condition})" : conditional.Condition.ToString());
            child = parent;
        }
        conditions.Reverse();
        var result = string.Join(" && ", conditions);
        return result.Length == 0 ? null : result[..Math.Min(500, result.Length)];
    }

    void Edge(string source, string target, string kind, SyntaxNode syntax, string rule,
        string? dispatch = null, string[]? limitations = null, string confidence = "static-confirmed")
    {
        var eid = EvidenceFor(syntax, rule);
        var condition = Conditions(syntax);
        var id = Id("edge", $"{source}|{target}|{kind}|{rule}|{condition}");
        if (!edges.TryGetValue(id, out var edge))
        {
            edge = new ArchitectureEdge { Id = id, Source = source, Target = target, Kind = kind,
                Rule = rule, Dispatch = dispatch, Limitations = limitations, Condition = condition, Confidence = confidence };
            edges.Add(id, edge);
        }
        if (!edge.EvidenceIds.Contains(eid)) edge.EvidenceIds.Add(eid);
    }

    string Owner(SyntaxNode syntax, SemanticModel model)
    {
        foreach (var ancestor in syntax.AncestorsAndSelf())
            if (declaredNodes.TryGetValue(ancestor, out var id)) return id;
        var symbol = model.GetEnclosingSymbol(syntax.SpanStart);
        if (symbol is IMethodSymbol or INamedTypeSymbol or IFieldSymbol or IPropertySymbol or IEventSymbol)
            return EnsureSymbol(symbol);
        return Id("file", sources[syntax.SyntaxTree].Path);
    }

    List<MetadataReference> References()
    {
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var explicitReferences = request.References ?? [];
        // Explicit framework reference sets must not be mixed with the host
        // runtime's core library. Unity and netstandard profiles are distinct.
        var suppliedCore = explicitReferences.Any(p => Path.GetFileName(p) is "mscorlib.dll" or "System.Private.CoreLib.dll");
        if (!suppliedCore)
        {
            var platform = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? "").Split(Path.PathSeparator);
            foreach (var p in platform)
                if (!string.IsNullOrEmpty(p) && !Path.GetFileName(p).StartsWith("Microsoft.CodeAnalysis", StringComparison.Ordinal)) paths.Add(p);
        }
        foreach (var path in explicitReferences) paths.Add(path);
        var result = new List<MetadataReference>();
        foreach (var path in paths)
        {
            try { result.Add(MetadataReference.CreateFromFile(path)); }
            catch (Exception error) when (error is IOException or BadImageFormatException or UnauthorizedAccessException or ArgumentException)
            { Diagnostic("CS_REFERENCE_UNAVAILABLE", $"程序集元数据不可读取：{Path.GetFileName(path)} ({error.GetType().Name})"); }
        }
        return result;
    }

    public AnalyzerResult Run()
    {
        var parsed = 0;
        var reused = 0;
        var removed = 0;
        var parseFingerprint = string.Join("|", (request.Defines ?? []).Order());
        if (cache.ScopeId != request.ScopeId || cache.ParseFingerprint != parseFingerprint)
        {
            cache.Trees.Clear();
            cache.Compilation = null;
            cache.ReferenceFingerprint = null;
            cache.ScopeId = request.ScopeId;
            cache.ParseFingerprint = parseFingerprint;
        }
        var wanted = request.Files.Select(f => f.Path.Replace('\\', '/')).ToHashSet();
        foreach (var path in cache.Trees.Keys.Where(k => !wanted.Contains(k)).ToArray())
        { cache.Trees.Remove(path); removed++; }
        foreach (var input in request.Files)
        {
            var file = input with { Path = input.Path.Replace('\\', '/') };
            SyntaxTree tree;
            if (cache.Trees.TryGetValue(file.Path, out var previous) && previous.Hash == file.Hash && previous.Content == file.Content)
            { tree = previous.Tree; reused++; }
            else
            {
                tree = CSharpSyntaxTree.ParseText(file.Content,
                    new CSharpParseOptions(LanguageVersion.CSharp13, preprocessorSymbols: request.Defines ?? []), file.Path);
                cache.Trees[file.Path] = (file.Hash, file.Content, tree);
                parsed++;
            }
            sources[tree] = file;
            var id = Id("file", file.Path);
            nodes[id] = new ArchitectureNode { Id = id, Kind = "file", Label = Path.GetFileName(file.Path),
                QualifiedName = file.Path, FilePath = file.Path };
        }
        var referenceFingerprint = string.Join("|", (request.References ?? []).Order().Select(p =>
        {
            try { var info = new FileInfo(p); return $"{p}:{info.Length}:{info.LastWriteTimeUtc.Ticks}"; }
            catch (Exception) { return p + ":unavailable"; }
        }));
        if (cache.Compilation is null || cache.ReferenceFingerprint != referenceFingerprint)
            compilation = CSharpCompilation.Create(request.AssemblyName ?? "ArchitectureExplorer.Target",
                sources.Keys, References(), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                    allowUnsafe: true, nullableContextOptions: NullableContextOptions.Enable));
        else
        {
            // Immutable compilation replacement retains unchanged syntax trees
            // and framework metadata. Rebind semantics conservatively because
            // the request currently merges source assemblies into one context.
            compilation = cache.Compilation;
            compilation = compilation.RemoveSyntaxTrees(compilation.SyntaxTrees.Except(sources.Keys));
            compilation = compilation.AddSyntaxTrees(sources.Keys.Except(compilation.SyntaxTrees));
            if (compilation.AssemblyName != (request.AssemblyName ?? "ArchitectureExplorer.Target"))
                compilation = compilation.WithAssemblyName(request.AssemblyName ?? "ArchitectureExplorer.Target");
        }
        cache.Compilation = compilation;
        cache.ReferenceFingerprint = referenceFingerprint;
        foreach (var tree in sources.Keys)
        {
            var model = compilation.GetSemanticModel(tree, ignoreAccessibility: false);
            models[tree] = model;
            var lambdaCounts = new Dictionary<string, int>();
            foreach (var syntax in tree.GetRoot().DescendantNodes())
            {
                // Preorder allocation precedes lambda parameter declarations.
                // All symbol references then share this exact lambda identity.
                if (syntax is AnonymousFunctionExpressionSyntax lambda)
                {
                    var owner = Owner(lambda.Parent ?? lambda, model);
                    var ordinal = lambdaCounts.GetValueOrDefault(owner);
                    lambdaCounts[owner] = ordinal + 1;
                    var id = Id("symbol", $"csharp|{owner}|lambda|{ordinal}");
                    nodes[id] = new ArchitectureNode { Id = id, Kind = "function", Label = "λ 回调",
                        QualifiedName = nodes[owner].QualifiedName + $".lambda[{ordinal}]", ParentId = owner,
                        FilePath = sources[tree].Path, EvidenceIds = [EvidenceFor(lambda, "csharp.lambda-declaration")] };
                    declaredNodes[lambda] = id;
                    anonymousIds[(tree, lambda.SpanStart)] = id;
                    Edge(owner, id, "contains", lambda, "csharp.lexical-containment");
                    continue;
                }
                if (syntax is BaseTypeDeclarationSyntax or DelegateDeclarationSyntax or BaseMethodDeclarationSyntax
                    or LocalFunctionStatementSyntax or PropertyDeclarationSyntax or IndexerDeclarationSyntax
                    or EventDeclarationSyntax or AccessorDeclarationSyntax or ParameterSyntax
                    || syntax is VariableDeclaratorSyntax { Parent.Parent: BaseFieldDeclarationSyntax })
                {
                    var symbol = model.GetDeclaredSymbol(syntax);
                    if (symbol is null) continue;
                    var id = EnsureSymbol(symbol, syntax);
                    declaredNodes[syntax] = id;
                    var parent = nodes[id].ParentId;
                    if (parent is not null) Edge(parent, id, "contains", syntax, "csharp.lexical-containment");
                    // A partial type can be physically declared in multiple
                    // files while retaining one semantic identity.
                    if (symbol is INamedTypeSymbol)
                        Edge(Id("file", sources[tree].Path), id, "contains", syntax, "csharp.file-declaration");
                }
            }
        }
        foreach (var (tree, model) in models)
        {
            foreach (var syntax in tree.GetRoot().DescendantNodes()) AnalyzeSyntax(syntax, model);
        }
        var syntaxIssues = sources.Keys.SelectMany(tree => tree.GetDiagnostics())
            .Where(d => d.Severity == DiagnosticSeverity.Error).ToArray();
        var syntaxKeys = syntaxIssues.Select(d => (d.Id, d.Location.SourceTree, d.Location.SourceSpan)).ToHashSet();
        var semanticIssues = compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error &&
            !syntaxKeys.Contains((d.Id, d.Location.SourceTree, d.Location.SourceSpan))).ToArray();
        var reported = syntaxIssues.Take(80).Select(d => (Diagnostic: d, IsSyntax: true))
            .Concat(semanticIssues.Take(80).Select(d => (Diagnostic: d, IsSyntax: false)));
        foreach (var item in reported)
        {
            var diagnostic = item.Diagnostic;
            var location = diagnostic.Location;
            var span = location.GetLineSpan();
            var id = Id("diagnostic", $"{diagnostic.Id}|{span.Path}|{span.StartLinePosition}|{diagnostic.GetMessage()}");
            diagnostics.Add(new(id, item.IsSyntax ? "error" : "warning", (item.IsSyntax ? "CS_SYNTAX_" : "CS_") + diagnostic.Id,
                (item.IsSyntax ? "源码语法错误：" : "语义上下文不完整或源码存在编译问题：") + diagnostic.GetMessage(),
                location.IsInSource ? span.Path : null, location.IsInSource ? span.StartLinePosition.Line + 1 : null));
        }
        if (syntaxIssues.Length > 80) Diagnostic("CS_SYNTAX_DIAGNOSTICS_TRUNCATED", $"共 {syntaxIssues.Length} 条语法错误，仅返回前 80 条。", "error");
        if (semanticIssues.Length > 80) Diagnostic("CS_DIAGNOSTICS_TRUNCATED", $"共 {semanticIssues.Length} 条语义上下文诊断，仅返回前 80 条。");
        foreach (var (tree, count) in unresolvedCalls)
            Diagnostic("CS_UNRESOLVED_CALLS", $"{count} 处调用目标无法静态确认；未按名称猜测调用边。", syntax: tree.GetRoot());
        Diagnostic("CS_STATIC_SCOPE", "结果是静态声明、绑定与读写证据；虚调用实际实现、反射、动态分发、Unity生命周期顺序和运行时数据流未验证。", "info");
        Diagnostic("incremental-parser", $"parsed={parsed}; reused={reused}; removed={removed}; C#未变文件复用SyntaxTree，更新不可变Compilation并保守重新绑定语义。", "info");
        return new(nodes.Values.ToArray(), edges.Values.ToArray(), evidence.Values.ToArray(), diagnostics.ToArray());
    }

    void AnalyzeSyntax(SyntaxNode syntax, SemanticModel model)
    {
        if (syntax is BaseTypeSyntax baseType)
        {
            var type = model.GetTypeInfo(baseType.Type).Type;
            if (type is not null && type.TypeKind != TypeKind.Error)
                Edge(Owner(syntax, model), EnsureSymbol(type), type.TypeKind == TypeKind.Interface &&
                    syntax.Ancestors().OfType<InterfaceDeclarationSyntax>().FirstOrDefault() is null ? "implements" : "inherits",
                    syntax, "csharp.base-type");
        }
        if (syntax is TypeSyntax typeSyntax && IsTypeContext(typeSyntax))
        {
            var type = model.GetTypeInfo(typeSyntax).Type;
            while (type is IArrayTypeSymbol array) type = array.ElementType;
            if (type is INamedTypeSymbol { TypeKind: not TypeKind.Error } named)
            {
                var owners = syntax.Parent is VariableDeclarationSyntax { Parent: BaseFieldDeclarationSyntax } variable
                    ? variable.Variables.Select(v => model.GetDeclaredSymbol(v)).Where(s => s is not null).Select(s => EnsureSymbol(s!)).ToArray()
                    : [Owner(syntax, model)];
                foreach (var owner in owners) Edge(owner, EnsureSymbol(named), "references", syntax, "csharp.bound-type-reference");
            }
        }
        if (syntax is InvocationExpressionSyntax)
        {
            var operation = model.GetOperation(syntax);
            if (operation is IInvocationOperation call && call.TargetMethod.ContainingType?.TypeKind != TypeKind.Error)
            {
                if (call.TargetMethod.MethodKind == MethodKind.DelegateInvoke)
                {
                    var eventReference = call.Instance as IEventReferenceOperation;
                    if (eventReference is null && call.Instance is IConditionalAccessInstanceOperation)
                    {
                        var conditional = syntax.Ancestors().OfType<ConditionalAccessExpressionSyntax>().FirstOrDefault();
                        if (conditional is not null) eventReference = model.GetOperation(conditional.Expression) as IEventReferenceOperation;
                    }
                    if (eventReference is not null)
                        Edge(Owner(syntax, model), EnsureSymbol(eventReference.Event), "publishes", syntax, "csharp.event-invocation",
                            "event", ["发布点已确认；运行时订阅者集合和调用顺序未验证。"]);
                    else
                    {
                        var target = model.GetSymbolInfo(((InvocationExpressionSyntax)syntax).Expression).Symbol as IEventSymbol;
                        if (target is not null) Edge(Owner(syntax, model), EnsureSymbol(target), "publishes", syntax, "csharp.event-invocation");
                        else unresolvedCalls[syntax.SyntaxTree] = unresolvedCalls.GetValueOrDefault(syntax.SyntaxTree) + 1;
                    }
                }
                else
                {
                    var method = call.TargetMethod;
                    var virtualDispatch = call.IsVirtual || method.ContainingType?.TypeKind == TypeKind.Interface;
                    Edge(Owner(syntax, model), EnsureSymbol(method), "calls", syntax, "csharp.bound-invocation",
                        virtualDispatch ? "virtual-declaration" : "direct",
                        virtualDispatch ? ["静态声明目标已确认；运行时覆写/接口实现未确认。"] : ["源码调用点已绑定；不证明运行时执行。"]);
                }
            }
            else if (operation is not INameOfOperation)
                unresolvedCalls[syntax.SyntaxTree] = unresolvedCalls.GetValueOrDefault(syntax.SyntaxTree) + 1;
        }
        if (syntax is ObjectCreationExpressionSyntax or ImplicitObjectCreationExpressionSyntax
            && model.GetOperation(syntax) is IObjectCreationOperation { Constructor: not null } creation)
            Edge(Owner(syntax, model), EnsureSymbol(creation.Constructor), "calls", syntax, "csharp.constructor", "direct");
        if (syntax is AssignmentExpressionSyntax assignment && model.GetOperation(syntax) is IEventAssignmentOperation eventAssignment)
        {
            var eventOperation = eventAssignment.EventReference as IEventReferenceOperation;
            if (eventOperation is not null)
            {
                var owner = Owner(syntax, model);
                var eventId = EnsureSymbol(eventOperation.Event);
                Edge(owner, eventId, eventAssignment.Adds ? "subscribes" : "unsubscribes", syntax, "csharp.event-assignment",
                    limitations: ["绑定语法已确认；实际生命周期/条件是否执行未验证。"]);
                var handler = eventAssignment.HandlerValue;
                while (handler is IDelegateCreationOperation delegateCreation) handler = delegateCreation.Target;
                string? handlerId = handler is IMethodReferenceOperation reference ? EnsureSymbol(reference.Method)
                    : handler is IAnonymousFunctionOperation anonymous && declaredNodes.TryGetValue(anonymous.Syntax, out var lambda) ? lambda : null;
                if (handlerId is not null)
                    Edge(eventId, handlerId, "references", assignment.Right, "csharp.event-handler-binding",
                        limitations: ["明确处理器表达式；不表示任何发布都必然调用此处理器。"]);
            }
        }
        if (syntax is EqualsValueClauseSyntax initializer)
        {
            var declaration = initializer.Parent;
            ISymbol? target = declaration is VariableDeclaratorSyntax variable ? model.GetDeclaredSymbol(variable)
                : declaration is PropertyDeclarationSyntax property ? model.GetDeclaredSymbol(property) : null;
            if (target is IFieldSymbol or IPropertySymbol)
            {
                var targetId = EnsureSymbol(target);
                var owner = target.ContainingType is null ? targetId : EnsureSymbol(target.ContainingType);
                Edge(owner, targetId, "initializes", initializer, "csharp.declaration-initializer");
            }
        }
        if (syntax is IdentifierNameSyntax or MemberAccessExpressionSyntax or ElementAccessExpressionSyntax
            or MemberBindingExpressionSyntax)
        {
            var operation = model.GetOperation(syntax);
            ISymbol? symbol = operation switch
            {
                IFieldReferenceOperation field => field.Field,
                IPropertyReferenceOperation property => property.Property,
                _ => null
            };
            if (symbol is null || symbol.ContainingType?.TypeKind == TypeKind.Error) return;
            // Roslyn may return the same field operation for an identifier and
            // its enclosing access. Keep the operation's canonical syntax only.
            if (operation!.Syntax != syntax) return;
            var target = EnsureSymbol(symbol);
            var owner = Owner(syntax, model);
            var parent = operation.Parent;
            while (parent is IConversionOperation or IParenthesizedOperation) parent = parent.Parent;
            if (parent is INameOfOperation)
            {
                Edge(owner, target, "references", syntax, "csharp.nameof-reference");
                return;
            }
            while (parent is ITupleOperation) parent = parent.Parent;
            bool write = parent switch
            {
                IAssignmentOperation a => IsStorageTarget(a.Target, operation),
                IIncrementOrDecrementOperation i => IsStorageTarget(i.Target, operation),
                IArgumentOperation a => a.Parameter?.RefKind is RefKind.Ref or RefKind.Out,
                _ => false
            };
            bool read = parent switch
            {
                ISimpleAssignmentOperation a when IsStorageTarget(a.Target, operation) => false,
                IArgumentOperation a when a.Parameter?.RefKind == RefKind.Out => false,
                _ => true
            };
            if (read) Edge(owner, target, "reads", syntax, "csharp.bound-read",
                limitations: symbol is IPropertySymbol ? ["属性读取可能调用getter；副作用未建模。"] : null);
            if (write) Edge(owner, target, "writes", syntax, "csharp.bound-write",
                limitations: parent is IArgumentOperation ? ["ref/out表示可能被调用方法写入，未证明发生修改。"] : null,
                confidence: parent is IArgumentOperation ? "inferred" : "static-confirmed");
        }
    }

    static bool IsTypeContext(TypeSyntax syntax) => syntax.Parent switch
    {
        VariableDeclarationSyntax declaration => declaration.Type == syntax,
        ParameterSyntax parameter => parameter.Type == syntax,
        MethodDeclarationSyntax method => method.ReturnType == syntax,
        PropertyDeclarationSyntax property => property.Type == syntax,
        EventDeclarationSyntax evt => evt.Type == syntax,
        IndexerDeclarationSyntax indexer => indexer.Type == syntax,
        DelegateDeclarationSyntax declaration => declaration.ReturnType == syntax,
        ObjectCreationExpressionSyntax creation => creation.Type == syntax,
        CastExpressionSyntax cast => cast.Type == syntax,
        TypeArgumentListSyntax => true,
        TypeOfExpressionSyntax => true,
        DefaultExpressionSyntax => true,
        _ => false
    };

    static bool IsStorageTarget(IOperation target, IOperation reference)
    {
        if (ReferenceEquals(target, reference)) return true;
        // A field used to locate a nested member is read, not written. Tuple
        // assignment targets are the exception: each tuple element is storage.
        if (target is ITupleOperation tuple) return tuple.Elements.Any(e => IsStorageTarget(e, reference));
        if (target is IConversionOperation conversion) return IsStorageTarget(conversion.Operand, reference);
        return false;
    }
}
