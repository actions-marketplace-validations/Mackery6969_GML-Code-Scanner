import type * as A from "../parser/ast.ts";
import { walk } from "../parser/walk.ts";
import type { GmlFile, Project } from "../project/loader.ts";
import { isArgumentVariable, isBuiltinFunction, isBuiltinIdentifier, resolveRuntimeIndex } from "./builtins.ts";
import { resolveScopes, type FileScopes, type Scope } from "./scope.ts";

export interface FunctionInfo {
  name: string;
  node: A.FunctionNode;
  file: GmlFile;
  scope: Scope;
  isConstructor: boolean;
  /** Declared at the top level of a script: a global function. */
  isGlobal: boolean;
}

export interface DeclInfo<T extends A.Node> {
  node: T;
  file: GmlFile;
}

/** Functions whose first string argument names a variable being set. */
const VARIABLE_SETTERS: Record<string, { nameArg: number; global: boolean }> = {
  variable_instance_set: { nameArg: 1, global: false },
  variable_struct_set: { nameArg: 1, global: false },
  struct_set: { nameArg: 1, global: false },
  variable_global_set: { nameArg: 0, global: true },
};

/** Functions that look assets up by name at runtime. */
export const DYNAMIC_ASSET_LOOKUPS = new Set(["asset_get_index", "script_execute_ext", "variable_global_get", "variable_instance_get", "struct_get", "variable_struct_get", "method_call"]);

/**
 * Project-wide symbol information shared by all rules.
 */
export class ProjectIndex {
  readonly project: Project;
  readonly scopes = new Map<GmlFile, FileScopes>();
  /** Script-level functions by name (a name with 2+ entries is a duplicate). */
  readonly globalFunctions = new Map<string, FunctionInfo[]>();
  /** Every function (global, method, nested) keyed by its AST node. */
  readonly functionsByNode = new Map<A.FunctionNode, FunctionInfo>();
  /** Named methods defined in each object's events. */
  readonly methodsByObject = new Map<string, Map<string, FunctionInfo[]>>();
  readonly macros = new Map<string, DeclInfo<A.MacroDeclaration>[]>();
  readonly enums = new Map<string, DeclInfo<A.EnumDeclaration>[]>();
  /** `global.x`, `globalvar x`, variable_global_set("x"), top-level script assignments. */
  readonly globalVariables = new Set<string>();
  /** Names declared with `globalvar` anywhere in the project. */
  readonly globalvarNames = new Set<string>();
  /** Every name assigned as an instance or struct variable anywhere in the project. */
  readonly assignedNames = new Set<string>();
  /** Instance variables assigned directly in each object's own code or variable definitions. */
  readonly instanceVariables = new Map<string, Set<string>>();
  /** Identifier references (reads, writes, calls) by name, excluding declarations. */
  readonly identifierRefs = new Map<string, number>();
  /** Identifier references grouped by the resource that makes them. */
  readonly refsByResource = new Map<string, Set<string>>();
  /** Values of all string literals (resource names looked up dynamically). */
  readonly stringLiterals = new Set<string>();
  /** Functions called from `gml_pragma("global", "...")` code, which GameMaker runs before the first room. */
  readonly pragmaGlobalCalls = new Set<string>();
  /** Asset name → resource type (objects, sprites, ...), including unregistered folders. */
  readonly assets = new Map<string, string>();
  /** The project sets variables through computed names (`variable_instance_set(id, name, v)`). */
  usesDynamicVariableNames = false;
  /** The project looks up assets through computed names (`asset_get_index("obj_" + n)`). */
  usesDynamicAssetNames = false;
  /** Index into KNOWN_RUNTIMES of the project's runtime, or -1 if unknown. */
  readonly runtimeIndex: number;

