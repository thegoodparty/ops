// A small GraphQL executor for the GitHub stand-in.
//
// `gh` builds its queries from field lists (`gh pr view --json a,b,c` picks
// the selection), so a table of recorded queries would break the first time
// the agent asks for a field nobody recorded. Executing the query against an
// object model instead answers whatever `gh` composes, and a field the model
// does not have fails the way GitHub fails -- a named error -- rather than
// with a silently empty answer the agent would reason from.
//
// Supported: operations, variables with defaults, aliases, arguments of every
// literal kind, inline fragments, named fragments, `@include`/`@skip`, and
// `__type(name:)` introspection of field names, which is how `gh` feature-
// detects a GitHub Enterprise host.

export type Scalar = string | number | boolean | null;

export type Value = Scalar | GqlObject | Value[] | undefined;

export type ArgValue = Scalar | ArgValue[] | { [key: string]: ArgValue };

export type Args = Record<string, ArgValue>;

export type Resolver = Value | ((args: Args) => Value | Promise<Value>);

export interface GqlObject {
  __typename: string;
  /** Interfaces and unions an inline fragment may name to reach this type. */
  __implements?: string[];
  fields: Record<string, Resolver>;
}

export const obj = (
  typename: string,
  fields: Record<string, Resolver>,
  implementsTypes: string[] = [],
): GqlObject => ({ __typename: typename, __implements: implementsTypes, fields });

type Token =
  | { kind: "punct"; value: string }
  | { kind: "name"; value: string }
  | { kind: "int"; value: string }
  | { kind: "float"; value: string }
  | { kind: "string"; value: string };

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (/[\s,﻿]/.test(c)) {
      i++;
      continue;
    }
    if (source.startsWith("...", i)) {
      tokens.push({ kind: "punct", value: "..." });
      i += 3;
      continue;
    }
    if ("!$()[]{}:=@|&".includes(c)) {
      tokens.push({ kind: "punct", value: c });
      i++;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      tokens.push({ kind: "name", value: m![0] });
      i += m![0].length;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (!m) throw new Error(`unexpected character ${c} at ${i}`);
      tokens.push({ kind: m[2] || m[3] ? "float" : "int", value: m[0] });
      i += m[0].length;
      continue;
    }
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      if (end < 0) throw new Error("unterminated block string");
      tokens.push({ kind: "string", value: source.slice(i + 3, end) });
      i = end + 3;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\") {
          const e = source[j + 1];
          if (e === "u") {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[e] ?? e;
          j += 2;
          continue;
        }
        out += source[j];
        j++;
      }
      tokens.push({ kind: "string", value: out });
      i = j + 1;
      continue;
    }
    throw new Error(`unexpected character ${c} at ${i}`);
  }
  return tokens;
};

type AstValue =
  | { kind: "variable"; name: string }
  | { kind: "literal"; value: Scalar }
  | { kind: "enum"; value: string }
  | { kind: "list"; values: AstValue[] }
  | { kind: "object"; fields: Record<string, AstValue> };

interface Directive {
  name: string;
  args: Record<string, AstValue>;
}

type Selection =
  | {
      kind: "field";
      alias: string;
      name: string;
      args: Record<string, AstValue>;
      directives: Directive[];
      selections: Selection[] | null;
    }
  | { kind: "inline"; typeCondition: string | null; directives: Directive[]; selections: Selection[] }
  | { kind: "spread"; name: string; directives: Directive[] };

interface Operation {
  kind: "query" | "mutation";
  name: string | null;
  variables: { name: string; defaultValue: AstValue | null }[];
  selections: Selection[];
}

interface Fragment {
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Record<string, Fragment>;
}

