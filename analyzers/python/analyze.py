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
        self.files = request.get("files", [])
        self.nodes = {}
        self.edges = {}
        self.evidence = {}
        self.diagnostics = []
        self.module_defs = {}
        self.module_files = {}
        self.trees = {}
        self.ast_symbols = {}
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

    def edge(self, source, target, kind, syntax, rule, confidence="static-confirmed", limitations=None):
        eid = self.ev(syntax, rule)
        condition = self.condition(syntax)
        key = f"{source}|{target}|{kind}|{rule}|{condition}"
        edge_id = self.sid("edge", key)
        if edge_id not in self.edges:
            item = {"id": edge_id, "source": source, "target": target, "kind": kind,
                    "confidence": confidence, "evidenceIds": [], "rule": rule}
            if limitations:
                item["limitations"] = limitations
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
                nid = self.node(kind, f"python|{module}|{q}", n.name, q, n, parent, signature)
                self.ast_symbols[id(n)] = nid
                if n.decorator_list:
                    self.decorated_symbols.add(nid)
                if n.name in definitions:
                    self.diagnostic("PY_REDEFINED_BINDING", f"{n.name} 存在重复定义，调用绑定未确认。", self.current["path"], n.lineno)
                    definitions[n.name] = None
                else:
                    definitions[n.name] = nid
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

    def run(self):
        wanted = {(self.scope, f["path"].replace("\\", "/")) for f in self.files}
        for key in list(self.parse_cache):
            if key[0] == self.scope and key not in wanted:
                del self.parse_cache[key]
                self.removed += 1
        for f in self.files:
            self.current = f = {**f, "path": f["path"].replace("\\", "/")}
            module = self.module_name(f["path"])
            self.module_files[module] = f
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
            self.trees[module] = tree
            self.module_defs[module] = self.collect(tree.body, module, self.sid("file", f["path"]), module)
        for module, tree in self.trees.items():
            self.current = self.module_files[module]
            Visitor(self, module, tree).visit(tree)
        for path, calls in self.unknown_calls.items():
            examples = ", ".join(dict.fromkeys(calls))[:350]
            self.diagnostic("PY_DYNAMIC_CALLS", f"{len(calls)} 处调用无法静态确认目标（含外部库、实例方法、回调或重绑定）：{examples}。", path)
        self.diagnostic("PY_STATIC_SCOPE", "Python 结果为词法声明、保守直接调用与静态访问；字典键仅在所属函数/根表达式内识别。不代表完整对象身份或运行时数据流。", severity="info")
        self.diagnostic("incremental-parser", f"parsed={self.parsed}; reused={self.reused}; removed={self.removed}; Python未变文件复用AST，跨文件绑定保守重新分析。", severity="info")
        return {"nodes": list(self.nodes.values()), "edges": list(self.edges.values()),
                "evidence": list(self.evidence.values()), "diagnostics": self.diagnostics}

    def resolve_module(self, name, current, level=0):
        candidates = [name]
        package = current.split(".")[:-1]
        if level:
            base = package[:len(package)-level+1]
            candidates.insert(0, ".".join(base+([name] if name else [])))
        else:
            candidates.append(".".join(package+[name]))
        exact = [c for c in candidates if c in self.trees]
        if exact:
            return exact[0]
        # Scripts often add their own directory to sys.path. Accept only a
        # unique suffix, and callers label this import-root assumption inferred.
        matches = [m for m in self.trees if m == name or m.endswith("."+name)]
        return matches[0] if len(matches) == 1 else None


