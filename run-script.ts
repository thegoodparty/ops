import { readdirSync } from "fs";

const script = process.argv[2].replace(".ts", "");

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