  constructor(project: Project, runtimeOverride?: string) {
    this.project = project;
    this.runtimeIndex = resolveRuntimeIndex(runtimeOverride ?? project.yyp?.ideVersion);
    for (const [name, list] of project.resources) {
      const registered = list.find((r) => r.inYyp) ?? list[0];
      this.assets.set(name, registered.type);
    }
    for (const obj of project.objects.values()) {
      if (!this.assets.has(obj.name)) this.assets.set(obj.name, "objects");
      for (const p of obj.properties) {
        this.instanceVars(obj.name).add(p);
        this.assignedNames.add(p);
      }
    }
    for (const file of project.files) {
      if (file.kind === "script" && !this.assets.has(file.resource)) this.assets.set(file.resource, "scripts");
      this.indexFile(file);
    }
    for (const info of this.functionsByNode.values()) {
      if (info.isGlobal || info.file.kind !== "object-event" || info.name === "<anonymous>") continue;
      let methods = this.methodsByObject.get(info.file.resource);
      if (!methods) this.methodsByObject.set(info.file.resource, (methods = new Map()));
      push(methods, info.name, info);
    }
  }

  private instanceVars(object: string): Set<string> {
    let set = this.instanceVariables.get(object);
    if (!set) {
      set = new Set();
      this.instanceVariables.set(object, set);
    }
    return set;
  }

  private indexFile(file: GmlFile): void {
    const scopes = resolveScopes(file.ast);
    this.scopes.set(file, scopes);
    const owner = file.kind === "object-event" ? file.resource : undefined;
    const resourceRefs = this.refsByResource.get(file.resource) ?? new Set<string>();
    this.refsByResource.set(file.resource, resourceRefs);

    for (const ref of scopes.refs) {
      const name = ref.id.name;
      this.identifierRefs.set(name, (this.identifierRefs.get(name) ?? 0) + 1);
      resourceRefs.add(name);
      if (ref.binding.kind !== "free" || ref.access === "read" || ref.inMacro) continue;
      // Assignment to a non-local name.
      if (ref.scope === scopes.root && file.kind === "script" && ref.withDepth === 0) {
        // Top-level script code runs in global scope (GMS 2.3+).
        this.globalVariables.add(name);
      }
      this.assignedNames.add(name);
      if (owner && ref.withDepth === 0) this.instanceVars(owner).add(name);
    }
    for (const g of scopes.globalvars) {
      this.globalVariables.add(g.name);
      this.globalvarNames.add(g.name);
    }

    const topLevel = new Set(file.ast.body);
    walk(file.ast, (node, ctx) => {
      switch (node.type) {
        case "FunctionDeclaration":
        case "FunctionExpression": {
          const name = node.id?.name ?? this.functionNameFromContext(ctx.ancestors);
          const info: FunctionInfo = {
            name: name ?? "<anonymous>",
            node,
            file,
            scope: scopes.scopeOf.get(node)!,
            isConstructor: node.isConstructor,
            isGlobal: node.type === "FunctionDeclaration" && topLevel.has(node) && (file.kind === "script" || file.kind === "extension"),
          };
          this.functionsByNode.set(node, info);
          if (info.isGlobal && name) push(this.globalFunctions, name, info);
          if (node.type === "FunctionDeclaration" && !info.isGlobal && name) {
            // Named function declarations inside events/functions become methods of `self`.
            this.assignedNames.add(name);
            if (owner) this.instanceVars(owner).add(name);
          }
          break;
        }
        case "MacroDeclaration":
          push(this.macros, node.id.name, { node, file });
          break;
        case "EnumDeclaration":
          push(this.enums, node.id.name, { node, file });
          break;
        case "VarDeclaration":
          if (node.kind === "static") for (const d of node.declarations) this.assignedNames.add(d.id.name);
          break;
        case "AssignmentExpression":
          this.recordMemberWrite(node.left, owner);
          break;
        case "UpdateExpression":
          this.recordMemberWrite(node.argument, owner);
          break;
        case "StructProperty":
          this.assignedNames.add(node.key.type === "Identifier" ? node.key.name : node.key.value);
          break;
        case "StringLiteral":
          this.stringLiterals.add(node.value);
          break;
        case "CallExpression":
          this.recordCall(node);
          break;
      }
    });
  }

