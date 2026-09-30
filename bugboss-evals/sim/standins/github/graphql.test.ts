// The executor's own contract, apart from gh: the shapes gh composes that a
// field-list reading of its source would miss, and the failure it must give
// for a field the model does not have.

import assert from "node:assert/strict";
import { test } from "node:test";

import { execute, obj } from "./graphql";

const root = obj("Query", {
  repository: (args) =>
    obj("Repository", {
      name: String(args.name),
      pullRequest: (a) =>
        obj("PullRequest", {
          number: a.number as number,
          author: obj("Bot", { login: "bugboss-gp" }, ["Actor"]),
          commits: (c) => obj("Connection", { totalCount: 3, nodes: [c.last === 1 ? "last" : "all"] }),
        }),
    }),
});
const run = (query: string, variables = {}) =>
  execute({ query, variables, query_root: root, mutation_root: obj("Mutation", {}), types: { PullRequest: ["number", "author"] } });

test("variables, aliases, fragments and inline type conditions", async () => {
  const result = await run(
    `query Q($n: Int!, $name: String = "omni") {
      repository(owner: "o", name: $name) {
        pullRequest(number: $n) {
          ...F
          statusCheckRollup: commits(last: 1) { nodes }
          author { __typename ...on User { name } ...on Bot { login } ... @include(if: false) { login } }
        }
      }
    }
    fragment F on PullRequest { number }`,
    { n: 7 },
  );
  assert.deepEqual(result, {
    data: {
      repository: {
        pullRequest: {
          number: 7,
          statusCheckRollup: { nodes: ["last"] },
          author: { __typename: "Bot", login: "bugboss-gp" },
        },
      },
    },
  });
});

test("introspection answers the field names gh feature-detects on", async () => {
  const result = await run(`{ PullRequest: __type(name: "PullRequest") { fields(includeDeprecated: true) { name } } }`);
  assert.deepEqual(result.data, { PullRequest: { fields: [{ name: "number" }, { name: "author" }] } });
});

test("an unknown field fails the whole query with GitHub's message", async () => {
  const missing: string[] = [];
  const result = await execute({
    query: `{ repository(owner: "o", name: "r") { stargazers } }`,
    query_root: root,
    mutation_root: obj("Mutation", {}),
    types: {},
    onMissing: (t, f) => missing.push(`${t}.${f}`),
  });
  assert.equal(result.data, null);
  assert.equal(result.errors?.[0].message, "Field 'stargazers' doesn't exist on type 'Repository'");
  assert.deepEqual(missing, ["Repository.stargazers"]);
});

test("a resolver that throws nulls its field and reports where", async () => {
  const result = await execute({
    query: `{ a b }`,
    query_root: obj("Query", { a: () => { throw new Error("nope"); }, b: 1 }),
    mutation_root: obj("Mutation", {}),
    types: {},
  });
  assert.deepEqual(result, { data: { a: null, b: 1 }, errors: [{ message: "nope", path: ["a"] }] });
});
