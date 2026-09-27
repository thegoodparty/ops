import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  NOTES_LIMITS,
  createNotesSync,
  notesLimitBreach,
  notesOverLimitMessage,
  notesPrefixFor,
  notesSyncExtension,
  restoreNotesDir,
  scanNotesDir,
  type NotesStore,
} from "./notes";

const fakeStore = () => {
  const objects = new Map<string, Buffer>();
  const puts: string[] = [];
  const deletes: string[] = [];
  const store: NotesStore = {
    get: async (key) => objects.get(key) ?? null,
    put: async (key, body) => {
      puts.push(key);
      objects.set(key, Buffer.from(body));
    },
    list: async (prefix) =>
      [...objects.keys()].filter((key) => key.startsWith(prefix)).sort(),
    delete: async (key) => {
      deletes.push(key);
      objects.delete(key);
    },
  };
  return { store, objects, puts, deletes };
};

const notesDir = () => mkdtemp(join(tmpdir(), "bugboss-notes-"));

const PREFIX = "sessions/incident/inc-1/notes/";

test("notes hang off whatever session key the Boss chose", () => {
  assert.equal(
    notesPrefixFor("sessions/incident/inc-1/session.jsonl"),
    "sessions/incident/inc-1/notes/",
  );
  assert.equal(
    notesPrefixFor("sessions/incident/42/session.jsonl"),
    "sessions/incident/42/notes/",
  );
  // A key with nothing to hang off would put notes at the bucket root, where
  // they belong to no incident. Louder than a wrong default.
  assert.throws(() => notesPrefixFor("session.jsonl"), /no prefix/);
});

test("a note reaches S3 under the incident's own prefix", async () => {
  const { store, objects } = fakeStore();
  const dir = await notesDir();
  await writeFile(join(dir, "ruled-out.md"), "the alert rule, not the service");

  const sync = createNotesSync({ store, prefix: PREFIX, dir });
  await sync.flush();

  assert.equal(sync.lastError(), null);
  assert.equal(
    objects.get("sessions/incident/inc-1/notes/ruled-out.md")?.toString(),
    "the alert rule, not the service",
  );
});

test("a turn that changed nothing costs no uploads", async () => {
  const { store, puts } = fakeStore();
  const dir = await notesDir();
  await writeFile(join(dir, "a.md"), "one");
  await mkdir(join(dir, "deep"), { recursive: true });
  await writeFile(join(dir, "deep", "b.md"), "two");

  const sync = createNotesSync({ store, prefix: PREFIX, dir });
  await sync.flush();
  assert.deepEqual(puts.sort(), [
    "sessions/incident/inc-1/notes/a.md",
    "sessions/incident/inc-1/notes/deep/b.md",
  ]);

  await sync.flush();
  assert.equal(puts.length, 2, "an unchanged directory must not be re-uploaded");

  await writeFile(join(dir, "a.md"), "one, revised");
  await sync.flush();
  assert.deepEqual(puts.slice(2), ["sessions/incident/inc-1/notes/a.md"]);
});

test("a note the agent deleted does not come back on the next restart", async () => {
  const { store, objects, deletes } = fakeStore();
  const dir = await notesDir();
  await writeFile(join(dir, "wrong-theory.md"), "it was the deploy");
  await writeFile(join(dir, "keep.md"), "it was not the deploy");

  const sync = createNotesSync({ store, prefix: PREFIX, dir });
  await sync.flush();
  await rm(join(dir, "wrong-theory.md"));
  await sync.flush();

  assert.deepEqual(deletes, ["sessions/incident/inc-1/notes/wrong-theory.md"]);
  assert.equal(objects.has("sessions/incident/inc-1/notes/wrong-theory.md"), false);
  assert.equal(objects.has("sessions/incident/inc-1/notes/keep.md"), true);
});

test("a restarted agent finds its notes where it left them", async () => {
  const { store } = fakeStore();
  const first = await notesDir();
  await mkdir(join(first, "evidence"), { recursive: true });
  await writeFile(join(first, "ruled-out.md"), "loki was healthy");
  await writeFile(join(first, "evidence", "counts.txt"), "0 5xx in 24h");

  await createNotesSync({ store, prefix: PREFIX, dir: first }).flush();

  const second = await notesDir();
  const restored = await restoreNotesDir({ store, prefix: PREFIX, dir: second });

  assert.equal(restored.fileCount, 2);
  assert.equal(await readFile(join(second, "ruled-out.md"), "utf8"), "loki was healthy");
  assert.equal(
    await readFile(join(second, "evidence", "counts.txt"), "utf8"),
    "0 5xx in 24h",
  );

  // The restored digests are what keep the first flush after a restart from
  // re-uploading a directory nothing changed.
  const { puts } = { puts: [] as string[] };
  const counting: NotesStore = {
    ...store,
    put: async (key, body) => {
      puts.push(key);
      await store.put(key, body);
    },
  };
  await createNotesSync({
    store: counting,
    prefix: PREFIX,
    dir: second,
    seen: restored.seen,
  }).flush();
  assert.deepEqual(puts, []);
});

test("an emptied directory is mirrored; a lost one is not", async () => {
  const { store, objects, deletes } = fakeStore();
  const dir = await notesDir();
  await writeFile(join(dir, "a.md"), "one");

  const sync = createNotesSync({ store, prefix: PREFIX, dir });
  await sync.flush();
  assert.equal(objects.has("sessions/incident/inc-1/notes/a.md"), true);

  // The agent cleaning up after itself: mirror it.
  await rm(join(dir, "a.md"));
  await sync.flush();
  assert.deepEqual(deletes, ["sessions/incident/inc-1/notes/a.md"]);

  await writeFile(join(dir, "b.md"), "two");
  await sync.flush();
  assert.equal(objects.has("sessions/incident/inc-1/notes/b.md"), true);

  // The directory itself gone is lost local storage, not a deletion. The S3
  // copy is what a restart restores from, so it must survive.
  await rm(dir, { recursive: true });
  await sync.flush();
  assert.equal(sync.lastError(), null);
  assert.equal(objects.has("sessions/incident/inc-1/notes/b.md"), true);
  assert.deepEqual(deletes, ["sessions/incident/inc-1/notes/a.md"]);
});

