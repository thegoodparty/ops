/**
 * The config-store tables the seed copies, and the ruling on how that set is
 * expressed. Step 2 of `docs/bifrost-zero-downtime-deploys.md`, decision 18.
 *
 * ## The ruling: a committed list with a drift test, not a query
 *
 * The plan asks the seed to copy "the config store's own tables plus the
 * `migrations` table" and names the 66 `TableName()` methods in
 * `framework/configstore/tables/` as that set. Bifrost's source is not vendored
 * in this repo, so the list cannot be derived at build time here. The three
 * options, and why this one:
 *
 * 1. **A query against `information_schema`, excluding the log store's
 *    tables.** Rejected, and it is the option that looks best. The exclusion
 *    list is the log store's schema, which is the thing decision 18 already
 *    rejects as a shape: a table the log store adds in a future release is
 *    silently copied (doubling the largest object on the volume), and a table
 *    the *config* store adds is silently copied too, so neither case is
 *    visible. Worse, the query cannot tell the two stores apart at all -- they
 *    share one database and one `migrations` table, which is the premise of the
 *    design -- so "excluding the log store's tables" means a committed list of
 *    the log store's tables with the same drift risk, and a failure mode that
 *    is a silent over-copy rather than a silent under-copy.
 *
 * 2. **Enumerate the tables from the running store.** There is no endpoint that
 *    prefixes a table with the store that owns it. `migrations` is shared by
 *    construction, and the two stores' step IDs are disjoint but their tables
 *    are not labelled. This is option 1 with a network call.
 *
 * 3. **A committed list, with a test that fails when it drifts.** Chosen. The
 *    list is here, the script carries a copy of it because the image is built
 *    from the script, and two tests keep the pair honest. It fails **loudly**:
 *    a table absent from the list is missing from the colour and a query for it
 *    is an error the first time the new task asks, or -- for the tables the
 *    store creates lazily -- a table that silently does not exist. Either way
 *    it is visible on the first deploy that uses the table rather than being a
 *    quiet omission nobody looks for.
 *
 * ### What happens when Bifrost adds a config-store table at the next pin
 *
 * Nothing here notices on its own. The upgrade PR bumps `BIFROST_UPSTREAM_DIGEST`
 * in `bifrost-image.ts`, and this list does not move with it, so the new table
 * is not seeded. That is the cost of a committed list and it is stated rather
 * than hidden. What the design does about it:
 *
 * - **It fails loudly at the new task, not silently in the seed.** The new
 *   colour's startup migrations create the table (they are the same migrations
 *   the source ran), so the table exists and is empty. An empty table that
 *   should have had rows is a missing-record bug with a clear first symptom:
 *   the seeded keys/budgets are there and the new table's rows are not, which
 *   is a question about the *upgrade* rather than a corruption nobody can
 *   locate. Decision 18's rejected alternative -- `--exclude-table-data` over
 *   everything -- has the same gap with a bigger blast radius.
 * - **The upgrade PR is where it is checked**, and `BIFROST_SEED_UPSTREAM_TAG`
 *   below is the tripwire: a bump that does not update it fails
 *   `bifrost-seed-image.test.ts`, which is the reminder to re-read this list
 *   against the new tag. That is a mechanical prompt, not a guarantee, and the
 *   test's message says so.
 * - **The check itself is one command** against the pinned tag, recorded in
 *   `seed-tables.test.ts` so the next person runs the same one rather than
 *   re-deriving it:
 *
 *       git -C <bifrost checkout> grep -ho 'return "[a-z_0-9]*"'
 *         -- framework/configstore/tables/ | sed 's/return "//;s/"//' | sort -u
 *
 *   The two raw-SQL tables (`governance_virtual_key_keys` is created and then
 *   dropped by later migrations; `distributed_locks`, `sidekiq` and
 *   `batch_jobs` are created by `CREATE TABLE IF NOT EXISTS` in
 *   `framework/configstore/migrations.go`) do **not** appear in that grep, which
 *   is why `SEED_TABLES` is not just the grep's output: `distributed_locks`,
 *   `sidekiq` and `batch_jobs` have a `TableName()` too, and the list below is
 *   the union checked table by table in the test.
 *
 * ### The cost if this list is wrong
 *
 * A **missing** table is a colour with missing records for that table: the new
 * task starts, its migrations do not re-run the copied ones, and the table sits
 * empty until something writes to it. The failure is discoverable (the records
 * are absent, and the source still has them) and the recovery is a re-seed with
 * an amended list, which is a `SEED_TABLES` override on the next run rather
 * than a code change. An **extra** table is a copy of data the colour does not
 * read: bounded by that table's size on a 20 GiB volume, and the log store's
 * largest tables are the ones decision 18 is about, so the extra-table case is
 * the expensive one and the reason the log tables are asserted absent by name.
 */

