#!/bin/sh
# Seeds the inactive Bifrost colour's config store from the active one. Step 2 of
# docs/bifrost-zero-downtime-deploys.md, and decisions 3 and 18-19 are the ones
# that shape it.
#
# It runs as a one-off ECS task in the gateway's own cluster (decision 16), on a
# derived image (decision 17) because `pg_dump` and `psql` are not in the pinned
# Bifrost image. Nothing calls it in this step: it is run by hand, and step 4 is
# what wires it into a deploy.
#
# ## What it copies, and why not the whole database
#
# The config store's own tables plus the shared `migrations` table (decision 18).
# The log store shares the database today, and its tables are the largest thing
# on a 20 GiB volume; copying them would put the same rows twice on the volume
# for a colour that never reads its own copy. `migrations` is copied because the
# config store and the log store share one migration ledger: carrying it over
# records the copied schema as already migrated, so the new task's startup
# migrations apply only what its own image adds.
#
# ## Why a dump and not a server-side copy
#
# `CREATE DATABASE bifrost_green TEMPLATE bifrost_blue` is the cheap copy and it
# is not usable (decision 3): Postgres refuses it while any session is connected
# to the template, and the template is the database the serving task has open. A
# `pg_dump` runs in one repeatable-read, read-only transaction, which is a
# consistent snapshot of a database that is being written to -- and it holds no
# lock the serving task would notice. That is the whole reason this script exists.
#
# ## Convergent, not one-shot (decision 19)
#
# `CREATE DATABASE` cannot run in a transaction, and it needs `CREATEDB`, which
# the RDS master user has -- so it is its own statement, before the restore, and
# the restore is the transaction (`psql --single-transaction`; see the note above
# the restore). The three cases:
#
#   - target missing          -> create it, restore into it;
#   - target present, with no rows -> restore into it. This is the half-restored
#                                database a failed deploy leaves, because the
#                                restore is one transaction and therefore rolls
#                                back to this shape; the retry is the next
#                                deploy rather than a human with a `DROP
#                                DATABASE`;
#   - target present, with rows -> refuse. A colour with content is either one
#                                something is serving from or one a human seeded
#                                on purpose, and neither is ours to overwrite.
#
# A target with a schema and no rows is a failed restore, so it is dropped and
# recreated; a target with a schema *and* rows is refused. The refusal is only
# reachable for rows this script did not write, because its own restore cannot
# leave any: that is the property `--single-transaction` gives it.
#
# It connects with the same credentials the gateway's task uses, and the names do
# not line up by themselves: the task definition injects `PG_HOST`, `PG_PORT`,
# `PG_USER` and `PG_PASSWORD` (Bifrost's `config.json` reads those), while libpq --
# which `psql` and `pg_dump` use -- reads `PGHOST`, `PGPORT`, `PGUSER` and
# `PGPASSWORD`. So the mapping below is load-bearing: without it libpq ignores
# every one of them and falls back to a local Unix socket that does not exist in
# the container, and `set -e` stops the run on its first statement. It is
# exported once, here, rather than the task definition being changed to a second
# set of names: the gateway's names are the ones `config.json` documents, and a
# seed that spoke a different dialect would be the third connection mechanism
# this avoids.
#
# There is no connection string and no URL, because either would put the password
# in the process's arguments where `ps` can read it.
#
# It never prints the password. Only statuses, timings and the server's own error
# text reach the log.
set -eu

# The task definition's names are not libpq's. See above.
if [ -n "${PG_HOST:-}" ]; then export PGHOST="$PG_HOST"; fi
if [ -n "${PG_PORT:-}" ]; then export PGPORT="$PG_PORT"; fi
if [ -n "${PG_USER:-}" ]; then export PGUSER="$PG_USER"; fi
if [ -n "${PG_PASSWORD:-}" ]; then export PGPASSWORD="$PG_PASSWORD"; fi

log() { printf 'bifrost-seed: %s\n' "$*"; }
fail() { printf 'bifrost-seed: error: %s\n' "$*" >&2; exit 1; }

# Milliseconds since boot, from /proc/uptime.
#
# Not `date +%s%N` and not `$SECONDS`: the pinned image's userland is Alpine's
# busybox, whose `date` prints a literal `%N` rather than nanoseconds and whose
# ash leaves `SECONDS` unset. Both were checked against the arm64 busybox in
# `maximhq/bifrost:v2.3.2` rather than assumed, and both would have reported a
# dump that took zero seconds.
now_ms() {
  awk 'BEGIN {
    getline line < "/proc/uptime"
    close("/proc/uptime")
    split(line, parts, " ")
    printf "%d", parts[1] * 1000
  }'
}

