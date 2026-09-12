// lib/storage.js — where uploaded files actually live.
//
// On disk, outside the app directory, because everything inside /opt/bluechip/app
// is a git checkout that `git pull` and `next build` churn. A deploy must never
// be able to delete a client's signed agreement.
//
// Not in Postgres: a 4 MB PDF per row makes every backup and every restore
// slower, and the database is the thing that has to come back fastest.

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

export const UPLOAD_ROOT = process.env.UPLOAD_DIR || "/opt/bluechip/uploads";

// What a recruiter actually needs to attach. Everything else is refused by
// type AND by extension — a .exe renamed to .pdf fails the first check, and a
// real PDF renamed to .exe fails the second.
export const ALLOWED = {
  "application/pdf": [".pdf"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "text/plain": [".txt"],
  "text/csv": [".csv"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/msword": [".doc"],
  "application/vnd.ms-excel": [".xls"],
};

export const MAX_BYTES = 15 * 1024 * 1024;

export function checkFile(file) {
  if (!file || typeof file.arrayBuffer !== "function") return "No file was attached.";
  if (file.size > MAX_BYTES) return `That file is ${Math.round(file.size / 1048576)} MB. The limit is 15 MB.`;
  if (file.size === 0) return "That file is empty.";

  const exts = ALLOWED[file.type];
  if (!exts) return `${file.type || "That file type"} is not accepted. Use PDF, Word, Excel, an image or a text file.`;

  const ext = path.extname(file.name || "").toLowerCase();
  if (!exts.includes(ext)) {
    return `The file says it is ${file.type} but is named "${file.name}". Rename it properly and try again.`;
  }
  return null;
}

/**
 * Write a file and return its storage key.
 *
 * The key is generated here and never derived from the uploaded name: a
 * filename is attacker-controlled, and "../../app/.env" is a filename. The
 * original name is kept in the database for display only.
 */
export async function save(file) {
  const ext = path.extname(file.name || "").toLowerCase().slice(0, 10);
  const now = new Date();
  const dir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const key = `${dir}/${crypto.randomUUID()}${ext}`;
  const full = path.join(UPLOAD_ROOT, key);

  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, Buffer.from(await file.arrayBuffer()), { mode: 0o640 });
  return key;
}

/**
 * Resolve a stored key to a path, refusing anything that escapes the root.
 * Belt and braces: keys are generated, not supplied, but this is the check that
 * matters if that ever stops being true.
 */
export function resolveKey(key) {
  const full = path.resolve(UPLOAD_ROOT, String(key || ""));
  const root = path.resolve(UPLOAD_ROOT);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

export async function read(key) {
  const full = resolveKey(key);
  if (!full) return null;
  return fs.readFile(full).catch(() => null);
}

export async function remove(key) {
  const full = resolveKey(key);
  if (!full) return;
  await fs.unlink(full).catch(() => {});
}
