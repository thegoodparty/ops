import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// Source-inspection tests, in the style of deploy-infrastructure/sheriff.test.ts.
// The bug these pin (gp-pi#57) is environmental: the worker image has no git
// credential helper, so the raw `git fetch`/`git checkout` after `gh repo clone`
// could not reach a private repo even though gh's own API calls were
// authenticated. Network auth cannot be unit tested here, so we assert the
// credential setup is wired into the reviewer path and ordered before the
// clone. The end-to-end proof is the next private-repo review.

const WORKER_DIR = __dirname;

const read = (file: string): string =>
  fs.readFileSync(path.join(WORKER_DIR, file), "utf8");

// Slice one top-level declaration out of a source file so an assertion can be
// scoped to that function rather than the whole module.
const declaration = (source: string, name: string): string => {
  const start = source.search(
    new RegExp(`^(?:export )?(?:const|function) ${name}\\b`, "m"),
  );
  assert.ok(start >= 0, `${name} declaration not found`);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/^(?:export )?(?:const|function) /m);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe("worker git credentials", () => {
  const auth = read("github-auth.ts");

  it("configures a git credential helper through gh", () => {
    const helper = declaration(auth, "configureGitCredentials");
    // `gh auth git-credential` is the helper `gh auth setup-git` installs; it
    // reads GH_TOKEN/GITHUB_TOKEN and emits username=x-access-token for an App
    // installation token.
    assert.match(helper, /"auth",\s*"setup-git"/);
    assert.match(helper, /"--hostname",\s*"github\.com"/);
    assert.match(helper, /GH_TOKEN/);
    // The token must come from the environment, never be written to a remote
    // URL or the config file.
    assert.doesNotMatch(helper, /https:\/\/[^"]*@github\.com/);
  });

  it("runs it for the reviewer App path", () => {
    const reviewer = declaration(auth, "setupReviewerGitHubAuth");
    assert.match(reviewer, /configureGitCredentials\(token\)/);
    // The reviewer path stays on the reviewer App's own key; the delegate App
    // key must not leak in and change who the checkout runs as.
    assert.match(reviewer, /REVIEWER_APP_PRIVATE_KEY/);
    assert.doesNotMatch(reviewer, /GITHUB_APP_PRIVATE_KEY/);
  });

  it("runs it for the delegate App path too", () => {
    const delegate = declaration(auth, "setupGitHubAuth");
    assert.match(delegate, /configureGitCredentials\(token\)/);
  });

  it("sets up credentials before the reviewer clone in the entrypoint", () => {
    const entry = read("entrypoint.ts");
    const authCall = entry.indexOf("await setupReviewerGitHubAuth()");
    const cloneCall = entry.indexOf('["repo", "clone", repoFullName');
    assert.ok(authCall >= 0, "reviewer auth call not found in entrypoint");
    assert.ok(cloneCall >= 0, "reviewer clone not found in entrypoint");
    assert.ok(
      authCall < cloneCall,
      "reviewer auth (and its git credential setup) must run before the clone",
    );
  });
});
