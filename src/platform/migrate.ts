/**
 * One-time migration: read all data from local IndexedDB and write to Supabase.
 * This reads IndexedDB directly (bypassing the cloud-mode check) so it works
 * even after the user has logged in and the app has switched to cloud mode.
 */
import { openDB } from 'idb';
import { getSupabase } from './supabase';
import type { Service, Bill, Document } from '../types';

const DB_NAME = 'household';
const DB_VERSION = 1;

/** Convert camelCase JS object to snake_case DB row */
function toDbRow(obj: Record<string, any>): Record<string, any> {
  const row: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const snakeKey = k.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
    if (v !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      row[snakeKey] = JSON.stringify(v);
    } else if (Array.isArray(v)) {
      row[snakeKey] = JSON.stringify(v);
    } else {
      row[snakeKey] = v;
    }
  }
  return row;
}

export interface MigrationResult {
  services: number;
  bills: number;
  documents: number;
  files: number;
  errors: string[];
}

export async function migrateLocalToCloud(): Promise<MigrationResult> {
  const result: MigrationResult = { services: 0, bills: 0, documents: 0, files: 0, errors: [] };
  const sb = getSupabase();

  // Read directly from IndexedDB
  const db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('services'))  db.createObjectStore('services',  { keyPath: 'id' });
      if (!db.objectStoreNames.contains('bills'))     db.createObjectStore('bills',     { keyPath: 'id' });
      if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files'))     db.createObjectStore('files',     { keyPath: 'id' });
    },
  });

  // 1. Migrate services
  const services: Service[] = await db.getAll('services');
  for (const s of services) {
    try {
      const row = toDbRow(s);
      const { error } = await sb.from('services').upsert(row, { onConflict: 'id' });
      if (error) throw error;
      result.services++;
    } catch (e: any) {
      result.errors.push(`Service "${s.nickname}": ${e.message || e}`);
    }
  }

  // 2. Migrate bills
  const bills: Bill[] = await db.getAll('bills');
  for (const b of bills) {
    try {
      const row = toDbRow(b);
      const { error } = await sb.from('bills').upsert(row, { onConflict: 'id' });
      if (error) throw error;
      result.bills++;
    } catch (e: any) {
      result.errors.push(`Bill ${b.id}: ${e.message || e}`);
    }
  }

  // 3. Migrate documents
  const docs: Document[] = await db.getAll('documents');
  for (const d of docs) {
    try {
      const row = toDbRow(d);
      const { error } = await sb.from('documents').upsert(row, { onConflict: 'id' });
      if (error) throw error;
      result.documents++;
    } catch (e: any) {
      result.errors.push(`Document "${d.title}": ${e.message || e}`);
    }
  }

  // 4. Migrate files (binary data → Supabase Storage)
  const files: { id: string; bytes: ArrayBuffer; mimeType: string; fileName: string }[] = await db.getAll('files');
  for (const f of files) {
    try {
      if (!f.bytes) continue;
      const blob = new Blob([f.bytes], { type: f.mimeType });
      const { error: storageError } = await sb.storage
        .from('documents')
        .upload(f.id, blob, { contentType: f.mimeType, upsert: true });
      if (storageError) throw storageError;

      // Save metadata
      await sb.from('files').upsert({
        id: f.id,
        mime_type: f.mimeType,
        file_name: f.fileName,
        file_size: f.bytes.byteLength,
      }, { onConflict: 'id' });
      result.files++;
    } catch (e: any) {
      result.errors.push(`File "${f.fileName}": ${e.message || e}`);
    }
  }

  db.close();
  return result;
}

/** Check how much local data exists */
export async function getLocalDataCount(): Promise<{ services: number; bills: number; documents: number; files: number }> {
  try {
    const db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('services'))  db.createObjectStore('services',  { keyPath: 'id' });
        if (!db.objectStoreNames.contains('bills'))     db.createObjectStore('bills',     { keyPath: 'id' });
        if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files'))     db.createObjectStore('files',     { keyPath: 'id' });
      },
    });
    const services = await db.count('services');
    const bills = await db.count('bills');
    const documents = await db.count('documents');
    const files = await db.count('files');
    db.close();
    return { services, bills, documents, files };
  } catch {
    return { services: 0, bills: 0, documents: 0, files: 0 };
  }
}
