import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

/**
 * The charset AWS accepts in a security-group name or description, and in a
 * security-group rule's description.
 *
 * This is an apply-time failure and nothing cheaper catches it. `Deploy
 * workbench` on `main` failed twice with the same error, from the merges of
 * #414 and #417:
 *
 *     api error InvalidParameterValue: Invalid rule description. Valid
 *     descriptions are strings less than 256 characters from the following
 *     set:  a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*
 *
 * The offending character was an apostrophe, in two rule descriptions that
 * quoted the task group's `from the ALB only` invariant. `pulumi preview` does
 * not validate the charset -- it accepts the string, plans a rule, and exits
 * green -- so neither the PR's preview nor the `pulumi preview` step in the
 * deploy run before the apply can see it. The first thing that rejects the
 * string is `ec2:AuthorizeSecurityGroupIngress`, in the apply, after everything
 * else in the run has succeeded.
 *
 * So the check lives here, in the unit suite every PR runs (`npm test`, the
 * `.github/workflows/deploy.yml` `test` job, which holds no credentials). It
 * reads every Pulumi program in this repository as source, resolves each
 * security-group description statically, and fails on the first one AWS would
 * reject.
 *
 * The failure mode that matters is a *new* rule that this test does not look
 * at, so it fails loudly rather than skipping: a standalone rule resource with
 * no `description`, or any description that is not a string this file can
 * resolve, is an error naming the file and line, not a pass. A
 * security-group resource type it does not recognise (`aws.vpc.SecurityGroup...`)
 * is an error too, so a new AWS resource cannot slip a description past the
 * scan. An inline rule (`ingress`/`egress` inside an `aws.ec2.SecurityGroup`)
 * may omit a description -- there is then no string for AWS to reject -- but a
 * description it does carry is checked like any other.
 *
 * The trees are read as source text because the alternative is standing up
 * four Pulumi programs under mocks, and the assertion is about a literal that
 * is written in the source either way. That is the same reason
 * `deploy-workflow-order.test.ts` reads the workflow as text.
 */

/** The exact set from AWS's message: an apostrophe, a quote and a backtick are
 * not in it, and each of those is a character a description wants to use. */
const ALLOWED = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]*$/;
/** "strings less than 256 characters". */
const MAX_LENGTH = 255;

/**
 * Every resource whose `description` AWS validates against `ALLOWED`. The
 * security-group name is in the same character set, which is why it is checked
 * here too.
 */
const SECURITY_GROUP = "aws.ec2.SecurityGroup";
const RULE_TYPES = new Set([
  "aws.ec2.SecurityGroupRule",
  "aws.vpc.SecurityGroupIngressRule",
  "aws.vpc.SecurityGroupEgressRule",
]);
/** Anything with this shape is an SG resource; an unfamiliar one is an error. */
const SECURITY_GROUP_SHAPE = /^aws\.(ec2|vpc)\.SecurityGroup(Rule|IngressRule|EgressRule)?$/;

/** The Pulumi programs. `deploy/*` and the three account trees. */
const PROJECT_ROOTS = [
  "deploy",
  "deploy-workbench",
  "deploy-org",
  "deploy-infrastructure",
];
const REPO_ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

const sourceFiles = (dir: string): string[] => {
  const absolute = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(absolute)) {
    return [];
  }
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(relative);
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      return [];
    }
    return [relative];
  });
};

type Site = {
  file: string;
  line: number;
  resource: string;
  logicalName: string;
  field: string;
  values: string[];
};

/** Where a node starts, for the failure message. */
const position = (
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { file: string; line: number } => {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file: path.relative(REPO_ROOT, sourceFile.fileName), line: line + 1 };
};

const propertyName = (node: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
    return node.text;
  }
  return undefined;
};