elapsed_seconds() { awk -v from="$1" -v to="$2" 'BEGIN { printf "%.2f", (to - from) / 1000 }'; }

# The log store's tables, as a space-separated list, so the post-restore check
# can tell "a table the seed forgot" from "a log-store table that arrived some
# other way". These are `LOG_STORE_TABLES` in `seed-tables.ts`; the pair is kept
# in step by `bifrost-seed-image.test.ts` and `seed.test.ts`.
LOG_STORE_TABLES_ALLOWED='logs agent_logs mcp_tool_logs async_jobs webhook_deliveries warp_conversations warp_messages matview_refresh_state'

SOURCE="${SEED_SOURCE_DATABASE:-}"
TARGET="${SEED_TARGET_DATABASE:-}"

[ -n "$SOURCE" ] || fail "SEED_SOURCE_DATABASE is not set; it names the active colour's database"
[ -n "$TARGET" ] || fail "SEED_TARGET_DATABASE is not set; it names the inactive colour's database"

# Every statement that names a database interpolates it, because `psql -c` and
# `pg_dump -d` cannot parameterize an identifier. This allowlist is what keeps
# that safe, and it runs before anything else touches the server.
is_identifier() {
  case "$1" in
    "" | *[!a-z0-9_]* ) return 1 ;;
    [0-9]* ) return 1 ;;
    * ) return 0 ;;
  esac
}
is_identifier "$SOURCE" || fail "source database '$SOURCE' is not a plain lower-case identifier"
is_identifier "$TARGET" || fail "target database '$TARGET' is not a plain lower-case identifier"

[ "$SOURCE" != "$TARGET" ] || fail "source and target are both '$SOURCE'; a colour cannot seed itself, and dropping the database the serving task has open is the one thing this must not do"

# The table set, decision 18. Overridable so the tests can drive a smaller one
# and so an operator can add a table without rebuilding the image, but the
# default is the list this deployment ships and `seed-tables.ts` is the record
# of where it came from.
SEED_TABLES_DEFAULT='batch_jobs config_agent_push_configs config_agent_push_deliveries config_agent_registrations config_client config_env_keys config_hashes config_keys config_log_store config_mcp_clients config_models config_plugins config_providers config_vector_store config_webhook_endpoints distributed_locks enterprise_mcp_tool_group_virtual_keys enterprise_mcp_tool_groups feature_flags folders framework_configs governance_budgets governance_config governance_customers governance_model_configs governance_model_parameters governance_model_pricing governance_pricing_overrides governance_rate_limits governance_teams governance_virtual_key_agent_grants governance_virtual_key_mcp_configs governance_virtual_key_provider_config_keys governance_virtual_key_provider_configs governance_virtual_keys mcp_library mcp_oauth_flows mcp_oauth_tokens mcp_per_user_header_credentials mcp_per_user_header_flows migrations notifications oauth2_authorize_requests oauth2_clients oauth2_refresh_tokens oauth_configs oauth_tokens oauth_user_sessions oauth_user_tokens prompt_session_messages prompt_sessions prompt_version_messages prompt_versions prompts provider_objects routing_rules routing_targets rss_feeds sessions sidekiq skill_file_blobs skill_files skill_versions skills temp_tokens warp_config webhook_jobs'

TABLES="${SEED_TABLES:-$SEED_TABLES_DEFAULT}"
[ -n "$TABLES" ] || fail "the table list is empty"

for name in $TABLES; do
  is_identifier "$name" || fail "table '$name' is not a plain lower-case identifier"
done

log "source database: $SOURCE"
log "target database: $TARGET"
log "copying $(printf '%s\n' $TABLES | wc -l | tr -d ' ') tables"

# pgbool: -t on a missing database fails, so the existence read goes through the
# maintenance database, which always exists.
exists() {
  psql --no-psqlrc --quiet --no-align --tuples-only \
    -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$1'"
}