  private functionNameFromContext(ancestors: readonly A.Node[]): string | undefined {
    // `name = function() {}` / `var name = function() {}` / `static name = function() {}`
    const parent = ancestors[ancestors.length - 1];
    if (parent?.type === "AssignmentExpression") {
      if (parent.left.type === "Identifier") return parent.left.name;
      if (parent.left.type === "MemberExpression") return parent.left.property.name;
    }
    if (parent?.type === "VarDeclarator") return parent.id.name;
    if (parent?.type === "StructProperty") return parent.key.type === "Identifier" ? parent.key.name : parent.key.value;
    return undefined;
  }

  private recordMemberWrite(target: A.Expression, owner: string | undefined): void {
    if (target.type === "MemberExpression") {
      const name = target.property.name;
      if (target.object.type === "Identifier" && target.object.name === "global") this.globalVariables.add(name);
      else {
        this.assignedNames.add(name);
        if (owner && target.object.type === "Identifier" && target.object.name === "self") this.instanceVars(owner).add(name);
      }
    } else if (target.type === "IndexExpression" && target.accessor === "$") {
      const key = target.indices[0];
      if (key?.type === "StringLiteral") {
        if (target.object.type === "Identifier" && target.object.name === "global") this.globalVariables.add(key.value);
        else this.assignedNames.add(key.value);
      } else if (target.object.type === "Identifier" && (target.object.name === "self" || target.object.name === "global" || target.object.name === "id")) {
        this.usesDynamicVariableNames = true;
      }
    }
  }

  private recordCall(call: A.CallExpression): void {
    if (call.callee.type !== "Identifier") return;
    const name = call.callee.name;
    if (name === "gml_pragma") {
      const [kind, body] = call.arguments;
      if (kind?.type === "StringLiteral" && kind.value === "global" && body?.type === "StringLiteral") {
        for (const m of body.value.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) this.pragmaGlobalCalls.add(m[1]);
      }
    }
    const setter = VARIABLE_SETTERS[name];
    if (setter) {
      const arg = call.arguments[setter.nameArg];
      if (arg?.type === "StringLiteral") {
        if (setter.global) this.globalVariables.add(arg.value);
        else this.assignedNames.add(arg.value);
      } else if (arg) {
        this.usesDynamicVariableNames = true;
      }
    }
    if (DYNAMIC_ASSET_LOOKUPS.has(name)) {
      const arg = call.arguments[name === "script_execute_ext" || name === "method_call" ? 0 : name.startsWith("variable_instance") || name.includes("struct") ? 1 : 0];
      if (arg && arg.type !== "StringLiteral" && arg.type !== "Identifier") this.usesDynamicAssetNames = true;
      if (arg?.type === "Identifier" && name === "asset_get_index") this.usesDynamicAssetNames = true;
    }
  }

  /** Names that resolve globally without any declaration in the file. */
  isKnownGlobal(name: string): boolean {
    return (
      isBuiltinIdentifier(name) ||
      isBuiltinFunction(name) ||
      isArgumentVariable(name) ||
      this.globalFunctions.has(name) ||
      this.assets.has(name) ||
      this.macros.has(name) ||
      this.enums.has(name) ||
      this.project.extensionFunctions.has(name) ||
      this.project.extensionConstants.has(name) ||
      this.project.roomInstances.has(name) ||
      this.globalVariables.has(name)
    );
  }

  /** Callable without a local/instance binding: builtins, script functions, scripts, extensions. */
  isKnownFunction(name: string): boolean {
    return isBuiltinFunction(name) || this.globalFunctions.has(name) || this.assets.get(name) === "scripts" || this.project.extensionFunctions.has(name);
  }

  /** Resolves a call target by name to project functions (global first, then methods of the object). */
  resolveFunction(name: string, file: GmlFile): FunctionInfo[] {
    const globals = this.globalFunctions.get(name);
    if (globals) return globals;
    if (file.kind !== "object-event") return [];
    return this.methodsByObject.get(file.resource)?.get(name) ?? [];
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
