/**
 * A JSON Schema validator for the structured-output ask.
 *
 * The contract carries a plain JSON Schema — `StructuredOutputAsk = { schema }`
 * in `framework/types.ts`, which S2 could not make the AI SDK's `Output` value
 * because `Output.object({ schema })` has no `schema` member — and
 * `Output.object` wants a `FlexibleSchema`. `jsonSchema(schema, { validate })` is
 * the adapter, and the `validate` half is also what decides the repair taxonomy:
 * a schema mismatch becomes `TypeValidationError`, which is the "answered the
 * wrong shape" case worth one re-prompt (`isRepairable` in `child/run.ts`).
 *
 * The validation is deliberately shallow. The authoritative parse is
 * `ReviewOutputSchema.safeParse` in `run.ts`, which runs on the answer whatever
 * happened here; this only has to be strict enough that a malformed object is
 * reported as malformed rather than arriving as a success. Keywords the
 * reviewer's schema does not use are treated as a pass — a permissive validator
 * that defers to the strict one is the right trade for one shape, and the
 * alternative is a JSON Schema implementation in the worker for no gain.
 */
import { jsonSchema } from "ai";

type Verdict = { success: true; value: unknown } | { success: false; error: Error };

/** Walk one value against a JSON Schema node, returning the first problem. */
export const findSchemaProblem = (schema: unknown, value: unknown): string | undefined => {
  const walk = (node: unknown, v: unknown, path: string): string | undefined => {
    if (node === null || typeof node !== "object") return undefined;
    const s = node as Record<string, unknown>;

    // A union: every branch is tried, and the value is a problem only when all
    // of them reject it. `oneOf` and `anyOf` are treated alike because this
    // decides repairability, not validity.
    const branches = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
    if (branches !== undefined) {
      const errors = branches.map((branch) => walk(branch, v, path));
      return errors.every((e) => e !== undefined)
        ? `${path}: matches none of ${branches.length} branches (${errors.join("; ")})`
        : undefined;
    }

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      const actual = v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
      if (!types.some((t) => t === actual || (t === "number" && actual === "integer"))) {
        return `${path}: expected ${types.join("|")}, got ${actual}`;
      }
    }
    if (s.const !== undefined && v !== s.const) {
      return `${path}: expected ${JSON.stringify(s.const)}, got ${JSON.stringify(v)}`;
    }
    if (Array.isArray(s.enum) && !s.enum.includes(v)) {
      return `${path}: expected one of ${JSON.stringify(s.enum)}, got ${JSON.stringify(v)}`;
    }
    if (typeof v === "string" && typeof s.minLength === "number" && v.length < s.minLength) {
      return `${path}: shorter than ${s.minLength}`;
    }
    if (typeof v === "number") {
      if (typeof s.minimum === "number" && v < s.minimum) return `${path}: below ${s.minimum}`;
      if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum) {
        return `${path}: not above ${s.exclusiveMinimum}`;
      }
    }
    if (Array.isArray(v) && s.items !== undefined) {
      for (let i = 0; i < v.length; i++) {
        const problem = walk(s.items, v[i], `${path}[${i}]`);
        if (problem !== undefined) return problem;
      }
    }
    if (s.required !== undefined || s.properties !== undefined) {
      if (v === null || typeof v !== "object" || Array.isArray(v)) return `${path}: expected an object`;
      const object = v as Record<string, unknown>;
      for (const key of (s.required as string[] | undefined) ?? []) {
        if (!(key in object)) return `${path}: missing "${key}"`;
      }
      const properties = s.properties as Record<string, unknown> | undefined;
      if (properties !== undefined) {
        for (const [key, sub] of Object.entries(properties)) {
          if (!(key in object)) continue;
          const problem = walk(sub, object[key], `${path}.${key}`);
          if (problem !== undefined) return problem;
        }
      }
    }
    return undefined;
  };
  return walk(schema, value, "answer");
};

/** The contract's ask, as the SDK's `FlexibleSchema`. */
export const schemaValidator = (schema: unknown) =>
  jsonSchema(schema as Parameters<typeof jsonSchema>[0], {
    validate: (value: unknown): Verdict => {
      const problem = findSchemaProblem(schema, value);
      return problem === undefined
        ? { success: true, value }
        : { success: false, error: new Error(problem) };
    },
  });
