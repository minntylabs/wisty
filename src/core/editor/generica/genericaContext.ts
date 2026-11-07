/**
 * Finds what a `.tale` file belongs to: the story folder (the nearest folder,
 * going up from the file, that holds `phrases.txt`), the game folder (the one
 * above that holds `project.godot`), the phrase list, and the names declared
 * in the story folder's other files. No path is fixed anywhere.
 */

import { exists, readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { parsePhrases, type Phrases } from "./genericaPhrases";
import { emptyNames, mergeNames, namesOf, scanBlocks, type Names } from "./genericaScan";

export type GenericaContext = {
  storyDir: string;
  /** Null when no folder above the story folder holds `project.godot`. */
  gameDir: string | null;
  phrases: Phrases;
};

const parentOf = (path: string): string | null => {
  const at = path.lastIndexOf("/");
  if (at <= 0) {
    return at === 0 && path.length > 1 ? "/" : null;
  }
  return path.slice(0, at);
};

const join = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);

const lookUp = async (from: string | null, file: string): Promise<string | null> => {
  let dir = from;
  while (dir !== null) {
    if (await exists(join(dir, file))) {
      return dir;
    }
    dir = parentOf(dir);
  }
  return null;
};

export const findContext = async (filePath: string): Promise<GenericaContext | null> => {
  const storyDir = await lookUp(parentOf(filePath), "phrases.txt");
  if (storyDir === null) {
    return null;
  }
  const phrases = parsePhrases(await readTextFile(join(storyDir, "phrases.txt")));
  const gameDir = await lookUp(parentOf(storyDir), "project.godot");
  return { storyDir, gameDir, phrases };
};

const taleFiles = async (dir: string, depth = 0): Promise<string[]> => {
  if (depth > 6) {
    return [];
  }
  const found: string[] = [];
  for (const entry of await readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      found.push(...(await taleFiles(path, depth + 1)));
    } else if (entry.name.endsWith(".tale")) {
      found.push(path);
    }
  }
  return found;
};

/** Names declared in every `.tale` file of the story folder except `skip`. */
export const otherFileNames = async (storyDir: string, skip: string): Promise<Names> => {
  let all = emptyNames();
  for (const path of await taleFiles(storyDir)) {
    if (path === skip) {
      continue;
    }
    try {
      all = mergeNames(all, namesOf(scanBlocks((await readTextFile(path)).split("\n"))));
    } catch {
      // A file that cannot be read just adds no names.
    }
  }
  return all;
};
