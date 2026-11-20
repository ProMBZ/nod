import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, realpath, rm, stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MINIMUM_COMPUTER_STORAGE_BYTES = 50 * 1024 ** 3;

export function computerIdentity(dataRoot) {
  return createHash('sha256').update(resolve(dataRoot)).digest('hex').slice(0, 12);
}

/**
 * Resolve only Nod's per-profile computer directory. A custom location is a
 * parent folder; each profile receives a private, deterministic child folder.
 * The legacy default locations are intentionally unchanged.
 */
export function computerStoragePath(
  dataRoot,
  computerDirectory,
  { platform = process.platform, home = homedir() } = {},
) {
  const profile = resolve(dataRoot);
  const identity = computerIdentity(profile);
  if (platform === 'win32') {
    return computerDirectory
      ? join(resolve(computerDirectory), '.nod-desktop', identity, 'wsl')
      : join(profile, 'desktop-runtime', 'wsl');
  }
  return computerDirectory
    ? join(resolve(computerDirectory), '.nod-desktop', identity)
    : join(home, '.nod-desktop', identity);
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function flatpakAllows(directory, { home }) {
  return [home, '/media', '/run/media'].some((root) => isWithin(resolve(root), directory));
}

/**
 * Validate a user-selected parent folder before persisting it. The folder must
 * be a real writable directory, outside Nod's application profile, within the
 * Flatpak's existing filesystem grants, and have room for the private computer.
 */
export async function validateComputerDirectory(
  value,
  {
    dataRoot,
    home = homedir(),
    platform = process.platform,
    flatpak = Boolean(process.env.FLATPAK_ID),
    minimumFreeBytes = MINIMUM_COMPUTER_STORAGE_BYTES,
    statfsImpl = statfs,
  } = {},
) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || !isAbsolute(value)) {
    throw new Error('Choose an absolute folder path for the private computer.');
  }

  const requested = resolve(value);
  let metadata;
  try {
    metadata = await stat(requested);
  } catch (error) {
    throw new Error(`Nod cannot use "${requested}": ${error.message}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Nod cannot use "${requested}": choose a folder, not a file.`);
  }

  let directory;
  try {
    directory = await realpath(requested);
  } catch (error) {
    throw new Error(`Nod cannot resolve "${requested}": ${error.message}`);
  }

  if (dataRoot) {
    const profile = resolve(dataRoot);
    if (isWithin(profile, directory)) {
      throw new Error(
        `Nod cannot use "${directory}": choose a folder separate from Nod's application data.`,
      );
    }
  }

  if (platform === 'linux' && flatpak && !flatpakAllows(directory, { home })) {
    throw new Error(
      `Nod cannot access "${directory}" inside Flatpak. Choose a folder under your home directory, /media, or /run/media.`,
    );
  }

  try {
    await access(directory, constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new Error(`Nod cannot write to "${directory}": ${error.message}`);
  }

  const probe = join(directory, `.nod-storage-check-${randomUUID()}.tmp`);
  try {
    const file = await open(probe, 'wx', 0o600);
    try {
      await file.writeFile('Nod storage check');
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    await rm(probe, { force: true }).catch(() => {});
    throw new Error(`Nod cannot create files in "${directory}": ${error.message}`);
  }
  await rm(probe, { force: true });

  let available;
  try {
    const space = await statfsImpl(directory);
    available = Number(space.bavail) * Number(space.bsize);
  } catch (error) {
    throw new Error(`Nod cannot check free space in "${directory}": ${error.message}`);
  }
  if (!Number.isFinite(available) || available < minimumFreeBytes) {
    const free = Number.isFinite(available) ? (available / 1024 ** 3).toFixed(1) : 'unknown';
    const required = (minimumFreeBytes / 1024 ** 3).toFixed(0);
    throw new Error(
      `Nod needs at least ${required} GB free in "${directory}". This folder has ${free} GB available.`,
    );
  }

  return directory;
}

/** Recheck the selected volume at runtime, including after a removable drive is reconnected. */
export async function assertComputerDirectoryReady(directory, options = {}) {
  return validateComputerDirectory(directory, options);
}

/**
 * Refuse symlinked or non-directory nodes inside the custom storage namespace.
 * The selected volume is owner-controlled; the profile-specific path beneath
 * it must not be redirected into another folder before Lima or WSL uses it.
 */
export async function assertComputerStoragePathSafe(
  dataRoot,
  computerDirectory,
  { platform = process.platform } = {},
) {
  if (!computerDirectory) return;

  const directory = resolve(computerDirectory);
  const components = [
    join(directory, '.nod-desktop'),
    join(directory, '.nod-desktop', computerIdentity(dataRoot)),
  ];
  if (platform === 'win32') components.push(join(components[1], 'wsl'));

  for (const path of components) {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw new Error(`Nod cannot inspect its private-computer folder "${path}": ${error.message}`);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(
        `Nod cannot use "${path}" because a private-computer storage folder is not a normal directory. Rename or remove that entry, then try again.`,
      );
    }
  }
}
