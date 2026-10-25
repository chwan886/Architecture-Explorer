#!/usr/bin/env python3
"""Content-only Python indexer. It never imports or executes the indexed program.

Names are bound conservatively. Dictionary locations belong to a declaration and
an expression root, never to a globally shared spelling such as ``hp``.
"""
from __future__ import annotations

import ast
import hashlib
import json
import sys
import symtable
from collections import defaultdict

VERSION = "0.1.0"


def analyze(request, parse_cache=None):
    return Analyzer(request, parse_cache).run()


class Analyzer:
    def __init__(self, request, parse_cache=None):
        self.scope = request["scopeId"]
        self.files = sorted(({**f, "path": f["path"].replace("\\", "/")} for f in request.get("files", [])),
                            key=lambda f: f["path"])
        self.nodes = {}
        self.edges = {}
        self.evidence = {}
        self.diagnostics = []
        self.file_defs = {}
        self.file_bind_counts = {}
        self.module_files = defaultdict(list)
        for f in self.files:
            self.module_files[self.module_name(f["path"])].append(f)
        self.trees = {}
        self.ast_symbols = {}
        self.symbol_syntax = {}
        self.scope_defs = {}
        self.unknown_calls = defaultdict(list)
        self.decorated_symbols = set()
        self.current = None
        self.parse_cache = parse_cache if parse_cache is not None else {}
        self.parsed = self.reused = self.removed = 0

    def sid(self, category, key):
        digest = hashlib.sha256(f"{self.scope}|{category}|{key}".encode()).hexdigest()[:24]
        return f"{category}:{digest}"

    def diagnostic(self, code, message, file=None, line=None, severity="warning"):
        item = {"id": self.sid("diagnostic", f"{code}|{file}|{line}|{message}"),
                "severity": severity, "code": code, "message": message}
        if file:
            item["filePath"] = file
        if line:
            item["line"] = line
        self.diagnostics.append(item)

    def ev(self, node, rule):
        f = self.current
        lines = f["content"].splitlines()
        first = getattr(node, "lineno", 1)
        last = getattr(node, "end_lineno", first)
        col = getattr(node, "col_offset", 0)
        endcol = getattr(node, "end_col_offset", col)

        def utf16_col(line, byte_column):
            # Python AST columns are UTF-8 bytes, the public schema is UTF-16.
            prefix = line.encode("utf-8")[:byte_column].decode("utf-8", errors="ignore")
            return len(prefix.encode("utf-16-le")) // 2 + 1

        start_column = utf16_col(lines[first-1] if first <= len(lines) else "", col)
        end_column = utf16_col(lines[last-1] if last <= len(lines) else "", endcol)
        key = f"{f['path']}|{f['hash']}|{first}:{start_column}-{last}:{end_column}|{rule}"
        eid = self.sid("evidence", key)
        self.evidence[eid] = {"id": eid, "filePath": f["path"], "fileHash": f["hash"],
                              "startLine": first, "startColumn": start_column,
                              "endLine": last, "endColumn": end_column, "rule": rule,
                              "excerpt": (ast.get_source_segment(f["content"], node) or "")[:1200]}
        return eid

    def node(self, kind, key, label, qualified, syntax=None, parent=None, signature=None):
        nid = self.sid("file" if kind == "file" else "symbol", key)
        if nid not in self.nodes:
            value = {"id": nid, "kind": kind, "label": label, "qualifiedName": qualified,
                     "language": "python", "evidenceIds": []}
            if self.current:
                value["filePath"] = self.current["path"]
            if parent:
                value["parentId"] = parent
            if signature:
                value["signature"] = signature
            self.nodes[nid] = value
        if syntax:
            eid = self.ev(syntax, "python.declaration" if kind != "data" else "python.data-location")
            if eid not in self.nodes[nid]["evidenceIds"]:
                self.nodes[nid]["evidenceIds"].append(eid)
            if parent:
                self.edge(parent, nid, "contains", syntax, "python.lexical-containment")
        return nid

    def edge(self, source, target, kind, syntax, rule, confidence="static-confirmed", limitations=None, dispatch=None):
        eid = self.ev(syntax, rule)
        condition = self.condition(syntax)
        key = f"{source}|{target}|{kind}|{rule}|{condition}"
        edge_id = self.sid("edge", key)
        if edge_id not in self.edges:
            item = {"id": edge_id, "source": source, "target": target, "kind": kind,
                    "confidence": confidence, "evidenceIds": [], "rule": rule}
            if limitations:
                item["limitations"] = limitations
            if dispatch:
                item["dispatch"] = dispatch
            if condition:
                item["condition"] = condition
            self.edges[edge_id] = item
        if eid not in self.edges[edge_id]["evidenceIds"]:
            self.edges[edge_id]["evidenceIds"].append(eid)

    def condition(self, node):
        guards = []
        while hasattr(node, "_parent"):
            p = node._parent
            if isinstance(p, (ast.If, ast.While, ast.IfExp)):
                text = ast.get_source_segment(self.current["content"], p.test) or ast.unparse(p.test)
                direct = node
                if isinstance(p, ast.If):
                    negated = direct in p.orelse
                elif isinstance(p, ast.IfExp):
                    negated = direct is p.orelse
                else:
                    negated = False
                guards.append(("not ("+text+")") if negated else text)
            node = p
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                break
        return " && ".join(reversed(guards))[:500] or None

    @staticmethod
    def module_name(path):
        path = path.replace("\\", "/")
        if path.endswith("/__init__.py"):
            path = path[:-12]
        elif path.endswith(".py"):
            path = path[:-3]
        return path.replace("/", ".")

    def collect(self, body, module, parent, qualified):
        definitions = self.scope_defs.setdefault(parent, {})
        for n in body:
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                q = f"{qualified}.{n.name}"
                kind = "class" if isinstance(n, ast.ClassDef) else ("method" if self.nodes[parent]["kind"] == "class" else "function")
                # Python has no overload identity: repeated definitions are one
                # binding and are intentionally diagnosed below.
                signature = ast.unparse(n.args) if hasattr(n, "args") else None
                key = f"python|{module}|{q}"
                if len(self.module_files[module]) > 1:
                    # A module and package can share a qualified spelling, but
                    # their declarations and evidence remain separate facts.
                    key += "|file|" + self.current["path"]
                nid = self.node(kind, key, n.name, q, n, parent, signature)
                self.ast_symbols[id(n)] = nid
                self.symbol_syntax[nid] = n
                if n.decorator_list:
                    self.decorated_symbols.add(nid)
                if n.name in definitions:
                    self.diagnostic("PY_REDEFINED_BINDING", f"{n.name} 存在重复定义，调用绑定未确认。", self.current["path"], n.lineno)
                    definitions[n.name] = None
                else:
                    definitions[n.name] = nid
                if not isinstance(n, ast.ClassDef):
                    # Declare formals before visiting bodies so callers in any
                    # file can reference the same parameter IDs. No target is
                    # imported or executed to obtain its signature.
                    for arg in self.parameters(n):
                        self.parameter(nid, arg)
                self.collect(n.body, module, nid, q)
            else:
                # def/class statements are legal inside if/try/with/loops. They
                # still bind in this lexical scope, not a new block scope.
                pending = list(ast.iter_child_nodes(n))
                while pending:
                    child = pending.pop()
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        self.collect([child], module, parent, qualified)
                    else:
                        pending.extend(ast.iter_child_nodes(child))
        return definitions

    @staticmethod
    def parameters(node):
        args = node.args.posonlyargs + node.args.args + node.args.kwonlyargs
        return args + [x for x in (node.args.vararg, node.args.kwarg) if x]

    def parameter(self, owner, arg):
        return self.node("parameter", f"python|{owner}|parameter|{arg.arg}", arg.arg,
                         self.nodes[owner]["qualifiedName"]+"."+arg.arg, arg, owner)

    def run(self):
        for module, files in self.module_files.items():
            if len(files) > 1:
                paths = ", ".join(f["path"] for f in files)
                self.diagnostic("PY_AMBIGUOUS_MODULE", f"模块 {module} 对应多个授权文件（{paths}）；保留各文件事实，不选择导入目标。")
        wanted = {(self.scope, f["path"].replace("\\", "/")) for f in self.files}
        for key in list(self.parse_cache):
            if key[0] == self.scope and key not in wanted:
                del self.parse_cache[key]
                self.removed += 1
        for f in self.files:
            self.current = f = {**f, "path": f["path"].replace("\\", "/")}
            module = self.module_name(f["path"])
            self.node("file", f["path"], f["path"].split("/")[-1], module)
            try:
                cache_key = (self.scope, f["path"])
                cached = self.parse_cache.get(cache_key)
                if cached and cached[0] == f["hash"] and cached[1] == f["content"]:
                    tree = cached[2]
                    self.reused += 1
                else:
                    tree = ast.parse(f["content"], filename=f["path"])
                    # Exercise the actual language's lexical scope parser too.
                    symtable.symtable(f["content"], f["path"], "exec")
                    self.parse_cache[cache_key] = (f["hash"], f["content"], tree)
                    self.parsed += 1
            except (SyntaxError, ValueError, RecursionError) as error:
                self.diagnostic("PY_PARSE_ERROR", f"Python 语法无法解析：{getattr(error, 'msg', type(error).__name__)}", f["path"], getattr(error, "lineno", 1), "error")
                continue
            for p in ast.walk(tree):
                for child in ast.iter_child_nodes(p):
                    child._parent = p
            self.trees[f["path"]] = tree
            self.file_defs[f["path"]] = self.collect(tree.body, module, self.sid("file", f["path"]), module)
        self.file_bind_counts = {file: Visitor.count_bindings(tree) for file, tree in self.trees.items()}
        for f in self.files:
            tree = self.trees.get(f["path"])
            if tree is not None:
                self.current = f
                Visitor(self, self.module_name(f["path"]), tree).visit(tree)
        for path, calls in self.unknown_calls.items():
            examples = ", ".join(dict.fromkeys(calls))[:350]
            self.diagnostic("PY_DYNAMIC_CALLS", f"{len(calls)} 处调用无法静态确认目标（含外部库、实例方法、回调或重绑定）：{examples}。", path)
        self.diagnostic("PY_STATIC_SCOPE", "Python 结果为词法声明、保守直接调用与静态访问；参数传递仅表示实参表达式与形参绑定，不证明跨函数对象身份、回调执行或运行时数据流。字典键仅在所属函数/根表达式内识别。", severity="info")
        self.diagnostic("incremental-parser", f"parsed={self.parsed}; reused={self.reused}; removed={self.removed}; Python未变文件复用AST，跨文件绑定保守重新分析。", severity="info")
        return {"nodes": list(self.nodes.values()), "edges": list(self.edges.values()),
                "evidence": list(self.evidence.values()), "diagnostics": self.diagnostics}

    def resolve_module(self, name, current, level=0):
        path = current
        current = self.module_name(path)
        package = current.split(".") if path.endswith("/__init__.py") else current.split(".")[:-1]
        if level:
            # A relative import never falls back to an unrelated same-suffix
            # module. ``from ..x`` outside the indexed package is unresolved.
            if level > len(package):
                return None, None
            base = package[:len(package)-level+1]
            resolved = ".".join(base+([name] if name else []))
            if not self.module_file(resolved):
                return None, None
            return resolved, "static-confirmed"
        if not name:
            return None, None
        # Even a spelling matching a project-relative path does not establish
        # Python's runtime sys.path. Prefer no candidate over silently choosing
        # one of several possible import roots.
        matches = [m for m in self.module_files if m == name or m.endswith("."+name)]
        return (matches[0], "inferred") if len(matches) == 1 and self.module_file(matches[0]) else (None, None)

    def module_file(self, module):
        files = self.module_files.get(module, [])
        return files[0] if len(files) == 1 and files[0]["path"] in self.trees else None

    def module_counts(self, module):
        file = self.module_file(module)
        return self.file_bind_counts[file["path"]] if file else {}

    def module_symbol(self, module, name):
        file = self.module_file(module)
        if not file:
            return None
        counts = self.file_bind_counts[file["path"]]
        if counts.get(name, 0) != 1 or counts.get("*", 0):
            return None
        return self.file_defs[file["path"]].get(name)