# `pg_dump -t` on a missing table is not an error when at least one `-t`
# matched: it silently produces a dump without that table, which is exactly the
# silent-miss the table set's ruling forbids. Measured against PostgreSQL 16
# (`pg_dump -t governance_budgets -t no_such_table` exits 0 with a valid dump of
# the one table). So the dump's own success says nothing about whether every
# listed table was found, and the two checks below are what turn a drifted list
# into a failed run. Both run on the **source**, before this script writes
# anything:
#
#   1. every listed table must exist in the source, because otherwise the table
#      set is wrong about the store it is reading;
#   2. every table in the source must be one the seed accounts for: listed, or
#      one of the log store's. A table that is neither is a table Bifrost added,
#      which this image's list predates -- the case an upstream bump creates. It
#      fails unless `SEED_ALLOW_UNCOPIED_TABLES=1` says a human looked.
for name in $TABLES; do
  found="$(psql --no-psqlrc --quiet --no-align --tuples-only -d "$SOURCE" -c \
    "SELECT to_regclass('public.$name') IS NOT NULL")"
  [ "$found" = "t" ] \
    || fail "source database '$SOURCE' has no table '$name'. The table list is wrong about this store: re-derive it and update SEED_TABLES_DEFAULT (see seed-tables.ts)."
done

# The second check, on the **source** rather than the copy, and it is the one
# that matters across an upstream bump: every table in the active store has to be
# one the seed accounts for -- a config-store table it copies, or a log-store
# table it deliberately does not. A table that is neither is a table Bifrost
# added, which means this image's list predates the release that migrated the
# store, and copying only the listed ones would leave the new colour with that
# table empty.
#
# Checked on the source because that is where the fact lives. The target is
# created, or dropped and recreated, by this script, so a comparison against the
# copy can only ever see what the restore itself put there; the source carries
# the release's real schema. Doing it here also means the seed refuses before it
# writes anything, rather than reporting a problem after a restore that looked
# successful.
#
# `SEED_ALLOW_UNCOPIED_TABLES=1` is the escape hatch: a legitimate new table
# would otherwise block every deploy between the bump and the list being updated,
# and an operator who has looked at the table and decided it may start empty
# needs a way to say so for one run.
if [ "${SEED_ALLOW_UNCOPIED_TABLES:-0}" = "1" ]; then
  log "SEED_ALLOW_UNCOPIED_TABLES=1: not checking the source for tables the seed does not copy"
else
  unaccounted="$(psql --no-psqlrc --quiet --no-align --tuples-only -d "$SOURCE" -c "
    WITH listed(t) AS (SELECT unnest(string_to_array('$TABLES', ' '))),
         log_store(t) AS (SELECT unnest(string_to_array('$LOG_STORE_TABLES_ALLOWED', ' ')))
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname NOT IN (SELECT t FROM listed UNION SELECT t FROM log_store)
    ORDER BY 1
  ")" || fail "could not list the source's tables; refusing to guess whether the seed covers them"
  if [ -n "$unaccounted" ]; then
    fail "source database '$SOURCE' has tables this seed does not account for: $(printf '%s' "$unaccounted" | tr '\n' ' '). They are neither copied nor one of the log store's, which means Bifrost gained a config-store table and this image's list predates it, so the colour would be missing their rows. Re-derive SEED_TABLES (see seed-tables.ts) and rebuild the image, or set SEED_ALLOW_UNCOPIED_TABLES=1 if a human has looked and the tables may start empty."
  fi
  log "every table in '$SOURCE' is one the seed copies or one of the log store's"
fi

target_exists="$(exists "$TARGET")"

if [ "$target_exists" = "1" ]; then
  probe="$(psql --no-psqlrc --quiet --no-align --tuples-only -d "$TARGET" \
    -c "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public')")"
  if [ "$probe" = "t" ]; then
    # At least one table. It is a failed restore only if every one of them is
    # empty; anything else is refused.
    #
    # One query of `EXISTS (SELECT 1 FROM t)` arms joined with `OR`, built by the
    # server so `format('%I')` quotes the identifiers. Each arm is a sub-select
    # rather than a `LIMIT`ed `SELECT` joined with `UNION ALL`: PostgreSQL rejects
    # `LIMIT` in the middle of a `UNION` without per-arm parentheses, and the
    # first version of this did exactly that -- so it worked on a target with one
    # table and was a syntax error on a target with two, which is every real
    # one. `OR` short-circuits, so the cost is one row from the first non-empty
    # table.
    probe_sql="$(psql --no-psqlrc --quiet --no-align --tuples-only -d "$TARGET" -c "
      SELECT coalesce(
        string_agg(format('EXISTS (SELECT 1 FROM %I.%I)', schemaname, tablename), ' OR '),
        'false'
      )
      FROM pg_tables WHERE schemaname = 'public'
    ")"
    if [ -z "$probe_sql" ]; then
      fail "could not build the emptiness probe for '$TARGET'; refusing to guess whether it has content"
    fi
    # No `ON_ERROR_STOP` excuse here: a probe that cannot run has to stop the
    # seed, because reading a failed query as "empty" is how a target with rows
    # gets dropped.
    populated="$(psql --no-psqlrc --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -d "$TARGET" -c "SELECT ${probe_sql}")" \
      || fail "the emptiness probe for '$TARGET' did not run; refusing to guess whether it has content"
    case "$populated" in
      t | f ) : ;;
      * ) fail "the emptiness probe for '$TARGET' returned '$populated', which is neither t nor f; refusing to guess whether it has content" ;;
    esac
    if [ "$populated" = "t" ]; then
      fail "target database '$TARGET' already has content; refusing to overwrite it. If it is a failed deploy's half-restored copy, drop it and re-run; if it is a colour, the seed target is wrong."
    fi
    log "target '$TARGET' exists with a schema and no rows: a failed restore, so it is recreated"
    psql --no-psqlrc --quiet -d postgres -c "DROP DATABASE \"$TARGET\""
    target_exists=""
  else
    # A database with no tables at all is empty: created but never restored
    # into. It is seeded rather than reset, which is the same outcome with one
    # statement fewer.
    log "target '$TARGET' exists with no tables; seeding into it"
  fi
