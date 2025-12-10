import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { google, drive_v3 as driveV3 } from 'googleapis';

// --- Config ---
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const STATE_PATH = path.join(process.cwd(), '.drive-sync.json');
const DATA_DIR = path.join(process.cwd(), 'src/data');


const IGNORED_FOLDERS = ['assets', 'cursors', 'private'];

const IGNORE_GOOGLE_MIMES = [
  'application/vnd.google-apps.'
];

// --- Types ---
interface FileState {
  modifiedTime: string;
  name: string;
  mimeType?: string;
}

interface DirectoryState {
  files: Record<string, FileState>;
}

interface State {
  dirs: Record<string, DirectoryState>;
}

interface MediaMap {
  [folder: string]: string[];
}


// --- Utility ---
function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getDrive(): driveV3.Drive {
  const email = env('GOOGLE_SA_CLIENT_EMAIL');
  let key = env('GOOGLE_SA_PRIVATE_KEY').replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });

  return google.drive({ version: 'v3', auth });
}

function safeName(name: string): string {
  return name.replace(/[\/\\?%*:|"<>]/g, '·').trim();
}

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
  } catch {
    return { dirs: {} };
  }
}

async function saveState(state: State) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function listFolder(drive: driveV3.Drive, folderId: string) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,modifiedTime)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true
  });

  return res.data.files ?? [];
}

async function downloadBinary(
  drive: driveV3.Drive,
  file: driveV3.Schema$File,
  outDir: string
) {
  if (!file.id || !file.name) return;
  const outPath = path.join(outDir, safeName(file.name));

  const fh = await fs.open(outPath, 'w');
  try {
    const res = await drive.files.get(
      { fileId: file.id, alt: 'media' },
      { responseType: 'stream' }
    );

    await new Promise<void>((resolve, reject) => {
      const w = fh.createWriteStream();
      res.data.on('end', resolve).on('error', reject).pipe(w);
    });
  } finally {
    await fh.close();
  }

  console.log(`Downloaded: ${file.name}`);
  return safeName(file.name);
}


// --- SYNC CORE ---
async function syncFolder(
  drive: driveV3.Drive,
  files: driveV3.Schema$File[],
  localPath: string,
  state: State,
  key: string
) {
  await fs.mkdir(localPath, { recursive: true });

  if (!state.dirs[key]) state.dirs[key] = { files: {} };

  const known = state.dirs[key].files;
  const driveIds = new Set(files.map(f => f.id));

  for (const f of files) {
    if (!f.id || !f.name) continue;
    if (IGNORE_GOOGLE_MIMES.some(m => f.mimeType?.startsWith(m))) continue;

    if (!known[f.id] || known[f.id].modifiedTime !== f.modifiedTime) {
      const saved = await downloadBinary(drive, f, localPath);
      known[f.id] = {
        name: saved ?? safeName(f.name),
        modifiedTime: f.modifiedTime!,
        mimeType: f.mimeType
      };
    }
  }

  // Cleanup removed
  for (const id of Object.keys(known)) {
    if (!driveIds.has(id)) {
      const filePath = path.join(localPath, known[id].name);
      console.log(`Removing: ${known[id].name}`);
      await fs.unlink(filePath).catch(() => {});
      delete known[id];
    }
  }
}


// --- MAIN ---
async function main() {
  const drive = getDrive();
  const folderId = env('GOOGLE_DRIVE_FOLDER_ID');
  const state = await loadState();

  const rootItems = await listFolder(drive, folderId);

  const folders: Record<string, string> = {};
  const rootFiles: driveV3.Schema$File[] = [];

  for (const item of rootItems) {
    if (!item.name || !item.mimeType) continue;

    if (item.mimeType === 'application/vnd.google-apps.folder') {
      const nameLc = item.name.toLowerCase();
      if (!IGNORED_FOLDERS.some(x => nameLc.includes(x))) {
        folders[item.name] = item.id!;
      }
    } else if (!IGNORE_GOOGLE_MIMES.some(m => item.mimeType.startsWith(m))) {
      rootFiles.push(item);
    }
  }

  console.log(`Syncing folders:`, Object.keys(folders));
  console.log(`Root files:`, rootFiles.length);

  // Sync each folder to public/<folder>
  for (const [name, id] of Object.entries(folders)) {
    const files = await listFolder(drive, id);
    const targetDir = path.join(PUBLIC_DIR, name);
    await syncFolder(drive, files, targetDir, state, name);
  }

  // Sync root → public/
  await syncFolder(drive, rootFiles, PUBLIC_DIR, state, 'public-root');

  await saveState(state);

  console.log('Generating media-map.json...');

  const mediaMap: MediaMap = {};

  for (const [folder, folderState] of Object.entries(state.dirs)) {
    mediaMap[folder] = Object.values(folderState.files).map(f => {
      return folder === 'public-root'
        ? `/${f.name}`
        : `/${folder}/${f.name}`;
    });
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, 'media-map.json'),
    JSON.stringify(mediaMap, null, 2)
  );

  console.log('Media map created ✔');
}

main();
