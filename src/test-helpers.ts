import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import crypto from "node:crypto";

const tmpFiles: string[] = [];

/**
 * Create a unique temp file path for test state.
 * The file does NOT exist yet — managers will create it on first save.
 *
 * Note: Several managers have a shallow-copy bug in their EMPTY_STORE
 * constant that causes state to leak between instances that hit the
 * ENOENT path. Tests should account for this by using unique IDs and
 * checking inclusion rather than exact counts where needed.
 */
export function tmpStateFile(prefix = "test", seed?: string): string {
  const name = `${prefix}_${crypto.randomUUID()}.json`;
  const filePath = join(tmpdir(), name);
  tmpFiles.push(filePath);
  if (seed !== undefined) {
    writeFileSync(filePath, seed, "utf8");
  }
  return filePath;
}

/**
 * Remove all temp files created by `tmpStateFile()`.
 */
export async function cleanupTmpFiles(): Promise<void> {
  for (const f of tmpFiles.splice(0)) {
    try {
      await rm(f, { force: true });
      await rm(`${f}.tmp`, { force: true });
    } catch {
      // ignore
    }
  }
}