const property = (
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined =>
  object.properties.find(
    (member): member is ts.PropertyAssignment =>
      ts.isPropertyAssignment(member) && propertyName(member.name) === name,
  );

/**
 * Resolve an expression to the strings it can be at apply time. Only the
 * shapes this repository writes are resolved: a string literal, a template
 * with no substitutions, a template whose substitutions are literals or
 * identifiers bound to them, an identifier bound to one of those, or an array
 * literal of them (the `for (const protocol of ["udp", "tcp"] as const)` that
 * writes the two DNS descriptions). Anything else throws, which the caller
 * turns into a named failure: a description this test cannot read is a
 * description it cannot clear.
 */
const resolveStrings = (
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  seen: ReadonlySet<string> = new Set(),
): string[] => {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }
  if (ts.isTemplateExpression(expression)) {
    let resolved = [expression.head.text];
    for (const span of expression.templateSpans) {
      const values = resolveStrings(span.expression, sourceFile, seen);
      resolved = resolved.flatMap((prefix) =>
        values.map((value) => `${prefix}${value}${span.literal.text}`),
      );
    }
    return resolved;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) => {
      assert.ok(
        ts.isExpression(element),
        `${position(sourceFile, element).file}:${position(sourceFile, element).line}: ` +
          "a spread or omitted element in a description's array is not resolvable; write the strings out",
      );
      return resolveStrings(element, sourceFile, seen);
    });
  }
  // `["udp", "tcp"] as const` and `(x)` are the same expression with packaging.
  if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) {
    return resolveStrings(expression.expression, sourceFile, seen);
  }
  if (ts.isIdentifier(expression)) {
    return resolveIdentifier(expression.text, sourceFile, seen);
  }
  const { file, line } = position(sourceFile, expression);
  throw new Error(
    `${file}:${line}: the description is not a string literal this test can resolve ` +
      `(it is \`${expression.getText(sourceFile)}\`). Write the description inline, or ` +
      "extend `resolveStrings`, so the charset AWS applies can be checked before the apply.",
  );
};

/** The one declaration of `name` in the file, and the strings it can be. */
const resolveIdentifier = (
  name: string,
  sourceFile: ts.SourceFile,
  seen: ReadonlySet<string>,
): string[] => {
  assert.ok(
    !seen.has(name),
    `${path.relative(REPO_ROOT, sourceFile.fileName)}: \`${name}\` resolves to itself`,
  );
  const next = new Set(seen).add(name);
  const values: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      values.push(...resolveStrings(node.initializer, sourceFile, next));
      return;
    }
    // `for (const protocol of ["udp", "tcp"] as const)`, which is how the two
    // DNS rule descriptions get their value.
    if (
      ts.isForOfStatement(node) &&
      ts.isVariableDeclarationList(node.initializer) &&
      node.initializer.declarations.length === 1 &&
      ts.isIdentifier(node.initializer.declarations[0].name) &&
      node.initializer.declarations[0].name.text === name
    ) {
      values.push(...resolveStrings(node.expression, sourceFile, next));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (values.length === 0) {
    const { line } = position(sourceFile, sourceFile);
    throw new Error(
      `${path.relative(REPO_ROOT, sourceFile.fileName)}:${line}: cannot resolve ` +
        `\`${name}\` to a string; write the description inline so this test can check it`,
    );
  }
  return values;
};

/**
 * Every string AWS validates with the security-group charset, with the resource
 * and field it came from. The nested `ingress`/`egress` arrays of an
 * `aws.ec2.SecurityGroup` carry one description per inline rule, so they are
 * collected too.
 */
