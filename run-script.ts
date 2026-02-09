import { readdirSync } from "fs";

const scriptArg = process.argv[2];
if (!scriptArg) {
  const scripts = readdirSync(`${__dirname}/scripts`)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""));
  console.error("Usage: npm run script <script-name>");
  console.error("Available scripts:", scripts.join(", "));
  process.exit(1);
}
const script = scriptArg.replace(".ts", "");

const scripts = readdirSync(`${__dirname}/scripts`).map(
  (filename) => `${__dirname}/scripts/${filename}`
);

const matches = scripts.filter((filepath) =>
  filepath.endsWith(`/${script}.ts`)
);

if (matches.length === 0) {
  console.error(`No script found for ${script}`);
  process.exitCode = 1;
  process.exit();
}

import(matches[0])
  .then((func) => func.default())
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
