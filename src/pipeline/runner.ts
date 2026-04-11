import { createHash } from "crypto";
import { loadAdapters, listAdapters, getAdapter } from "./registry";
import { filterChunks, validateChunks } from "./filter";
import { hashChunkPayload, type Chunk, type ExistingChunkRow } from "./types";
import { embedTexts } from "../knowledge";
import { insforge } from "../query";

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const QUERY_PAGE_SIZE = 1000;

// --- DB helpers (ported from embed-and-upload.ts) ---

async function getExistingChunkHashes(): Promise<Map<string, string>> {
  const { data, error } = await insforge.database
    .from("poc_kb_chunks")
    .select("id,title,question,answer,text_content,tags,source,parent_id,created_at,url");
  if (error) {
    console.error("Error fetching existing chunks:", error);
    return new Map();
  }
  return new Map(
    ((data || []) as ExistingChunkRow[]).map((row) => [row.id, hashChunkPayload(row)])
  );
}

async function deleteChunksByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const { error } = await insforge.database.from("poc_kb_chunks").delete().in("id", batch);
    if (error) throw new Error(`Delete batch failed: ${JSON.stringify(error)}`);
  }
}

async function deleteAllChunks(): Promise<void> {
  const allIds: string[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await insforge.database
      .from("poc_kb_chunks").select("id").range(offset, offset + QUERY_PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to fetch IDs: ${JSON.stringify(error)}`);
    if (!data || data.length === 0) break;
    allIds.push(...data.map((row: { id: string }) => row.id));
    if (data.length < QUERY_PAGE_SIZE) break;
    offset += QUERY_PAGE_SIZE;
  }
  if (allIds.length === 0) { console.error("No existing chunks to delete."); return; }
  console.error(`Deleting ${allIds.length} existing chunks...`);
  const DEL_BATCH = 50;
  for (let i = 0; i < allIds.length; i += DEL_BATCH) {
    const batch = allIds.slice(i, i + DEL_BATCH);
    const { error } = await insforge.database.from("poc_kb_chunks").delete().in("id", batch);
    if (error) throw new Error(`Delete batch failed: ${JSON.stringify(error)}`);
  }
  console.error(`Deleted ${allIds.length} chunks.`);
}

async function getRejectedChunkIds(): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await insforge.database
      .from("poc_kb_chunks").select("id").eq("status", "rejected")
      .range(offset, offset + QUERY_PAGE_SIZE - 1);
    if (error) { console.error("Warning: failed to snapshot rejected IDs:", error); return []; }
    if (!data || data.length === 0) break;
    ids.push(...data.map((row: { id: string }) => row.id));
    if (data.length < QUERY_PAGE_SIZE) break;
    offset += QUERY_PAGE_SIZE;
  }
  return ids;
}

async function restoreRejectedStatus(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  let restored = 0;
  const BATCH = 50;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const { data, error } = await insforge.database
      .from("poc_kb_chunks").update({ status: "rejected" })
      .in("id", batch).neq("status", "rejected").select("id");
    if (error) throw new Error(`Failed to restore rejected status: ${JSON.stringify(error)}`);
    restored += data?.length || 0;
  }
  return restored;
}

async function uploadBatch(chunks: Chunk[], embeddings: number[][]): Promise<void> {
  const rows = chunks.map((chunk, i) => ({
    id: chunk.id,
    title: chunk.title,
    question: chunk.metadata.question,
    answer: chunk.metadata.answer,
    text_content: chunk.content,
    tags: chunk.metadata.tags,
    source: chunk.source,
    parent_id: chunk.metadata.parent_id,
    created_at: chunk.metadata.created_at || null,
    url: chunk.metadata.url || null,
    embedding: JSON.stringify(embeddings[i]),
  }));
  const { error } = await insforge.database.from("poc_kb_chunks").insert(rows);
  if (error) throw new Error(`Insert failed: ${JSON.stringify(error)}`);
}

// --- CLI parsing ---

function parseCliArgs(): { adapterNames: string[]; inputPath: string | null; replace: boolean; listMode: boolean; help: boolean } {
  const args = process.argv.slice(2);
  const adapterNames: string[] = [];
  let inputPath: string | null = null;
  let replace = false;
  let listMode = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--adapter": adapterNames.push(args[++i]); break;
      case "--input": inputPath = args[++i]; break;
      case "--replace": replace = true; break;
      case "--list": listMode = true; break;
      case "--help": help = true; break;
    }
  }
  return { adapterNames, inputPath, replace, listMode, help };
}

const HELP_TEXT = `Usage: bun run src/pipeline/runner.ts [options]

Options:
  --adapter <name>    Run specific adapter(s). Repeat for multiple. Omit for all.
  --input <path>      Set INPUT_PATH in adapter config.
  --replace           Delete all chunks before import (full rebuild).
  --list              List available adapters and exit.
  --help              Show this help.

Environment:
  RAG_ADAPTERS_PATH   Directory of external adapter .ts/.js files to load.
  INSFORGE_URL        InsForge backend URL (required).
  INSFORGE_KEY        InsForge anon key (required).
`;

// --- Main ---

async function main() {
  const { adapterNames, inputPath, replace, listMode, help } = parseCliArgs();

  if (help) { console.error(HELP_TEXT); return; }

  await loadAdapters();
  const allAdapters = listAdapters();

  if (listMode) {
    console.error("Available adapters:");
    for (const a of allAdapters) {
      console.error(`  ${a.name}${a.description ? ` — ${a.description}` : ""}`);
    }
    return;
  }

  if (allAdapters.length === 0) {
    console.error("Error: no adapters loaded. Check RAG_ADAPTERS_PATH or src/adapters/.");
    process.exit(1);
  }

  // Resolve which adapters to run
  let selectedAdapters: import("./types").SourceAdapter[];
  if (adapterNames.length > 0) {
    selectedAdapters = [];
    for (const name of adapterNames) {
      const adapter = getAdapter(name);
      if (!adapter) {
        console.error(`Error: adapter "${name}" not found. Available: ${allAdapters.map(a => a.name).join(", ")}`);
        process.exit(1);
      }
      selectedAdapters.push(adapter);
    }
  } else {
    selectedAdapters = allAdapters;
  }

  // Build config
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) config[k] = v;
  }
  if (inputPath) config.INPUT_PATH = inputPath;

  // Run adapters
  console.error(`\nRunning ${selectedAdapters.length} adapter(s)...`);
  let allChunks: Chunk[] = [];

  for (const adapter of selectedAdapters) {
    console.error(`\n[${adapter.name}] Exporting...`);
    try {
      const chunks = await adapter.export(config);
      const valid = validateChunks(chunks, adapter.name);
      console.error(`[${adapter.name}] → ${valid.length} chunk(s)`);
      allChunks.push(...valid);
    } catch (err) {
      console.error(`[${adapter.name}] Error: ${err}`);
      console.error(`[${adapter.name}] Skipping this adapter.`);
    }
  }

  if (allChunks.length === 0) {
    console.error("\nNo chunks produced by any adapter. Nothing to do.");
    return;
  }

  // Dedupe by id (last write wins)
  const deduped = new Map<string, Chunk>();
  for (const chunk of allChunks) deduped.set(chunk.id, chunk);
  allChunks = Array.from(deduped.values());
  console.error(`\nTotal: ${allChunks.length} unique chunk(s) after dedup`);

  // Quality filter
  const filtered = filterChunks(allChunks);
  console.error(`After filter: ${filtered.length} chunk(s) (${allChunks.length - filtered.length} removed)`);

  // Snapshot rejected IDs
  const rejectedSnapshot = await getRejectedChunkIds();
  if (rejectedSnapshot.length > 0) {
    console.error(`Snapshot: ${rejectedSnapshot.length} rejected chunk(s) will be preserved`);
  }

  // Diff against DB
  let chunksToProcess: Chunk[];

  if (replace) {
    console.error("\nReplace mode: deleting all existing chunks...");
    await deleteAllChunks();
    chunksToProcess = filtered;
  } else {
    const existingHashes = await getExistingChunkHashes();
    const newChunks: Chunk[] = [];
    const changedChunks: Chunk[] = [];

    for (const chunk of filtered) {
      const existingHash = existingHashes.get(chunk.id);
      if (!existingHash) {
        newChunks.push(chunk);
      } else if (existingHash !== hashChunkPayload(chunk)) {
        changedChunks.push(chunk);
      }
    }

    if (changedChunks.length > 0) {
      console.error(`Refreshing ${changedChunks.length} changed chunk(s)...`);
      await deleteChunksByIds(changedChunks.map(c => c.id));
    }

    chunksToProcess = [...newChunks, ...changedChunks];
    const unchangedCount = filtered.length - chunksToProcess.length;
    console.error(`Incremental sync: ${newChunks.length} new, ${changedChunks.length} changed, ${unchangedCount} unchanged`);
  }

  if (chunksToProcess.length === 0) {
    console.error("All chunks are up to date. Nothing to upload.");
    if (rejectedSnapshot.length > 0) {
      const restored = await restoreRejectedStatus(rejectedSnapshot);
      if (restored > 0) console.error(`Restored rejected status on ${restored} chunk(s)`);
    }
    return;
  }

  // Embed + Upload
  console.error(`\nProcessing ${chunksToProcess.length} chunk(s)...`);
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < chunksToProcess.length; i += BATCH_SIZE) {
    const batch = chunksToProcess.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(chunksToProcess.length / BATCH_SIZE);

    let success = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const texts = batch.map(c => c.content);
        const embeddings = await embedTexts(texts);
        await uploadBatch(batch, embeddings);
        processed += batch.length;
        console.error(`  Batch ${batchNum}/${totalBatches}: uploaded ${batch.length} chunk(s) (${processed}/${chunksToProcess.length})`);
        success = true;
        break;
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes("23505") || errStr.includes("duplicate key")) {
          console.error(`  Batch ${batchNum}/${totalBatches}: skipped (already exists)`);
          processed += batch.length;
          success = true;
          break;
        }
        if (attempt < MAX_RETRIES) {
          console.error(`  Batch ${batchNum}/${totalBatches}: attempt ${attempt} failed, retrying in ${RETRY_DELAY_MS / 1000}s...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        } else {
          errors++;
          console.error(`  Batch ${batchNum}/${totalBatches}: FAILED after ${MAX_RETRIES} attempts - ${err}`);
          console.error(`    Failed IDs: ${batch.map(c => c.id).join(", ")}`);
        }
      }
    }

    if (success && i + BATCH_SIZE < chunksToProcess.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.error(`\nDone!`);
  console.error(`  Uploaded: ${processed}`);
  console.error(`  Errors: ${errors}`);

  // Restore rejections
  if (rejectedSnapshot.length > 0) {
    try {
      const restored = await restoreRejectedStatus(rejectedSnapshot);
      console.error(`Restored rejected status on ${restored} chunk(s)`);
    } catch (err) {
      console.error("CRITICAL: Failed to restore rejected chunk status:", err);
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
