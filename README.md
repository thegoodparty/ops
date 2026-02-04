This repo houses tools and guidance for operating the Serve product.

## Setup

To set up the project for running scripts, just do the following:

```bash
npm install
cp .env.example .env
# Now, fill in real values in .env
```

## Scripts

See [`scripts`](./scripts) for all of the supported scripts.

To run a script, use the `script` command:

```bash
npm run script <script-name>
```

For example, to run the `poll-problem` script, you can run:

```bash
npm run script poll-problem <arg>
```

## Runbooks

See [`docs/runbooks.md`](docs/runbooks.md) for the runbooks.
