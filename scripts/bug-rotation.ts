import { WebClient } from "@slack/web-api";
import dayjs from "dayjs";
import isBetween from "dayjs/plugin/isBetween";

dayjs.extend(isBetween);

process.env.TZ = "America/New_York";

/**
 * Add overrides here to manually set the rotation dev for a given period.
 */
const OVERRIDES: {
  /** YYYY-MM-DD */
  start: string;
  /** YYYY-MM-DD */
  end: string;
  dev: DevName;
}[] = [];

const slack = new WebClient(process.env.SLACK_ADMIN_USER_TOKEN);

const SERVE_BUGS = "S0AD54G9D3K";

const START = dayjs("2026-01-16T12:00:00");

const USERMAP = {
  Collin: "U091FTXJ5DZ",
  Nikao: "U06EH0H6H8R",
  Stephen: "U09F6R9QA9G",
  Swain: "U09HGPTHHAT",
} as const;

type DevName = keyof typeof USERMAP;

const DEVS = Object.keys(USERMAP).sort() as DevName[];

const now = dayjs();

const getCurrentRotationDev = () => {
  const override = OVERRIDES.find((o) =>
    now.isBetween(`${o.start}T12:00:00`, `${o.end}T11:59:59`)
  );
  if (override) {
    console.log(
      `Override: ${override.dev} from ${override.start} to ${override.end}`
    );
    return override.dev;
  }
  const weeksSinceStart = now.diff(START, "week");
  const rotationIndex = Math.floor(weeksSinceStart / 2);
  return DEVS[rotationIndex % DEVS.length];
};

export default async () => {
  const dev = getCurrentRotationDev();

  console.log(`Current Rotation Dev: ${dev}`);

  const groups = await slack.usergroups.list({ include_users: true });

  const group = groups.usergroups?.find((g) => g.id === SERVE_BUGS);

  if (!group) {
    throw new Error(`Group ${SERVE_BUGS} not found`);
  }

  if (group.users?.includes(USERMAP[dev])) {
    console.log(`${dev} is already in the group, nothing to do`);
    return;
  }

  await slack.usergroups.users.update({
    usergroup: SERVE_BUGS,
    users: USERMAP[dev],
  });

  console.log("✅ Slack User Group Updated");
};
