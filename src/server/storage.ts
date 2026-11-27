import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveContainedPath } from './security.ts';

export class LocalObjectStorage {
  private readonly rootDir: string;

  constructor(dataDir: string) {
    this.rootDir = path.resolve(dataDir, 'storage');
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  public createRepoStorageKey(repoId: string): string {
    const cleanRepoId = repoId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanRepoId) throw new Error('Invalid repository ID');
    return `repos/${cleanRepoId}/${crypto.randomUUID()}`;
  }

  public createProfileImageStorageKey(userId: string, ext: string): string {
    const cleanUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '');
    const cleanExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    if (!cleanUserId) throw new Error('Invalid user ID');
    return `profile-images/${cleanUserId}/${crypto.randomUUID()}.${cleanExt}`;
  }

  public writeObject(storageKey: string, data: Buffer): void {
    const absPath = resolveContainedPath(this.rootDir, storageKey);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, data);
  }

  public readObject(storageKey: string): Buffer {
    const absPath = resolveContainedPath(this.rootDir, storageKey);
    return fs.readFileSync(absPath);
  }

  public exists(storageKey: string): boolean {
    try {
      const absPath = resolveContainedPath(this.rootDir, storageKey);
      return fs.existsSync(absPath);
    } catch {
      return false;
    }
  }

  public deleteObject(storageKey: string): void {
    try {
      const absPath = resolveContainedPath(this.rootDir, storageKey);
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
      }
    } catch {
      // Ignore cleanup error
    }
  }

  public deleteRepoFolder(repoId: string): void {
    const cleanRepoId = repoId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanRepoId) return;
    try {
      const absDir = resolveContainedPath(this.rootDir, `repos/${cleanRepoId}`);
      fs.rmSync(absDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}
