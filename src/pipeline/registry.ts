import { readdirSync } from "fs";
import { join, resolve } from "path";
import type { SourceAdapter } from "./types";

const adapters = new Map<string, SourceAdapter>();

export function registerAdapter(adapter: SourceAdapter): void {
  if (adapters.has(adapter.name)) {
    console.error(`[Pipeline] Error: adapter "${adapter.name}" already registered, skipping duplicate`);
    return;
  }
  adapters.set(adapter.name, adapter);
}

export function getAdapter(name: string): SourceAdapter | undefined {
  return adapters.get(name);
}

export function listAdapters(): SourceAdapter[] {
  return Array.from(adapters.values());
}

async function loadAdaptersFrom(dir: string, label: string): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".ts") || f.endsWith(".js"));
  } catch (err) {
    console.error(`[Pipeline] Warning: could not read ${label} directory "${dir}": ${err}`);
    return;
  }

  for (const file of files) {
    const filePath = resolve(join(dir, file));
    try {
      const mod = await import(filePath);
      const adapter = mod.default;
      if (adapter && typeof adapter.name === "string" && typeof adapter.export === "function") {
        registerAdapter(adapter);
        console.error(`[Pipeline] Loaded adapter: ${adapter.name} from ${filePath}`);
      } else {
        console.error(`[Pipeline] Warning: ${filePath} does not export a valid SourceAdapter, skipping`);
      }
    } catch (err) {
      console.error(`[Pipeline] Warning: failed to import ${filePath}: ${err}`);
    }
  }
}

export async function loadAdapters(): Promise<void> {
  // 1. Built-in adapters
  const builtinDir = resolve(join(import.meta.dir, "..", "adapters"));
  await loadAdaptersFrom(builtinDir, "built-in");

  // 2. External adapters from RAG_ADAPTERS_PATH
  const externalDir = process.env.RAG_ADAPTERS_PATH;
  if (externalDir) {
    await loadAdaptersFrom(resolve(externalDir), "external (RAG_ADAPTERS_PATH)");
  }
}
