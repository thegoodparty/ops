import type { AgentConfig } from "./types";

const agents = new Map<string, AgentConfig>();

export const defineAgent = (config: AgentConfig): AgentConfig => {
  agents.set(config.name, config);
  return config;
};

export const getAgent = (name: string): AgentConfig => {
  const agent = agents.get(name);
  if (!agent) {
    const available = [...agents.keys()].join(", ");
    throw new Error(
      `Agent "${name}" not found. Available: ${available}`
    );
  }
  return agent;
};

export const listAgents = (): string[] => [...agents.keys()];
