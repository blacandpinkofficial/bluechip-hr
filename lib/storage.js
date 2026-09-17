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
  // .csv is here as well as under text/csv because Chrome on a Windows machine
  // with Excel installed reports a .csv as application/vnd.ms-excel — so the
  // spreadsheet a recruiter exports and attaches was refused before any of this
  // code ran, with a message about file types that explained nothing.
  "application/vnd.ms-excel": [".xls", ".csv"],
};

export const MAX_BYTES = 15 * 1024 * 1024;

// ── what the first few bytes have to say ────────────────────────────────────
//
// The two checks above — declared type, and extension — are both written by
// whoever is uploading. The browser takes file.type from the extension, and
// the extension is part of a name the uploader chose. So renaming payload.exe
// to cv.pdf passed every check this file used to make: the name ends .pdf, the
// browser therefore says application/pdf, and the two agreed with each other
// because they came from the same place.
//
// A file's own first bytes are the one thing in the upload the uploader did
// not get to write to suit us. They do not make an upload safe — nothing here
// executes an upload, and the download route sets nosniff and a content type
// from the database for exactly this reason — but they are what stops the
// knowledge base becoming somewhere to park an installer behind a login, and
// they catch the ordinary case of a file that is simply not what its name says.
//
// A prefix of null means "this type has no signature" (text and CSV genuinely
// do not), and those are checked the other way round: they must not begin like
// something that does.
const SIGNATURES = {
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]],                          // %PDF
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  // RIFF....WEBP — four bytes, then a length, then the format at offset 8.
  "image/webp": [[0x52, 0x49, 0x46, 0x46]],
  // Both OOXML formats are zip files. PK\x03\x04 is a local file header;
  // \x05\x06 is an empty archive and \x07\x08 a spanned one, neither of
  // which Word or Excel writes, so only the first is accepted.
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [[0x50, 0x4b, 0x03, 0x04]],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [[0x50, 0x4b, 0x03, 0x04]],
  // The old binary .doc/.xls: an OLE2 compound file.
  // .doc is whatever Word agreed to open. An OLE2 compound file is the common
  // case, but an RTF saved as .doc and a Word 2003 XML .doc are both ordinary
  // things people email, and the browser labels all three application/msword
  // off the extension — so refusing the last two leaves the sender no way
  // through and nothing they can act on.
  "application/msword": [
    [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    [0x7b, 0x5c, 0x72, 0x74, 0x66],                     // {\rtf
    [0x3c, 0x3f, 0x78, 0x6d, 0x6c],                     // <?xml
    [0xef, 0xbb, 0xbf, 0x3c, 0x3f, 0x78, 0x6d, 0x6c],   // the same with a BOM
  ],
  "application/vnd.ms-excel": [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  "text/plain": null,
  "text/csv": null,
};

// Things a .txt or .csv must not secretly be. Not a virus scanner and not
// trying to be — it is the short list of "this is a program, not a note".
const EXECUTABLE_SIGNATURES = [
  [0x4d, 0x5a],                          // MZ — Windows .exe/.dll
  [0x7f, 0x45, 0x4c, 0x46],              // ELF — Linux binary
  [0xca, 0xfe, 0xba, 0xbe],              // Mach-O fat / Java class
  [0xcf, 0xfa, 0xed, 0xfe],              // Mach-O 64
  [0x50, 0x4b, 0x03, 0x04],              // a zip wearing a .txt
  [0x1f, 0x8b],                          // gzip
  [0x23, 0x21],                          // #! — a script
];

function startsWith(buf, sig) {
  if (buf.length < sig.length) return false;
  return sig.every((b, i) => buf[i] === b);
}

/** Where a signature appears in the head, or -1. */
function indexOfSig(buf, sig) {
  outer: for (let i = 0; i + sig.length <= buf.length; i++) {
    for (let j = 0; j < sig.length; j++) if (buf[i + j] !== sig[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Is the file's declared type accepted, does its name agree, and do its first
 * bytes agree with both?
 *
 * ASYNC — it reads the head of the file. There is exactly one caller and it
 * awaits. If you add another, await it: a forgotten await returns a Promise,
 * which is truthy, and every upload would be refused with "[object Promise]".
 *
 * Returns a sentence to show the person, or null when the file is fine.
 */
export async function checkFile(file) {
  if (!file || typeof file.arrayBuffer !== "function") return "No file was attached.";
  if (file.size > MAX_BYTES) return `That file is ${Math.round(file.size / 1048576)} MB. The limit is 15 MB.`;
  if (file.size === 0) return "That file is empty.";

  const exts = ALLOWED[file.type];
  if (!exts) return `${file.type || "That file type"} is not accepted. Use PDF, Word, Excel, an image or a text file.`;

  const ext = path.extname(file.name || "").toLowerCase();
  if (!exts.includes(ext)) {
    return `The file says it is ${file.type} but is named "${file.name}". Rename it properly and try again.`;
  }

  // Only the head, not the whole file: save() reads it again in a moment, and
  // there is no reason to pull 15 MB through memory twice to look at 12 bytes.
  // 1 KB, not 64 bytes. A PDF is allowed to carry arbitrary bytes before its
  // %PDF header and plenty of real ones do — concatenated files, some scanner
  // output, some e-signing tools — so requiring it at offset zero refuses a
  // file that opens perfectly everywhere else, and tells the sender to "save it
  // again in the right format", which they cannot.
  let head;
  try {
    head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  } catch {
    return "That file could not be read.";
  }

  // The extension decides here, not the declared type. A .csv can arrive
  // labelled application/vnd.ms-excel (see ALLOWED above), and checking it
  // against the OLE2 signature would refuse every real CSV on a Windows
  // machine. Text is text whatever the browser called it.
  const expected = ext === ".csv" || ext === ".txt" ? null : SIGNATURES[file.type];

  if (expected === null) {
    // Text and CSV have no signature of their own, so the question is only
    // whether this is something else in a .txt coat.
    if (EXECUTABLE_SIGNATURES.some((sig) => startsWith(head, sig))) {
      return `That is not a text file, whatever it is named. Attach the real ${ext === ".csv" ? "CSV" : "text file"}.`;
    }
    return null;
  }

  // PDF is the one format looked for rather than matched at the front, for the
  // reason above. Everything else must begin with its signature.
  const found = file.type === "application/pdf"
    ? indexOfSig(head, expected[0]) >= 0
    : expected.some((sig) => startsWith(head, sig));

  if (!found) {
    return `That file is named "${file.name}" but its contents are not ${ext.replace(".", "").toUpperCase()}. Save it again in the right format, or attach the original.`;
  }

  // RIFF is shared by WebP, WAV and AVI; the format itself is at offset 8.
  if (file.type === "image/webp") {
    const webp = [0x57, 0x45, 0x42, 0x50]; // WEBP
    const ok = head.length >= 12 && webp.every((b, i) => head[8 + i] === b);
    if (!ok) return `That file is named "${file.name}" but is not a WebP image.`;
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
