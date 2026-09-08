import type { CustomCommand } from "./types";

// Project definitions override app-wide definitions; management still lists both.
export function effectiveCommands(commands: CustomCommand[]): CustomCommand[] {
  const byName = new Map<string, CustomCommand>();
  for (const c of commands) if (!byName.has(c.name) || c.project_id !== null) byName.set(c.name, c);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCommand(message: string, commands: CustomCommand[], task: { title: string; description: string }): string {
  const match = message.trim().match(/^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/);
  if (!match) return message;
  const command = effectiveCommands(commands).find((c) => c.name === match[1]);
  if (!command) return message;
  const args = match[2] ?? "";
  const values: Record<string, string> = { args, "task.title": task.title, "task.description": task.description };
  // One pass: placeholders in user arguments/task text are never evaluated.
  const expanded = command.body.replace(/{{(args|task\.title|task\.description)}}/g, (_, key: string) => values[key]);
  return !command.body.includes("{{args}}") && args ? `${expanded}\n\n${args}` : expanded;
}
