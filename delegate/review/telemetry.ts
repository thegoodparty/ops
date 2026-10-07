export const emit = (event: string, fields: Record<string, unknown>): void => {
  console.log(JSON.stringify({ service_name: "delegate-reviewer", event, ...fields }));
};
