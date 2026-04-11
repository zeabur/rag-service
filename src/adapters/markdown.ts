import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import type { SourceAdapter, Chunk } from "../pipeline/types";
import { parseFrontmatter, splitByHeadings, splitByParagraph, pathToSlug } from "../pipeline/markdown-utils";

function globMarkdown(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      try {
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (/\.(mdx?|md)$/.test(entry)) {
          results.push(full);
        }
      } catch {
        // skip unreadable entries
      }
    }
  }
  walk(dir);
  return results;
}

export default {
  name: "markdown",
  description: "Import and chunk markdown/mdx files from a directory (splits by ## headings, ~800 chars)",

  async export(config) {
    const dir = resolve(config.INPUT_PATH || "./docs");
    const files = globMarkdown(dir);

    if (files.length === 0) {
      console.error(`[markdown] No .md/.mdx files found in "${dir}"`);
      return [];
    }

    console.error(`[markdown] Found ${files.length} file(s) in "${dir}"`);
    const chunks: Chunk[] = [];

    for (const file of files) {
      const raw = readFileSync(file, "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);
      const slug = pathToSlug(file, dir);
      const sections = splitByHeadings(body);

      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        if (!section.body && !section.heading) continue;

        const parts = splitByParagraph(section.body || section.heading, 800);

        for (let j = 0; j < parts.length; j++) {
          const chunkId = `MD-${slug}-${i}-${j}`;
          const heading = section.heading || frontmatter.title || slug;

          chunks.push({
            id: chunkId,
            source: "markdown",
            title: heading,
            content: section.heading ? `${heading}\n${parts[j]}` : parts[j],
            metadata: {
              question: heading,
              answer: parts[j],
              tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
              parent_id: j > 0 ? `MD-${slug}-${i}-0` : null,
              created_at: frontmatter.date || null,
              url: frontmatter.url || null,
            },
          });
        }
      }
    }

    return chunks;
  },
} satisfies SourceAdapter;
