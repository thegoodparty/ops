// Structured stderr, one line per event.
//
// Nine modules had grown a byte-identical copy of this, which is what
// parallel authorship produces: each correctly declined to reach into
// another module's file to share a helper. It matters that there is one
// now, because these currently resolve to console.error into a log group
// nothing reads. When something does read them — a metric filter, an
// alarm, anywhere that is not a log — this is the single place that
// changes, rather than nine.
//
// `alarm` is a failure nobody asked for. `log` is a thing that happened,
// including a transition a module refused on purpose. That distinction is
// the whole value of the level, so keep it: an alarm that fires on normal
// operation teaches people to ignore alarms.

type Data = Record<string, unknown>;

const emit =
  (stream: (line: string) => void, component: string, level: string) =>
  (event: string, data?: Data) =>
    stream(JSON.stringify({ component, level, event, ...data }));

export const makeAlarm = (component: string) =>
  emit((line) => console.error(line), component, "error");

export const makeLog = (component: string) =>
  emit((line) => console.log(line), component, "info");