test("a fresh run still gets the directory the prompt names", async () => {
  const { store } = fakeStore();
  const dir = join(await notesDir(), "nested", "notes");

  const restored = await restoreNotesDir({ store, prefix: PREFIX, dir });

  assert.equal(restored.fileCount, 0);
  const scan = await scanNotesDir(dir);
  assert.equal(scan.present, true);
  assert.deepEqual(scan.files, []);
});

test("over the size bound nothing is mirrored and the last good copy stands", async () => {
  const { store, objects, puts } = fakeStore();
  const dir = await notesDir();
  await writeFile(join(dir, "notes.md"), "small and useful");

  const limits = { maxBytes: 64, maxFiles: 8 };
  const sync = createNotesSync({ store, prefix: PREFIX, dir, limits });
  await sync.flush();
  assert.equal(sync.overLimit(), null);
  assert.equal(puts.length, 1);

  await writeFile(join(dir, "dump.txt"), "x".repeat(200));
  await sync.flush();

  const breach = sync.overLimit();
  assert.ok(breach, "a refused write must be visible, not silent");
  assert.equal(breach.limits.maxBytes, 64);
  assert.equal(puts.length, 1, "nothing is uploaded while over the bound");
  assert.equal(sync.lastError(), null, "over-bounds is a refusal, not a failure");
  assert.equal(
    objects.get("sessions/incident/inc-1/notes/notes.md")?.toString(),
    "small and useful",
  );
  assert.equal(objects.has("sessions/incident/inc-1/notes/dump.txt"), false);

  await rm(join(dir, "dump.txt"));
  await sync.flush();
  assert.equal(sync.overLimit(), null, "trimming back under resumes the mirror");
});

test("the file count is bounded too", async () => {
  const { store, puts } = fakeStore();
  const dir = await notesDir();
  for (let i = 0; i < 4; i += 1) await writeFile(join(dir, `n${i}.md`), "x");

  const sync = createNotesSync({
    store,
    prefix: PREFIX,
    dir,
    limits: { maxBytes: 1024 * 1024, maxFiles: 3 },
  });
  await sync.flush();

  assert.equal(sync.overLimit()?.fileCount, 4);
  assert.deepEqual(puts, []);
});

test("the over-limit message says what to do about it", () => {
  const breach = notesLimitBreach(
    {
      files: [
        { path: "dump.txt", bytes: 8 * 1024 * 1024 },
        { path: "notes.md", bytes: 512 },
      ],
      totalBytes: 8 * 1024 * 1024 + 512,
      skipped: [],
      present: true,
    },
    NOTES_LIMITS,
  );
  assert.ok(breach);

  const message = notesOverLimitMessage(breach);
  assert.match(message, /nothing in it is being saved/);
  assert.match(message, /dump\.txt \(8\.0 MB\)/);
  assert.match(message, /Delete what you no longer need/);
});

test("a symlink is reported and never followed", async () => {
  const { store, objects } = fakeStore();
  const dir = await notesDir();
  const outside = join(await notesDir(), "secret.txt");
  await writeFile(outside, "not the agent's to publish");
  await symlink(outside, join(dir, "link.txt"));
  await writeFile(join(dir, "real.md"), "mine");

  const sync = createNotesSync({ store, prefix: PREFIX, dir });
  await sync.flush();

  assert.deepEqual(sync.skipped(), ["link.txt"]);
  assert.equal(objects.has("sessions/incident/inc-1/notes/link.txt"), false);
  assert.equal(objects.get("sessions/incident/inc-1/notes/real.md")?.toString(), "mine");
});

test("a failing upload streaks and recovers, and never throws at the caller", async () => {
  const dir = await notesDir();
  await writeFile(join(dir, "a.md"), "one");

  let fail = true;
  const sync = createNotesSync({
    store: {
      get: async () => null,
      list: async () => [],
      delete: async () => {},
      put: async () => {
        if (fail) throw new Error("no such bucket");
      },
    },
    prefix: PREFIX,
    dir,
  });

  await sync.flush();
  assert.equal(sync.failureStreak(), 1);
  await sync.flush();
  assert.equal(sync.failureStreak(), 2);

  fail = false;
  await sync.flush();
  assert.equal(sync.failureStreak(), 0);
  assert.equal(sync.lastError(), null);
});

test("the mirror runs on turn end and on shutdown, like the session", async () => {
  const { store, objects } = fakeStore();
  const dir = await notesDir();
  await writeFile(join(dir, "a.md"), "one");

  const handlers = new Map<string, () => Promise<void>>();
  const pi = {
    on: (event: string, handler: () => Promise<void>) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;

  const sync = createNotesSync({ store, prefix: PREFIX, dir });
  const seen: number[] = [];
  notesSyncExtension(sync, (flushed) => seen.push(flushed.failureStreak()))(pi);

  assert.deepEqual([...handlers.keys()].sort(), ["session_shutdown", "turn_end"]);

  await handlers.get("turn_end")?.();
  assert.equal(objects.has("sessions/incident/inc-1/notes/a.md"), true);

  await writeFile(join(dir, "b.md"), "two");
  await handlers.get("session_shutdown")?.();
  assert.equal(objects.has("sessions/incident/inc-1/notes/b.md"), true);
  assert.deepEqual(seen, [0, 0], "every flush reports, success or not");
});