class Visitor(ast.NodeVisitor):
    def __init__(self, analyzer, module, tree):
        self.a, self.module = analyzer, module
        self.file_path = analyzer.current["path"]
        self.owner = analyzer.sid("file", analyzer.current["path"])
        self.bindings = dict(analyzer.file_defs[self.file_path])
        self.imports = {}
        self.module_aliases = {}
        self.locals = {}
        self.aliases = {}
        self.function = False
        self.class_owner = None
        self.decorators = set()
        self.lambda_counts = defaultdict(int)
        self.bind_counts = self.count_bindings(tree, stop_defs=True)
        self.global_counts = self.bind_counts
        self.global_bindings = self.bindings
        self.local_imports = set()
        self.enclosing_shadows = set()
        self.enclosing_imports = set()
        self.class_environment = None
        for n in tree.body:
            if isinstance(n, (ast.Import, ast.ImportFrom)):
                self.bind_import(n, emit=False)

    @staticmethod
    def count_bindings(node, stop_defs=False):
        counts = defaultdict(int)

        def walk(n):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                counts[n.name] += 1
                return
            if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
                counts[n.id] += 1
            if isinstance(n, ast.Attribute) and isinstance(n.ctx, (ast.Store, ast.Del)):
                counts["attribute:"+ast.unparse(n)] += 1
            if isinstance(n, ast.ExceptHandler) and n.name:
                counts[n.name] += 1
            if type(n).__name__ in ("MatchAs", "MatchStar") and n.name:
                counts[n.name] += 1
            if type(n).__name__ == "MatchMapping" and n.rest:
                counts[n.rest] += 1
            if isinstance(n, ast.Import):
                for alias in n.names:
                    counts[alias.asname or alias.name.split(".")[0]] += 1
            if isinstance(n, ast.ImportFrom):
                for alias in n.names:
                    counts[alias.asname or alias.name] += 1
            for child in ast.iter_child_nodes(n):
                walk(child)
        for n in node.body:
            walk(n)
        return counts

    def bind_import(self, node, emit=True):
        if emit:
            for alias in node.names:
                self.local_imports.add(alias.asname or (alias.name.split(".")[0] if isinstance(node, ast.Import) else alias.name))
        # An unresolved local import still shadows an outer alias. Retaining
        # that alias would invent calls to the outer module after the import.
        for alias in node.names:
            local = alias.asname or (alias.name.split(".")[0] if isinstance(node, ast.Import) else alias.name)
            self.imports.pop(local, None)
            self.module_aliases.pop(local, None)
        if isinstance(node, ast.Import):
            for alias in node.names:
                m, confidence = self.a.resolve_module(alias.name, self.file_path)
                if m:
                    local = alias.asname or alias.name.split(".")[0]
                    # ``import pkg.mod`` binds pkg, not pkg.mod. Only the
                    # complete pkg.mod.name attribute path uses this module.
                    prefix = () if alias.asname else tuple(alias.name.split(".")[1:])
                    self.module_aliases[local] = (m, prefix)
                    if emit:
                        self.import_edge(m, node, confidence)
        else:
            m, confidence = self.a.resolve_module(node.module or "", self.file_path, node.level)
            if m:
                if emit:
                    self.import_edge(m, node, confidence)
                for alias in node.names:
                    local = alias.asname or alias.name
                    target = self.a.module_symbol(m, alias.name)
                    if target:
                        # Which module Python imports depends on sys.path.
                        self.imports[local] = (target, m)
                    elif (alias.name != "*" and not self.a.module_counts(m).get("*", 0)
                          and alias.name not in self.a.module_counts(m)
                          and self.a.module_file(m+"."+alias.name)):
                        child = m+"."+alias.name
                        self.module_aliases[local] = (child, ())
                        if emit:
                            self.import_edge(child, node, confidence)

    def import_edge(self, module, node, confidence):
        limitations = ["源码导入声明；不证明导入在运行时成功或执行。"]
        if confidence == "inferred":
            limitations.append("唯一索引模块候选；实际 sys.path 和导入根未验证。")
        self.a.edge(self.owner, self.a.sid("file", self.a.module_file(module)["path"]),
                    "imports", node, "python.import", confidence, limitations)

    def visit_Import(self, node):
        self.bind_import(node)

    def visit_ImportFrom(self, node):
        self.bind_import(node)

    def inherited_environment(self):
        if self.a.nodes[self.owner]["kind"] == "class":
            # Methods, lambdas and nested classes do not close over a class
            # namespace. Keep the nearest enclosing function/module imports.
            imports, aliases = self.class_environment
            return dict(imports), dict(aliases)
        return ({name: value for name, value in self.imports.items() if self.unshadowed(name)},
                {name: value for name, value in self.module_aliases.items() if self.unshadowed(name)})

    def definition(self, node):
        old = (self.owner, self.bindings, self.imports, self.module_aliases, self.locals,
               self.aliases, self.function, self.class_owner, self.bind_counts, self.local_imports,
               self.enclosing_shadows, self.enclosing_imports, self.class_environment)
        # Headers execute in the containing scope, before any new class members
        # can shadow them. A factory call records a call, not its returned type.
        for d in node.decorator_list:
            self.visit(d)
        if hasattr(node, "args"):
            for d in node.args.defaults + [d for d in node.args.kw_defaults if d]:
                self.visit(d)
        else:
            for base in node.bases:
                target, confidence = self.resolve_call(base)
                if target:
                    limitations = None
                    if target in self.a.decorated_symbols:
                        confidence = "inferred"
                        limitations = ["装饰器可能替换基类绑定；未执行目标代码核验。"]
                    self.a.edge(self.a.ast_symbols[id(node)], target, "inherits", base,
                                "python.base-reference", confidence, limitations)
                self.visit(base)
            for keyword in node.keywords:
                self.visit(keyword.value)
        inherited_imports, inherited_aliases = self.inherited_environment()
        enclosing = set(self.enclosing_shadows)
        if self.function:
            # A nested function closes over the outer lexical binding, even
            # when that binding is assigned later. Never fall back to a global
            # function with the same spelling. Class namespaces are not closure
            # scopes for their methods.
            enclosing.update(self.bind_counts)
            enclosing.update(self.locals)
        self.enclosing_shadows = enclosing
        self.owner = self.a.ast_symbols[id(node)]
        self.function = not isinstance(node, ast.ClassDef)
        self.class_owner = self.owner if not self.function else self.class_owner
        self.locals, self.aliases = {}, {}
        self.bindings = dict(self.global_bindings)
        self.bind_counts = self.count_bindings(node)
        self.local_imports = set()
        self.imports, self.module_aliases = inherited_imports, inherited_aliases
        self.enclosing_imports = set(inherited_imports) | set(inherited_aliases)
        self.class_environment = (dict(inherited_imports), dict(inherited_aliases)) if not self.function else None
        self.bindings.update(self.a.scope_defs.get(self.owner, {}))
        if self.function:
            for arg in self.a.parameters(node):
                nid = self.a.parameter(self.owner, arg)
                self.locals[arg.arg] = nid
                self.bind_counts[arg.arg] += 1
        for n in node.body:
            self.visit(n)
        (self.owner, self.bindings, self.imports, self.module_aliases, self.locals,
         self.aliases, self.function, self.class_owner, self.bind_counts, self.local_imports,
         self.enclosing_shadows, self.enclosing_imports, self.class_environment) = old

    visit_FunctionDef = definition
    visit_AsyncFunctionDef = definition
    visit_ClassDef = definition

    def resolve_call(self, node):
        if isinstance(node, ast.Name):
            name = node.id
            if not self.unshadowed(name):
                return None, None
            if name in self.imports:
                target, module = self.imports[name]
                return target, "inferred"  # root resolution is configuration dependent
            if name in self.bindings and (self.bind_counts.get(name, 0) == 0 or name not in self.global_bindings):
                target = self.bindings[name]
                if target:
                    return target, "static-confirmed"
            if not self.function and name in self.bindings and self.bind_counts.get(name, 0) == 1:
                return self.bindings[name], "static-confirmed"
        if isinstance(node, ast.Attribute):
            attributes = []
            root = node
            while isinstance(root, ast.Attribute):
                attributes.insert(0, root.attr)
                root = root.value
            if not isinstance(root, ast.Name) or not self.unshadowed(root.id):
                return None, None
            binding = self.module_aliases.get(root.id)
            if binding:
                module, prefix = binding
                if tuple(attributes[:-1]) == prefix:
                    mutation = "attribute:"+".".join([root.id]+attributes)
                    if self.bind_counts.get(mutation, 0) or self.global_counts.get(mutation, 0):
                        return None, None
                    return self.a.module_symbol(module, attributes[-1]), "inferred"
        return None, None

    def unshadowed(self, name):
        if name in self.locals or self.bind_counts.get(name, 0) > 1 or self.global_counts.get(name, 0) > 1:
            return False
        if (self.global_counts.get("*", 0) or self.bind_counts.get("*", 0)
                or name in self.enclosing_shadows and name not in self.a.scope_defs.get(self.owner, {})
                and name not in self.local_imports and name not in self.enclosing_imports):
            return False
        if (self.function and self.bind_counts.get(name, 0) > 0
                and name not in self.a.scope_defs.get(self.owner, {}) and name not in self.local_imports):
            # Python determines locals for the entire function, including
            # assignments after this call and roots of attribute calls.
            return False
        return True

    def visit_Call(self, node):
        target, confidence = self.resolve_call(node.func)
        if target:
            # Decorated functions may be replaced by arbitrary objects.
            decorated = target in self.a.decorated_symbols
            limitations = ["静态词法目标；不证明该调用在运行时执行。"]
            if decorated:
                confidence = "inferred"
                limitations.append("装饰器可能替换调用目标。")
            if confidence == "inferred":
                limitations.append("导入根/运行时绑定未执行验证。")
            self.a.edge(self.owner, target, "calls", node, "python.lexical-call", confidence, limitations)
            if not decorated:
                self.argument_bindings(node, target, confidence)
        else:
            self.a.unknown_calls[self.a.current["path"]].append(ast.unparse(node.func)[:100])
        self.generic_visit(node)

    def argument_bindings(self, call, target, confidence):
        """Project explicit argument expressions onto a known signature.

        These edges are syntax-level parameter bindings, never resolved callback
        calls or an assertion that two access roots refer to the same object.
        Argument unpacking and invalid/multiple bindings invalidate the whole
        projection instead of shifting the remaining arguments speculatively.
        """
        syntax = self.a.symbol_syntax.get(target)
        if not isinstance(syntax, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return
        if any(isinstance(arg, ast.Starred) for arg in call.args) or any(kw.arg is None for kw in call.keywords):
            return
        positional = syntax.args.posonlyargs + syntax.args.args
        keyword_params = {arg.arg: arg for arg in syntax.args.args + syntax.args.kwonlyargs}
        if len(call.args) > len(positional):
            return
        bindings = {formal.arg: actual for formal, actual in zip(positional, call.args)}
        formals = {arg.arg: arg for arg in positional + syntax.args.kwonlyargs}
        for keyword in call.keywords:
            if keyword.arg not in keyword_params or keyword.arg in bindings:
                return
            bindings[keyword.arg] = keyword.value
        required = positional[:len(positional)-len(syntax.args.defaults)]
        required += [arg for arg, default in zip(syntax.args.kwonlyargs, syntax.args.kw_defaults) if default is None]
        if any(arg.arg not in bindings for arg in required):
            return
        for name, actual in bindings.items():
            source, source_confidence = self.argument_source(actual)
            if not source:
                continue
            parameter = self.a.sid("symbol", f"python|{target}|parameter|{name}")
            if parameter not in self.a.nodes or name not in formals:
                continue
            binding_confidence = "inferred" if "inferred" in (confidence, source_confidence) else "static-confirmed"
            limitations = ["只证明此调用语法中实参表达式绑定到指定形参；不证明调用执行、跨函数对象身份或完整运行时数据流。",
                           "函数值传参不等于回调已执行；可变参数/关键字展开、装饰器和动态返回值不参与此映射。"]
            if binding_confidence == "inferred":
                limitations.append("调用目标或函数值的导入根/运行时绑定未验证，参数映射是有依据的候选。")
            self.a.edge(source, parameter, "passes", actual, "python.argument-binding",
                        binding_confidence, limitations, "argument:"+name)

    def argument_source(self, node):
        if isinstance(node, ast.Name) and node.id in self.locals:
            return self.locals[node.id], "static-confirmed"
        target, confidence = self.resolve_call(node)
        if target:
            # A decorator may replace the named callable; its declaration is
            # not evidence for the value passed to another function.
            return (None, None) if target in self.a.decorated_symbols else (target, confidence)
        if isinstance(node, (ast.Attribute, ast.Subscript)):
            root = node
            while isinstance(root, (ast.Attribute, ast.Subscript)):
                root = root.value
            if isinstance(root, ast.Name) and root.id in self.locals:
                return self.location(node), "static-confirmed"
        return None, None

    def location(self, node):
        if isinstance(node, ast.Name):
            if node.id in self.locals:
                return self.locals[node.id]
            nid = self.a.node("data", f"python|{self.owner}|local|{node.id}", node.id,
                              self.a.nodes[self.owner]["qualifiedName"]+"."+node.id, node, self.owner)
            self.locals[node.id] = nid
            return nid
        if isinstance(node, ast.Subscript):
            # Only literal keys. Nested expressions keep their root identity.
            if not isinstance(node.slice, ast.Constant) or not isinstance(node.slice.value, (str, int)):
                return None
        elif not isinstance(node, ast.Attribute):
            return None
        root = node
        while isinstance(root, (ast.Subscript, ast.Attribute)):
            root = root.value
        if not isinstance(root, ast.Name):
            return None
        spelling = ast.unparse(node)
        key = f"python|{self.owner}|access|{spelling}"
        return self.a.node("data", key, spelling, self.a.nodes[self.owner]["qualifiedName"]+"::"+spelling, node, self.owner)

    def visit_Assign(self, node):
        self.visit(node.value)
        for target in node.targets:
            self.write_target(target, node.value, "writes")

    def visit_AnnAssign(self, node):
        if node.value:
            self.visit(node.value)
        self.write_target(node.target, node.value, "writes")

    def visit_AugAssign(self, node):
        target = self.location(node.target)
        if target:
            self.a.edge(self.owner, target, "reads", node.target, "python.augmented-read")
        self.visit(node.value)
        self.write_target(node.target, node.value, "writes")

    def write_target(self, node, value, kind):
        if isinstance(node, (ast.Tuple, ast.List)):
            for elt in node.elts:
                self.write_target(elt, value, kind)
            return
        first_local_assignment = isinstance(node, ast.Name) and node.id not in self.locals
        nid = self.location(node)
        if nid:
            self.a.edge(self.owner, nid, kind, node, "python.static-write",
                        limitations=["函数内根表达式访问；未证明别名或跨函数对象身份。"])
            if value is not None and first_local_assignment:
                self.a.edge(self.owner, nid, "initializes", node, "python.assignment-value")
        # Evaluate subscript indices and object expressions as reads.
        if isinstance(node, (ast.Attribute, ast.Subscript)):
            self.visit(node.value)
            if isinstance(node, ast.Subscript):
                self.visit(node.slice)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load) and self.function:
            nid = self.locals.get(node.id)
            if nid:
                self.a.edge(self.owner, nid, "reads", node, "python.lexical-read")

    def visit_Attribute(self, node):
        self.access(node)

    def visit_Subscript(self, node):
        self.access(node)

    def access(self, node):
        # Attribute used as a call target is a callable reference, not a stored
        # field whose value has been semantically resolved.
        parent = getattr(node, "_parent", None)
        if isinstance(node.ctx, ast.Load) and not (isinstance(parent, ast.Call) and parent.func is node):
            nid = self.location(node)
            if nid:
                self.a.edge(self.owner, nid, "reads", node, "python.static-access",
                            limitations=["函数/根表达式内的语法访问；同名键不跨所有者合并，属性getter副作用未知。"])
        self.generic_visit(node)

    def visit_Lambda(self, node):
        # Lambda remains visibly contained but is not attributed to the outer
        # function: its body executes when invoked, not when declared.
        for default in node.args.defaults + [value for value in node.args.kw_defaults if value]:
            self.visit(default)
        inherited_imports, inherited_aliases = self.inherited_environment()
        class_scope = self.a.nodes[self.owner]["kind"] == "class"
        owner = self.owner
        ordinal = self.lambda_counts[owner]
        self.lambda_counts[owner] += 1
        label = "lambda("+ast.unparse(node.args)+")"
        self.owner = self.a.node("function", f"python|{owner}|lambda|{label}|{ordinal}", label,
                                 self.a.nodes[owner]["qualifiedName"]+"."+label, node, owner)
        old_locals = self.locals
        old_function = self.function
        old_counts = self.bind_counts
        old_shadows = self.enclosing_shadows
        old_bindings = self.bindings
        old_environment = (self.imports, self.module_aliases, self.local_imports,
                           self.enclosing_imports, self.class_environment)
        if self.function:
            self.enclosing_shadows = self.enclosing_shadows | set(self.bind_counts) | set(self.locals)
        self.function = True
        self.bind_counts = defaultdict(int)
        self.locals = {} if class_scope else dict(self.locals)
        if class_scope:
            self.bindings = dict(self.global_bindings)
        self.imports, self.module_aliases = inherited_imports, inherited_aliases
        self.local_imports = set()
        self.enclosing_imports = set(inherited_imports) | set(inherited_aliases)
        self.class_environment = None
        for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
            self.locals[arg.arg] = self.a.node("parameter", f"python|{self.owner}|parameter|{arg.arg}", arg.arg,
                                              self.a.nodes[self.owner]["qualifiedName"]+"."+arg.arg, arg, self.owner)
        self.visit(node.body)
        self.locals = old_locals
        self.function = old_function
        self.bind_counts = old_counts
        self.enclosing_shadows = old_shadows
        self.bindings = old_bindings
        (self.imports, self.module_aliases, self.local_imports,
         self.enclosing_imports, self.class_environment) = old_environment
        self.owner = owner


def main():
    try:
        # Windows pipe encodings otherwise depend on the parent console locale.
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
        if "--persistent" in sys.argv or "--server" in sys.argv:
            cache = {}
            for line in sys.stdin:
                if not line.strip():
                    continue
                request = json.loads(line)
                result = analyze(request, cache)
                sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":"))+"\n")
                sys.stdout.flush()
        else:
            request = json.load(sys.stdin)
            result = analyze(request)
            json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    except Exception as error:
        # Do not log request bodies or indexed source.
        print(f"Python analyzer failed: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