export const parse = (source: string): Document => {
  const tokens = tokenize(source);
  let p = 0;
  const peek = (): Token | undefined => tokens[p];
  const isPunct = (value: string): boolean =>
    peek()?.kind === "punct" && peek()?.value === value;
  const expectPunct = (value: string): void => {
    if (!isPunct(value)) {
      throw new Error(`expected "${value}", got ${JSON.stringify(peek()?.value ?? "end of query")}`);
    }
    p++;
  };
  const name = (): string => {
    const t = peek();
    if (t?.kind !== "name") throw new Error(`expected a name, got ${JSON.stringify(t?.value ?? "end of query")}`);
    p++;
    return t.value;
  };

  const value = (): AstValue => {
    const t = peek();
    if (!t) throw new Error("expected a value");
    if (t.kind === "punct" && t.value === "$") {
      p++;
      return { kind: "variable", name: name() };
    }
    if (t.kind === "punct" && t.value === "[") {
      p++;
      const values: AstValue[] = [];
      while (!isPunct("]")) values.push(value());
      p++;
      return { kind: "list", values };
    }
    if (t.kind === "punct" && t.value === "{") {
      p++;
      const fields: Record<string, AstValue> = {};
      while (!isPunct("}")) {
        const key = name();
        expectPunct(":");
        fields[key] = value();
      }
      p++;
      return { kind: "object", fields };
    }
    p++;
    if (t.kind === "int") return { kind: "literal", value: Number.parseInt(t.value, 10) };
    if (t.kind === "float") return { kind: "literal", value: Number.parseFloat(t.value) };
    if (t.kind === "string") return { kind: "literal", value: t.value };
    if (t.kind === "name") {
      if (t.value === "true") return { kind: "literal", value: true };
      if (t.value === "false") return { kind: "literal", value: false };
      if (t.value === "null") return { kind: "literal", value: null };
      return { kind: "enum", value: t.value };
    }
    throw new Error(`unexpected ${t.value}`);
  };

  const args = (): Record<string, AstValue> => {
    const out: Record<string, AstValue> = {};
    if (!isPunct("(")) return out;
    p++;
    while (!isPunct(")")) {
      const key = name();
      expectPunct(":");
      out[key] = value();
    }
    p++;
    return out;
  };

  const directives = (): Directive[] => {
    const out: Directive[] = [];
    while (isPunct("@")) {
      p++;
      out.push({ name: name(), args: args() });
    }
    return out;
  };

  const typeRef = (): void => {
    if (isPunct("[")) {
      p++;
      typeRef();
      expectPunct("]");
    } else {
      name();
    }
    if (isPunct("!")) p++;
  };

  const selectionSet = (): Selection[] => {
    expectPunct("{");
    const out: Selection[] = [];
    while (!isPunct("}")) {
      if (isPunct("...")) {
        p++;
        if (peek()?.kind === "name" && peek()?.value === "on") {
          p++;
          const typeCondition = name();
          const dirs = directives();
          out.push({ kind: "inline", typeCondition, directives: dirs, selections: selectionSet() });
        } else if (isPunct("{") || isPunct("@")) {
          const dirs = directives();
          out.push({ kind: "inline", typeCondition: null, directives: dirs, selections: selectionSet() });
        } else {
          const fragmentName = name();
          out.push({ kind: "spread", name: fragmentName, directives: directives() });
        }
        continue;
      }
      let alias = name();
      let fieldName = alias;
      if (isPunct(":")) {
        p++;
        fieldName = name();
      }
      const fieldArgs = args();
      const dirs = directives();
      out.push({
        kind: "field",
        alias,
        name: fieldName,
        args: fieldArgs,
        directives: dirs,
        selections: isPunct("{") ? selectionSet() : null,
      });
      alias = "";
    }
    p++;
    return out;
  };

  const doc: Document = { operations: [], fragments: {} };
  while (p < tokens.length) {
    if (isPunct("{")) {
      doc.operations.push({ kind: "query", name: null, variables: [], selections: selectionSet() });
      continue;
    }
    const keyword = name();
    if (keyword === "fragment") {
      const fragmentName = name();
      if (name() !== "on") throw new Error("expected 'on' in a fragment definition");
      const typeCondition = name();
      directives();
      doc.fragments[fragmentName] = { typeCondition, selections: selectionSet() };
      continue;
    }
    if (keyword !== "query" && keyword !== "mutation") {
      throw new Error(`unsupported operation ${keyword}`);
    }
    const opName = peek()?.kind === "name" ? name() : null;
    const variables: Operation["variables"] = [];
    if (isPunct("(")) {
      p++;
      while (!isPunct(")")) {
        expectPunct("$");
        const varName = name();
        expectPunct(":");
        typeRef();
        let defaultValue: AstValue | null = null;
        if (isPunct("=")) {
          p++;
          defaultValue = value();
        }
        variables.push({ name: varName, defaultValue });
      }
      p++;
    }
    directives();
    doc.operations.push({ kind: keyword, name: opName, variables, selections: selectionSet() });
  }
  return doc;
};

export class GqlError extends Error {
  constructor(
    message: string,
    readonly path: (string | number)[],
    readonly type?: string,
  ) {
    super(message);
  }
}

const resolveArg = (v: AstValue, vars: Record<string, ArgValue>): ArgValue => {
  switch (v.kind) {
    case "variable":
      return vars[v.name] ?? null;
    case "literal":
      return v.value;
    case "enum":
      return v.value;
    case "list":
      return v.values.map((x) => resolveArg(x, vars));
    case "object": {
      const out: Record<string, ArgValue> = {};
      for (const [k, x] of Object.entries(v.fields)) out[k] = resolveArg(x, vars);
      return out;
    }
  }
};

const included = (dirs: Directive[], vars: Record<string, ArgValue>): boolean => {
  for (const d of dirs) {
    const cond = d.args.if ? resolveArg(d.args.if, vars) : true;
    if (d.name === "include" && !cond) return false;
    if (d.name === "skip" && cond) return false;
  }
  return true;
};

const isObject = (v: Value): v is GqlObject =>
  typeof v === "object" && v !== null && !Array.isArray(v) && "__typename" in v;

