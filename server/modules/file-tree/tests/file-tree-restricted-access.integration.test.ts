import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { closeConnection, initializeDatabase, userDb, userProjectAccessDb } from '@/modules/database/index.js';
import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import type { FileTreeServices } from '@/shared/types.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'file-tree-restricted-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const unexpectedOperation = async (): Promise<never> => {
  throw new Error('Unexpected File Tree service call');
};

const services: FileTreeServices = {
  browseWorkspace: unexpectedOperation,
  createWorkspaceFolder: unexpectedOperation,
  readTextFile: async (projectId, filePath) => ({ content: `${projectId}:${filePath}`, path: filePath }),
  openFile: unexpectedOperation,
  openProjectArchive: unexpectedOperation,
  saveTextFile: unexpectedOperation,
  listProjectFiles: async () => [],
  createEntry: unexpectedOperation,
  renameEntry: unexpectedOperation,
  deleteEntry: unexpectedOperation,
  storeUploadedFiles: unexpectedOperation,
};

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

async function withServer(
  user: { id: number; role: 'admin' | 'restricted' },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as express.Request & { user?: typeof user }).user = user;
    next();
  });
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    passUploadRequest,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
  ));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('restricted user reads files only in granted projects', async () => {
  await withIsolatedDatabase(async () => {
    userDb.createUser('admin', 'hash');
    const viewer = userDb.createUserWithRole('viewer', 'hash', 'restricted');
    userProjectAccessDb.setProjectsForUser(Number(viewer.id), ['proj-a']);

    await withServer({ id: Number(viewer.id), role: 'restricted' }, async (baseUrl) => {
      const granted = await fetch(`${baseUrl}/api/file-tree/projects/proj-a/files`);
      assert.equal(granted.status, 200);

      const grantedFile = await fetch(`${baseUrl}/api/file-tree/projects/proj-a/file?filePath=README.md`);
      assert.equal(grantedFile.status, 200);

      const other = await fetch(`${baseUrl}/api/file-tree/projects/proj-b/files`);
      assert.equal(other.status, 403);

      const otherFile = await fetch(`${baseUrl}/api/file-tree/projects/proj-b/file?filePath=README.md`);
      assert.equal(otherFile.status, 403);

      const otherContent = await fetch(`${baseUrl}/api/file-tree/projects/proj-b/files/content?path=x.png`);
      assert.equal(otherContent.status, 403);

      const browse = await fetch(`${baseUrl}/api/file-tree/browse-filesystem`);
      assert.equal(browse.status, 403);
    });
  });
});

test('admin reads files in any project', async () => {
  await withIsolatedDatabase(async () => {
    const admin = userDb.createUser('admin', 'hash');

    await withServer({ id: Number(admin.id), role: 'admin' }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/file-tree/projects/proj-b/files`);
      assert.equal(response.status, 200);
    });
  });
});
