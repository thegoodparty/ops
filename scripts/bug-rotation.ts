import { WebClient } from "@slack/web-api";
import dayjs from "dayjs";
import isBetween from "dayjs/plugin/isBetween";

dayjs.extend(isBetween);

process.env.TZ = "America/New_York";

const {
  SLACK_ADMIN_USER_TOKEN,
  SLACK_USERGROUP_ID,
  ROTATION_START,
  ROTATION_CADENCE_WEEKS = "2",
  USERMAP_JSON,
  OVERRIDES_JSON = "[]",
} = process.env;

if (!SLACK_ADMIN_USER_TOKEN) {
  throw new Error("Missing SLACK_ADMIN_USER_TOKEN");
}
if (!SLACK_USERGROUP_ID) {
  throw new Error("Missing SLACK_USERGROUP_ID");
}
if (!ROTATION_START) {
  throw new Error("Missing ROTATION_START");
}
if (!USERMAP_JSON) {
  throw new Error("Missing USERMAP_JSON");
}


let USERMAP: Record<string, string>;
try {
  USERMAP = JSON.parse(USERMAP_JSON)
} catch (error) {
  throw new Error(
    `USERMAP_JSON must be valid JSON. Received: ${USERMAP_JSON}`
  );
}

type DevName = keyof typeof USERMAP;

const DEVS = Object.keys(USERMAP).sort() as DevName[];
if (DEVS.length === 0) {
  throw new Error("USERMAP_JSON must contain at least 1 dev");
}

const START = dayjs(`${ROTATION_START}T12:00:00`);
if (!START.isValid()) {
  throw new Error(
    `ROTATION_START must be a YYYY-MM-DD. Received: ${ROTATION_START}`
  )
}

const CADENCE_WEEKS = Number(ROTATION_CADENCE_WEEKS);
if (Number.isNaN(CADENCE_WEEKS) || CADENCE_WEEKS <= 0) {
  throw new Error("ROTATION_CADENCE_WEEKS must be a positive number");
}


/**
 * Add overrides here to manually set the rotation dev for a given period.
 */
type Override = {
  /** YYYY-MM-DD */
  start: string;
  /** YYYY-MM-DD */
  end: string;
  dev: DevName;
};

let OVERRIDES: Override[];
try {
  OVERRIDES = JSON.parse(OVERRIDES_JSON);
} catch {
  throw new Error(
    `OVERRIDES_JSON must be valid JSON. Received: ${OVERRIDES_JSON}`
  );
}
if (!Array.isArray(OVERRIDES)) {
  throw new Error(
    `OVERRIDES_JSON must be a JSON array. Received: ${OVERRIDES_JSON}`
  );
}

for (const o of OVERRIDES) {
  const start = dayjs(`${o.start}T12:00:00`);
  const end = dayjs(`${o.end}T11:59:59`);

  if (!start.isValid() || !end.isValid()) {
    throw new Error(
      `Override dates must be YYYY-MM-DD. Received: start=${o.start}, end=${o.end}`
    );
  }
  if (end.isBefore(start)) {
    throw new Error(
      `Override end must be >= start. Received: start=${o.start}, end=${o.end}`
    );
  }
  if (!(o.dev in USERMAP)) {
    throw new Error(
      `Override dev must be a key in USERMAP_JSON. Received dev="${String(
        o.dev
      )}"`
    );
  }
}

const slack = new WebClient(process.env.SLACK_ADMIN_USER_TOKEN);
const now = dayjs();


const getCurrentRotationDev = (): DevName => {
  // Overrides take precedence
  const override = OVERRIDES.find((o) =>
    now.isBetween(`${o.start}T12:00:00`, `${o.end}T11:59:59`, null, "[]")
  );

  if (override) {
    console.log(
      `Override active: ${override.dev} (${override.start} → ${override.end})`
    );
    return override.dev;
  }

  // Default rotation logic — use day-based math to avoid time-of-day edge cases
  const rawDaysSinceStart = now.startOf("day").diff(START.startOf("day"), "day");
  if (rawDaysSinceStart < 0) {
    console.warn(
      `⚠️  Current date is before ROTATION_START (${ROTATION_START}), defaulting to first dev`
    );
  }
  // Clamp to 0 so dates before ROTATION_START fall into the first rotation slot
  // (JS `%` preserves the dividend's sign, so a negative index would yield undefined)
  const daysSinceStart = Math.max(0, rawDaysSinceStart);
  const weeksSinceStart = Math.floor(daysSinceStart / 7);
  const rotationIndex = Math.floor(weeksSinceStart / CADENCE_WEEKS);
  return DEVS[rotationIndex % DEVS.length];
};

export default async () => {
  const dev = getCurrentRotationDev();
  const userId = USERMAP[dev];

  console.log(`Current Rotation Dev: ${dev}`);

  const groups = await slack.usergroups.list({ include_users: true });
  const group = groups.usergroups?.find((g) => g.id === SLACK_USERGROUP_ID);

  if (!group) {
    throw new Error(`Group ${SLACK_USERGROUP_ID} not found`);
  }

  // If the group already contains the correct user, do nothing.
  if (group.users?.includes(userId)) {
    console.log(`${dev} is already in the group, nothing to do`);
    return;
  }

  await slack.usergroups.users.update({
    usergroup: SLACK_USERGROUP_ID,
    // NOTE: This sets the usergroup membership to exactly this user.
    users: userId,
  });

  console.log("✅ Slack User Group Updated");
};