export interface ExecuteInput {
  query: string;
  variables?: Record<string, ArgValue>;
  operationName?: string;
  query_root: GqlObject;
  mutation_root: GqlObject;
  /** Every type an introspection query may name, by typename. */
  types: Record<string, string[]>;
  /** Called for a field the model does not have, so the gap is recorded. */
  onMissing?: (type: string, field: string) => void;
}

export interface ExecuteResult {
  data: Record<string, unknown> | null;
  errors?: { message: string; path?: (string | number)[]; type?: string }[];
}

export const execute = async (input: ExecuteInput): Promise<ExecuteResult> => {
  let doc: Document;
  try {
    doc = parse(input.query);
  } catch (err) {
    return { data: null, errors: [{ message: `Parse error: ${(err as Error).message}` }] };
  }
  const op = input.operationName
    ? doc.operations.find((o) => o.name === input.operationName)
    : doc.operations[0];
  if (!op) return { data: null, errors: [{ message: "No operation found" }] };

  const vars: Record<string, ArgValue> = { ...(input.variables ?? {}) };
  for (const v of op.variables) {
    if (!(v.name in vars) && v.defaultValue) vars[v.name] = resolveArg(v.defaultValue, {});
  }
  const errors: NonNullable<ExecuteResult["errors"]> = [];

  const introspectType = (typeName: string): Value => {
    const fields = input.types[typeName];
    if (!fields) return null;
    return obj("__Type", {
      name: typeName,
      kind: "OBJECT",
      fields: fields.map((f) => obj("__Field", { name: f, isDeprecated: false })),
    });
  };

  const collect = (
    selections: Selection[],
    target: GqlObject,
    out: Extract<Selection, { kind: "field" }>[],
  ): void => {
    for (const s of selections) {
      if (!included(s.directives, vars)) continue;
      if (s.kind === "field") {
        out.push(s);
        continue;
      }
      const typeCondition =
        s.kind === "inline" ? s.typeCondition : doc.fragments[s.name]?.typeCondition;
      const nested = s.kind === "inline" ? s.selections : doc.fragments[s.name]?.selections;
      if (!nested) throw new GqlError(`Fragment ${s.kind === "spread" ? s.name : ""} was not defined`, []);
      if (
        typeCondition === null ||
        typeCondition === undefined ||
        typeCondition === target.__typename ||
        (target.__implements ?? []).includes(typeCondition)
      ) {
        collect(nested, target, out);
      }
    }
  };

  const complete = async (
    value: Value,
    selections: Selection[] | null,
    path: (string | number)[],
  ): Promise<unknown> => {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) {
      return Promise.all(value.map((v, i) => complete(v, selections, [...path, i])));
    }
    if (isObject(value)) {
      if (!selections) {
        throw new GqlError(`Field must have selections (field '${path.at(-1)}' returns ${value.__typename} but has no selections)`, path);
      }
      return resolveObject(value, selections, path);
    }
    return value;
  };

  const resolveObject = async (
    target: GqlObject,
    selections: Selection[],
    path: (string | number)[],
  ): Promise<Record<string, unknown>> => {
    const fields: Extract<Selection, { kind: "field" }>[] = [];
    collect(selections, target, fields);
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const fieldPath = [...path, f.alias];
      if (f.name === "__typename") {
        out[f.alias] = target.__typename;
        continue;
      }
      const fieldArgs: Args = {};
      for (const [k, v] of Object.entries(f.args)) fieldArgs[k] = resolveArg(v, vars);
      if (f.name === "__type" && target === input.query_root) {
        out[f.alias] = await complete(introspectType(String(fieldArgs.name)), f.selections, fieldPath);
        continue;
      }
      if (!(f.name in target.fields)) {
        input.onMissing?.(target.__typename, f.name);
        throw new GqlError(
          `Field '${f.name}' doesn't exist on type '${target.__typename}'`,
          fieldPath,
          "undefinedField",
        );
      }
      const resolver = target.fields[f.name];
      try {
        const raw = typeof resolver === "function" ? await resolver(fieldArgs) : resolver;
        out[f.alias] = await complete(raw, f.selections, fieldPath);
      } catch (err) {
        if (err instanceof GqlError && err.type === "undefinedField") throw err;
        errors.push({
          message: (err as Error).message,
          path: err instanceof GqlError && err.path.length ? err.path : fieldPath,
          ...(err instanceof GqlError && err.type ? { type: err.type } : {}),
        });
        out[f.alias] = null;
      }
    }
    return out;
  };

  try {
    const root = op.kind === "mutation" ? input.mutation_root : input.query_root;
    const data = await resolveObject(root, op.selections, []);
    return errors.length ? { data, errors } : { data };
  } catch (err) {
    const e = err as GqlError;
    return {
      data: null,
      errors: [{ message: e.message, ...(e.path ? { path: e.path } : {}), ...(e.type ? { type: e.type } : {}) }],
    };
  }
};
