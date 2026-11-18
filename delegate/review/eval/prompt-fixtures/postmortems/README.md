# Frozen post-mortems for the golden prompt test

These are copies of `delegate/review/postmortems/` exactly as they stood at
`4cc8590`, the commit `delegate/review/eval/prompt-golden.test.ts` computed its
hashes from. The test reads them through `selectPostmortems`' `dir` option
instead of the live folder.

**Do not sync these.** They are a fixture, not a second copy to keep current.
The selector prompt lists every lesson in the folder it is given, so reading
the live folder made the golden test fail on *content* rather than on code: the
weekly post-mortem sync, or any edit to one, moved all 33 hashes and turned
`npm test` red for a PR that changed no code. That is ops#549's shape.

With the fixture frozen, only a change to the prompt-building code moves a
hash. Editing a post-mortem changes what the reviewer is shown, which is
delivered by syncing the live folder, and the golden test is not the place that
should notice.
