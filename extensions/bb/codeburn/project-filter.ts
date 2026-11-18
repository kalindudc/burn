import { randomBytes } from "node:crypto";
import { lstat, stat, readFile, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ProjectFilter = { project: string[]; exclude: string[] };

export function projectFilterPath(home = homedir()): string {
  return join(home, ".config", "codeburn", "app-filter.json");
}

export function normalizePatterns(value: unknown, home = homedir()): string[] {
  if (value === undefined) return [];
  const entries = typeof value === "string" ? [value] : value;
  if (!Array.isArray(entries) || entries.length > 100 || entries.some((entry) => typeof entry !== "string" || entry.length > 4096)) {
    throw new Error("Invalid CodeBurn project filter patterns");
  }
  const patterns = new Set<string>();
  for (const entry of entries as string[]) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const slash = trimmed.replace(/\\/g, "/");
    const expanded = slash === "~" || slash.startsWith("~/")
      ? home.replace(/\\/g, "/") + slash.slice(1) : trimmed;
    patterns.add(expanded);
  }
  return [...patterns];
}

export function normalizeProjectFilter(value: unknown, home = homedir()): ProjectFilter {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid CodeBurn project filter JSON object");
  }
  const fields = value as Record<string, unknown>;
  const filter = { project: normalizePatterns(fields.project, home), exclude: normalizePatterns(fields.exclude, home) };
  if (Buffer.byteLength([...filter.project, ...filter.exclude].join("\n")) > 32 * 1024) {
    throw new Error("CodeBurn project filter exceeds the safe CLI argument bound");
  }
  return filter;
}

export async function readProjectFilter(home = homedir()): Promise<ProjectFilter> {
  const path = projectFilterPath(home);
  let content: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("CodeBurn project filter must be a regular file below 1 MiB");
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      try {
        await lstat(path);
      } catch (missing) {
        if (missing !== null && typeof missing === "object" && "code" in missing && missing.code === "ENOENT") {
          return { project: [], exclude: [] };
        }
      }
    }
    throw new Error(`Could not read CodeBurn project filter ${path}; refusing unfiltered usage`, { cause: error });
  }
  try {
    return normalizeProjectFilter(JSON.parse(content), home);
  } catch (error) {
    throw new Error(`Invalid CodeBurn project filter ${path}; refusing unfiltered usage`, { cause: error });
  }
}

export async function writeProjectFilter(filter: ProjectFilter, home = homedir()): Promise<void> {
  const path = projectFilterPath(home);
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(filter, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function mergeProjectFilter(saved: ProjectFilter, selected: ProjectFilter): ProjectFilter {
  if (saved.project.length > 0 && selected.project.some((pattern) => !saved.project.includes(pattern))) {
    throw new Error("Temporary project selection cannot widen the saved project filter; select a saved pattern exactly");
  }
  return {
    project: selected.project.length > 0 ? selected.project : saved.project,
    exclude: [...new Set([...saved.exclude, ...selected.exclude])],
  };
}

export function projectFilterArgs(filter: ProjectFilter): string[] {
  if (Buffer.byteLength([...filter.project, ...filter.exclude].join("\n")) > 32 * 1024) {
    throw new Error("CodeBurn project selection exceeds the safe CLI argument bound");
  }
  return [
    ...filter.project.map((pattern) => `--project=${pattern}`),
    ...filter.exclude.map((pattern) => `--exclude=${pattern}`),
  ];
}