/**
 * The pinned upstream tag this list was taken from.
 *
 * The tripwire for the section above: bumping `BIFROST_UPSTREAM_TAG` in
 * `bifrost-image.ts` without revisiting this list fails
 * `bifrost-seed-image.test.ts`, which is the reminder to re-derive the list
 * against the new tag. It is the tag, not this file's own name, so a bump that
 * changes nothing about the config store still has to be acknowledged.
 */
export const SEED_TABLES_UPSTREAM_TAG = "v2.3.2";

/**
 * The log-store tables, which share the database today and must not travel.
 *
 * Not copied (decision 18): the new colour never reads its own copy, and these
 * are the largest objects on the volume. The config store's and the log store's
 * migration step IDs are disjoint but they share one `migrations` table, so a
 * whole-database dump is the only other option that keeps the ledger intact --
 * and it is the one that copies the log rows.
 *
 * Listed by name so a test can assert none of them appear in `SEED_TABLES`,
 * rather than leaving "the log store's tables" as an idea.
 */
export const LOG_STORE_TABLES = [
  "logs",
  "agent_logs",
  "mcp_tool_logs",
  "async_jobs",
  "webhook_deliveries",
  "warp_conversations",
  "warp_messages",
  // Created by raw DDL in `framework/logstore/matviewrefreshstate.go`, so it has
  // no `TableName()` and would be missed by any enumeration that only greps
  // for one. It is the log store's materialized-view refresh bookkeeping.
  "matview_refresh_state",
] as const;

/**
 * The shared migration ledger. The one table both stores write to, and the one
 * that makes the copy a *migrated* schema (decision 18): the new task's startup
 * migrations see the copied IDs and apply only what its own image adds.
 */
export const MIGRATIONS_TABLE = "migrations";

/**
 * The config store's own tables: the 66 `TableName()` methods in
 * `framework/configstore/tables/` at `v2.3.2`, plus `migrations`.
 *
 * Sorted, because the script carries the same list and an unsorted comparison
 * would make a one-line addition a reordering of the whole file.
 */
export const SEED_TABLES = [
  "batch_jobs",
  "config_agent_push_configs",
  "config_agent_push_deliveries",
  "config_agent_registrations",
  "config_client",
  "config_env_keys",
  "config_hashes",
  "config_keys",
  "config_log_store",
  "config_mcp_clients",
  "config_models",
  "config_plugins",
  "config_providers",
  "config_vector_store",
  "config_webhook_endpoints",
  "distributed_locks",
  "enterprise_mcp_tool_group_virtual_keys",
  "enterprise_mcp_tool_groups",
  "feature_flags",
  "folders",
  "framework_configs",
  "governance_budgets",
  "governance_config",
  "governance_customers",
  "governance_model_configs",
  "governance_model_parameters",
  "governance_model_pricing",
  "governance_pricing_overrides",
  "governance_rate_limits",
  "governance_teams",
  "governance_virtual_key_agent_grants",
  "governance_virtual_key_mcp_configs",
  "governance_virtual_key_provider_config_keys",
  "governance_virtual_key_provider_configs",
  "governance_virtual_keys",
  "mcp_library",
  "mcp_oauth_flows",
  "mcp_oauth_tokens",
  "mcp_per_user_header_credentials",
  "mcp_per_user_header_flows",
  "migrations",
  "notifications",
  "oauth2_authorize_requests",
  "oauth2_clients",
  "oauth2_refresh_tokens",
  "oauth_configs",
  "oauth_tokens",
  "oauth_user_sessions",
  "oauth_user_tokens",
  "prompt_session_messages",
  "prompt_sessions",
  "prompt_version_messages",
  "prompt_versions",
  "prompts",
  "provider_objects",
  "routing_rules",
  "routing_targets",
  "rss_feeds",
  "sessions",
  "sidekiq",
  "skill_file_blobs",
  "skill_files",
  "skill_versions",
  "skills",
  "temp_tokens",
  "warp_config",
  "webhook_jobs",
] as const;

/**
 * The tables the colour cannot be usable without, named separately so a test
 * can assert each one is in `SEED_TABLES`.
 *
 * These are decision 18's own examples and the plan's success criteria: a
 * virtual key that existed before the deploy still works after it, with the
 * usage it had, and the ledger records the created table.
 */
export const REQUIRED_SEED_TABLES = [
  "governance_budgets",
  "governance_virtual_keys",
  "governance_teams",
  "config_providers",
  "config_keys",
  MIGRATIONS_TABLE,
] as const;
