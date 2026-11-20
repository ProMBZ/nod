import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSettingsStore } from '../main/settings.mjs';

import { removeComputer } from '../runtime/index.mjs';
import {
  computerIdentity,
  computerStoragePath,
  validateComputerDirectory,
} from '../runtime/computer-storage.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'nod-computer-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('legacy private-computer locations remain unchanged when no custom folder is set', async (t) => {
  const root = await temporary(t);
  const home = join(root, 'home');
  const profile = join(root, 'profile');
  const identity = computerIdentity(profile);

  assert.equal(
    computerStoragePath(profile, undefined, { platform: 'darwin', home }),
    join(home, '.nod-desktop', identity),
  );
  assert.equal(
    computerStoragePath(profile, null, { platform: 'win32', home }),
    join(profile, 'desktop-runtime', 'wsl'),
  );
});

test('custom folders keep each profile in its own private computer directory', async (t) => {
  const root = await temporary(t);
  const directory = join(root, 'external');
  const profileA = join(root, 'profile-a');
  const profileB = join(root, 'profile-b');
  await mkdir(directory);

  assert.equal(
    computerStoragePath(profileA, directory, { platform: 'darwin' }),
    join(directory, '.nod-desktop', computerIdentity(profileA)),
  );
  assert.equal(
    computerStoragePath(profileB, directory, { platform: 'linux' }),
    join(directory, '.nod-desktop', computerIdentity(profileB)),
  );
  assert.notEqual(
    computerStoragePath(profileA, directory, { platform: 'linux' }),
    computerStoragePath(profileB, directory, { platform: 'linux' }),
  );
  assert.equal(
    computerStoragePath(profileA, directory, { platform: 'win32' }),
    join(directory, '.nod-desktop', computerIdentity(profileA), 'wsl'),
  );
});

test('a selected folder must exist, be a directory, and be separate from app data', async (t) => {
  const root = await temporary(t);
  const profile = join(root, 'profile');
  const directory = join(root, 'external');
  const file = join(root, 'not-a-folder');
  await mkdir(profile);
  await mkdir(directory);
  await writeFile(file, 'not a directory');

  const options = { dataRoot: profile, minimumFreeBytes: 0 };
  assert.equal(await validateComputerDirectory(directory, options), directory);
  await assert.rejects(validateComputerDirectory(file, options), /real folder/);
  await assert.rejects(validateComputerDirectory(join(root, 'missing'), options), /cannot use/);
  await assert.rejects(validateComputerDirectory(profile, options), /separate from Nod's application data/);
  assert.equal(await validateComputerDirectory(root, options), root);
});

test('a selected folder must be writable and have the required free space', async (t) => {
  const root = await temporary(t);
  const directory = join(root, 'external');
  await mkdir(directory);

  await assert.rejects(
    validateComputerDirectory(directory, {
      minimumFreeBytes: Number.MAX_SAFE_INTEGER,
    }),
    /needs at least .* GB free/,
  );

  const invalid = await validateComputerDirectory(directory, {
    minimumFreeBytes: 0,
    statfsImpl: async () => ({ bavail: 0, bsize: 1 }),
  });
  assert.equal(invalid, directory);
});

test('Flatpak accepts only its already granted storage roots', async (t) => {
  const root = await temporary(t);
  const home = join(root, 'home');
  const allowed = join(home, 'Computer');
  const elsewhere = join(root, 'mnt', 'computer');
  await mkdir(allowed, { recursive: true });
  await mkdir(elsewhere, { recursive: true });

  const base = {
    platform: 'linux',
    flatpak: true,
    home,
    minimumFreeBytes: 0,
  };
  assert.equal(await validateComputerDirectory(allowed, base), allowed);
  await assert.rejects(
    validateComputerDirectory(elsewhere, base),
    /inside Flatpak/,
  );
});

test('a folder that is a symbolic link is rejected', async (t) => {
  const root = await temporary(t);
  const directory = join(root, 'real');
  const link = join(root, 'linked');
  await mkdir(directory);
  await symlink(directory, link);

  await assert.rejects(
    validateComputerDirectory(link, { minimumFreeBytes: 0 }),
    /real folder/,
  );
});

test('desktop settings persist and validate the selected private-computer folder', async (t) => {
  const root = await temporary(t);
  const directory = join(root, 'external');
  await mkdir(directory);
  const store = createSettingsStore(join(root, 'settings.json'), {});

  assert.equal((await store.get()).computerDirectory, undefined);
  await store.save({ computerDirectory: directory });
  assert.equal((await store.get()).computerDirectory, directory);

  await assert.rejects(store.save({ computerDirectory: 'relative/folder' }), /valid private-computer storage folder/);
  await assert.rejects(
    store.save({ computerDirectory: join(root, 'external', '..', 'external') }),
    /valid private-computer storage folder/,
  );

  await store.save({ computerDirectory: null });
  assert.equal((await store.get()).computerDirectory, undefined);
});

test('removing a custom private computer clears its runtime identity but keeps app data and other profiles', async (t) => {
  const root = await temporary(t);
  const profile = join(root, 'profile');
  const directory = join(root, 'external');
  const otherProfile = join(root, 'other-profile');
  const runtime = join(profile, 'desktop-runtime');
  const ownComputer = computerStoragePath(profile, directory);
  const otherComputer = computerStoragePath(otherProfile, directory);
  await mkdir(runtime, { recursive: true });
  await mkdir(ownComputer, { recursive: true });
  await mkdir(otherComputer, { recursive: true });
  await mkdir(directory, { recursive: true });
  await writeFile(join(runtime, 'state.json'), JSON.stringify({ limaHome: ownComputer }));
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ computerDirectory: directory }));
  await writeFile(join(ownComputer, 'synthetic-disk'), 'old computer');
  await writeFile(join(otherComputer, 'synthetic-disk'), 'other profile');

  await removeComputer({
    dataRoot: profile,
    resourcesPath: root,
    computerDirectory: directory,
  });

  await assert.rejects(readFile(join(runtime, 'state.json')));
  assert.equal(await readFile(join(profile, 'settings.json'), 'utf8'), JSON.stringify({ computerDirectory: directory }));
  assert.equal(await readFile(join(otherComputer, 'synthetic-disk'), 'utf8'), 'other profile');
  assert.equal(await readFile(join(directory, '.nod-desktop', computerIdentity(otherProfile), 'wsl', 'synthetic-disk'), 'utf8'), 'other profile');
  await assert.rejects(readFile(join(ownComputer, 'synthetic-disk')));
  assert.equal(await readFile(join(profile, 'settings.json'), 'utf8'), JSON.stringify({ computerDirectory: directory }));
});