class Visitor(ast.NodeVisitor):
    def __init__(self, analyzer, module, tree):
        self.a, self.module = analyzer, module
        self.owner = analyzer.sid("file", analyzer.current["path"])
        self.bindings = dict(analyzer.module_defs[module])
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
        if isinstance(node, ast.Import):
            for alias in node.names:
                m = self.a.resolve_module(alias.name, self.module)
                if m:
                    local = alias.asname or alias.name.split(".")[0]
                    self.module_aliases[local] = m
                    if emit:
                        self.a.edge(self.owner, self.a.sid("file", self.a.module_files[m]["path"]), "imports", node, "python.import")
        else:
            m = self.a.resolve_module(node.module or "", self.module, node.level)
            if m:
                if emit:
                    self.a.edge(self.owner, self.a.sid("file", self.a.module_files[m]["path"]), "imports", node, "python.import")
                for alias in node.names:
                    local = alias.asname or alias.name
                    target = self.a.module_defs[m].get(alias.name)
                    if target:
                        # Which module Python imports depends on sys.path.
                        self.imports[local] = (target, m)

    def visit_Import(self, node):
        self.bind_import(node)

    def visit_ImportFrom(self, node):
        self.bind_import(node)

    def definition(self, node):
        old = (self.owner, self.bindings, self.imports, self.module_aliases, self.locals,
               self.aliases, self.function, self.class_owner, self.bind_counts, self.local_imports)
        # Defaults and decorators execute in the containing scope.
        for d in node.decorator_list:
            self.visit(d)
        if hasattr(node, "args"):
            for d in node.args.defaults + [d for d in node.args.kw_defaults if d]:
                self.visit(d)
        self.owner = self.a.ast_symbols[id(node)]
        self.function = not isinstance(node, ast.ClassDef)
        self.class_owner = self.owner if not self.function else self.class_owner
        self.locals, self.aliases = {}, {}
        self.bindings = dict(self.global_bindings)
        self.bind_counts = self.count_bindings(node)
        self.local_imports = set()
        self.imports, self.module_aliases = dict(self.imports), dict(self.module_aliases)
        self.bindings.update(self.a.scope_defs.get(self.owner, {}))
        if self.function:
            args = node.args.posonlyargs + node.args.args + node.args.kwonlyargs
            args += [x for x in (node.args.vararg, node.args.kwarg) if x]
            for arg in args:
                nid = self.a.node("parameter", f"python|{self.owner}|parameter|{arg.arg}", arg.arg,
                                  self.a.nodes[self.owner]["qualifiedName"]+"."+arg.arg, arg, self.owner)
                self.locals[arg.arg] = nid
                self.bind_counts[arg.arg] += 1
        else:
            for base in node.bases:
                target, _ = self.resolve_call(base)
                if target:
                    self.a.edge(self.owner, target, "inherits", base, "python.base-reference")
        for n in node.body:
            self.visit(n)
        (self.owner, self.bindings, self.imports, self.module_aliases, self.locals,
         self.aliases, self.function, self.class_owner, self.bind_counts, self.local_imports) = old

    visit_FunctionDef = definition
    visit_AsyncFunctionDef = definition
    visit_ClassDef = definition

    def resolve_call(self, node):
        if isinstance(node, ast.Name):
            name = node.id
            if name in self.locals or self.bind_counts.get(name, 0) > 1 or self.global_counts.get(name, 0) > 1:
                return None, None
            if (self.function and self.bind_counts.get(name, 0) > 0
                    and name not in self.a.scope_defs.get(self.owner, {}) and name not in self.local_imports):
                # Python determines locals for the entire function, including
                # assignments after this call. Do not bind to a shadowed import.
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
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            name = node.value.id
            if name in self.locals or self.bind_counts.get(name, 0) > 1 or self.global_counts.get(name, 0) > 1:
                return None, None
            module = self.module_aliases.get(name)
            if module:
                return self.a.module_defs[module].get(node.attr), "inferred"
        return None, None

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
        else:
            self.a.unknown_calls[self.a.current["path"]].append(ast.unparse(node.func)[:100])
        self.generic_visit(node)

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
        owner = self.owner
        ordinal = self.lambda_counts[owner]
        self.lambda_counts[owner] += 1
        label = "lambda("+ast.unparse(node.args)+")"
        self.owner = self.a.node("function", f"python|{owner}|lambda|{label}|{ordinal}", label,
                                 self.a.nodes[owner]["qualifiedName"]+"."+label, node, owner)
        old_locals = self.locals
        old_function = self.function
        old_counts = self.bind_counts
        self.function = True
        self.bind_counts = defaultdict(int)
        self.locals = dict(self.locals)
        for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
            self.locals[arg.arg] = self.a.node("parameter", f"python|{self.owner}|parameter|{arg.arg}", arg.arg,
                                              self.a.nodes[self.owner]["qualifiedName"]+"."+arg.arg, arg, self.owner)
        self.visit(node.body)
        self.locals = old_locals
        self.function = old_function
        self.bind_counts = old_counts
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
