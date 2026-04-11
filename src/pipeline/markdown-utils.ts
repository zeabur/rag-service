/**
 * Parse YAML frontmatter from markdown content.
 * Returns { frontmatter, body } where frontmatter is a key-value Record.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const raw = match[1];
  const body = match[2];
  const frontmatter: Record<string, any> = {};

  for (const line of raw.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: any = line.slice(colonIdx + 1).trim();
    // Handle arrays: tags: [a, b, c] or tags: ["a", "b"]
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((s: string) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    // Strip surrounding quotes
    if (typeof value === "string" && /^["'].*["']$/.test(value)) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body };
}

/**
 * Split markdown body by ## headings.
 * Returns array of { heading, body } sections.
 * Content before the first ## goes into a section with heading = "".
 */
export function splitByHeadings(body: string): { heading: string; body: string }[] {
  const sections: { heading: string; body: string }[] = [];
  const parts = body.split(/^## /m);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;

    if (i === 0) {
      // Content before first ## heading
      sections.push({ heading: "", body: part });
    } else {
      const newlineIdx = part.indexOf("\n");
      if (newlineIdx === -1) {
        sections.push({ heading: part.trim(), body: "" });
      } else {
        sections.push({
          heading: part.slice(0, newlineIdx).trim(),
          body: part.slice(newlineIdx + 1).trim(),
        });
      }
    }
  }

  return sections;
}

/**
 * Split text into chunks at paragraph boundaries (blank lines),
 * targeting approximately `targetSize` characters per chunk.
 */
export function splitByParagraph(text: string, targetSize = 800): string[] {
  if (text.length <= targetSize) return [text];

  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current && (current.length + para.length + 2) > targetSize) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

/**
 * Convert a file path to a URL-friendly slug relative to a base directory.
 * e.g. "docs/guides/deploy.mdx" → "guides-deploy"
 */
export function pathToSlug(filePath: string, baseDir: string): string {
  let rel = filePath.replace(baseDir, "").replace(/^[/\\]+/, "");
  rel = rel.replace(/\.(mdx?|md)$/, "");
  return rel.replace(/[/\\]+/g, "-").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
