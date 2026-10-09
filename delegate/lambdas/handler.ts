import { handleGithub } from "./github";

type FunctionURLEvent = {
  rawPath: string;
  body?: string;
  headers: Record<string, string>;
};

type RouteHandler = (
  body: string,
  headers: Record<string, string>,
) => Promise<{
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
}>;

const routes: Record<string, RouteHandler> = {
  "/github": handleGithub,
};

export const handler = async (event: FunctionURLEvent) => {
  const route = routes[event.rawPath];

  if (!route) {
    return {
      statusCode: 404,
      body: `Unknown path: ${event.rawPath}. Available: ${Object.keys(
        routes,
      ).join(", ")}`,
    };
  }

  try {
    return await route(event.body ?? "{}", event.headers);
  } catch (err) {
    console.error(`Error handling ${event.rawPath}:`, err);
    return { statusCode: 500, body: "internal error" };
  }
};