const sites = (): Site[] => {
  const found: Site[] = [];

  for (const file of PROJECT_ROOTS.flatMap(sourceFiles)) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    const sourceFile = ts.createSourceFile(
      path.join(REPO_ROOT, file),
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const collect = (
      object: ts.ObjectLiteralExpression,
      resource: string,
      logicalName: string,
      field: string,
      required = true,
    ): void => {
      const assignment = property(object, field);
      if (!assignment) {
        if (!required) {
          return;
        }
        const { line } = position(sourceFile, object);
        throw new Error(
          `${file}:${line}: \`${logicalName}\` (${resource}) has no \`${field}\`. ` +
            "This test checks the security-group strings this repository writes, and a " +
            "field it cannot find is one it would silently skip; add it rather than leaving it out.",
        );
      }
      const { line } = position(sourceFile, assignment);
      found.push({
        file,
        line,
        resource,
        logicalName,
        field,
        values: resolveStrings(assignment.initializer, sourceFile),
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        const resource = node.expression.getText(sourceFile);
        if (SECURITY_GROUP_SHAPE.test(resource)) {
          assert.ok(
            resource === SECURITY_GROUP || RULE_TYPES.has(resource),
            `${file}:${position(sourceFile, node).line}: \`${resource}\` is a security-group ` +
              "resource this test does not know how to read, so its description would go " +
              "unchecked. Teach `security-group-descriptions.test.ts` about it.",
          );
          const args = node.arguments ?? [];
          const object = args[1];
          if (!object || !ts.isObjectLiteralExpression(object)) {
            throw new Error(
              `${file}:${position(sourceFile, node).line}: \`${resource}\` is not constructed ` +
                "with an inline object, so its description cannot be read statically",
            );
          }
          const logicalName =
            args[0] && ts.isStringLiteralLike(args[0]) ? args[0].text : "<unnamed>";

          if (resource === SECURITY_GROUP) {
            collect(object, resource, logicalName, "name");
            collect(object, resource, logicalName, "description");
            // Inline rules: `ingress: [{ description: ... }]`. They are the one
            // shape that puts a rule description inside the group resource.
            for (const field of ["ingress", "egress"]) {
              const rules = property(object, field);
              if (!rules) {
                continue;
              }
              assert.ok(
                ts.isArrayLiteralExpression(rules.initializer),
                `${file}:${position(sourceFile, rules).line}: \`${logicalName}.${field}\` is not ` +
                  "an array literal, so its rule descriptions cannot be checked",
              );
              for (const element of rules.initializer.elements) {
                assert.ok(
                  ts.isObjectLiteralExpression(element),
                  `${file}:${position(sourceFile, element).line}: \`${logicalName}.${field}\` has an ` +
                    "element this test cannot read; write the rule inline",
                );
                // Inline rules are the one shape whose `description` is
                // optional: without one there is no string to reject. With one,
                // it is checked like a standalone rule's.
                collect(element, resource, `${logicalName}.${field}[]`, "description", false);
              }
            }
          } else {
            collect(object, resource, logicalName, "description");
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return found;
};

/**
 * Computed on first use rather than at module load, so a structural failure
 * (a rule with no readable description) fails the assertions below with its
 * file and line instead of aborting the file before a test runs.
 */
let scanned: Site[] | undefined;
const all = (): Site[] => (scanned ??= sites());

describe("security-group names and descriptions", () => {
  it("found the resource sites, so the scan is not passing vacuously", () => {
    assert.ok(all().length > 0, "no security-group resources were read at all");
    // The two rules the workbench deploy failed on are the ones this test was
    // written for; if a refactor moves them out of the scan, that is a failure
    // and not a quietly smaller test.
    for (const logicalName of [
      "bifrostTaskIngressVkMint",
      "bifrostTaskIngressVkJanitor",
    ]) {
      assert.ok(
        all().some((site) => site.logicalName === logicalName),
        `\`${logicalName}\` is not in the scan; the test would not be checking the rules the deploy failed on`,
      );
    }
  });

  it("uses only characters AWS accepts", () => {
    const offenders = all().flatMap((site) =>
      site.values
        .filter((value) => !ALLOWED.test(value))
        .map((value) => {
          const bad = [...new Set([...value].filter((char) => !ALLOWED.test(char)))];
          return (
            `${site.file}:${site.line}: ${site.logicalName}.${site.field} has ` +
            `${JSON.stringify(bad.join(""))}, which is not in AWS's security-group charset: ` +
            `a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*  -- ${JSON.stringify(value)}`
          );
        }),
    );
    assert.deepEqual(offenders, []);
  });

  it("keeps every description under 256 characters", () => {
    const offenders = all().flatMap((site) =>
      site.values
        .filter((value) => value.length > MAX_LENGTH)
        .map(
          (value) =>
            `${site.file}:${site.line}: ${site.logicalName}.${site.field} is ${value.length} characters`,
        ),
    );
    assert.deepEqual(offenders, []);
  });
});