fi

if [ "$target_exists" != "1" ]; then
  log "creating database '$TARGET'"
  # Its own statement, outside any transaction, because CREATE DATABASE cannot
  # run inside one (decision 19).
  psql --no-psqlrc --quiet -d postgres -c "CREATE DATABASE \"$TARGET\""
fi

# The dump: one repeatable-read, read-only transaction over only these tables,
# which is pg_dump's own default and is what makes it a consistent snapshot
# while the serving task keeps writing. `--no-owner` because the target's owner
# is whatever the connect user is, and the source's owner is not relevant to a
# copy; `--no-privileges` for the same reason.
table_args=""
for name in $TABLES; do
  table_args="$table_args --table=$name"
done

# The template ends in `XXXXXX` and has no suffix after it, which is busybox's
# rule rather than coreutils': the image's userland is Alpine, whose `mktemp`
# refuses any template that does not end in exactly `XXXXXX` (measured: `mktemp
# /tmp/x-XXXXXX.sql` exits 1 with `mktemp: (null): Invalid argument`, while
# `mktemp /tmp/x-XXXXXX` works). The `.sql` suffix this used to carry was
# harmless on a GNU userland and a failure on the one that actually runs. The
# file is read-only to its owner and removed by the trap on every exit path.
dump_file="$(mktemp /tmp/bifrost-seed-XXXXXX)"
chmod 0600 "$dump_file"
trap 'rm -f "$dump_file"' EXIT

log "dumping '$SOURCE' (one repeatable-read transaction)"
dump_start="$(now_ms)"
# shellcheck disable=SC2086
pg_dump --no-owner --no-privileges $table_args -d "$SOURCE" -f "$dump_file"
dump_end="$(now_ms)"
dump_seconds="$(elapsed_seconds "$dump_start" "$dump_end")"
log "dump took ${dump_seconds}s ($(wc -c < "$dump_file" | tr -d ' ') bytes)"

restore_start="$(now_ms)"
# `--single-transaction` is what makes "the restore is the transaction" true.
# Plain `pg_dump` output carries no `BEGIN`/`COMMIT` (measured: zero of either in
# a dump of two tables), so without this every statement commits as it runs --
# and because data is loaded before the post-data section (constraints, indexes,
# foreign keys), a failure after the first `COPY` leaves rows behind. The next
# run's emptiness probe would then correctly see content and refuse, so the retry
# decision 19 promises would need a human with `DROP DATABASE`. With this flag a
# failed restore rolls back to the schema-less or row-less shapes the script
# already resets, which is the convergent behaviour.
#
# `ON_ERROR_STOP` so a statement that fails stops rather than being skipped and
# reported as success; `-o /dev/null` because the dump's leading `set_config`
# calls return rows and their output is noise rather than evidence.
psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction -o /dev/null -d "$TARGET" -f "$dump_file"
restore_end="$(now_ms)"
restore_seconds="$(elapsed_seconds "$restore_start" "$restore_end")"
log "restore took ${restore_seconds}s"

# The evidence the plan asks step 2 for: the dump's wall clock is the number the
# overlap estimate in "Consequences" is missing.
log "seed complete: dump ${dump_seconds}s, restore ${restore_seconds}s"
