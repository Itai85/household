/**
 * Dual-mode storage layer.
 *
 * - Cloud mode (Supabase configured + user logged in): reads/writes Supabase Postgres + Storage
 * - Local mode (no Supabase or not logged in): reads/writes IndexedDB
 *
 * Same interface either way — callers don't need to know which backend is active.
 */
import { openDB, type IDBPDatabase } from 'idb';
import type { Service, Bill, Document } from '../types';
import { isSupabaseConfigured, getSupabase } from './supabase';
import type { AiConfig } from './ai-providers';

// ─── Mode detection ──────────────────────────────────────────

/** Check if we're using cloud storage (Supabase + logged in) */
function isCloud(): boolean {
  if (!isSupabaseConfigured) return false;
  // Check if there's a session — we cache this to avoid async in sync functions
  return _cloudActive;
}

let _cloudActive = false;

/** Called by AuthContext when session state changes */
export function setCloudMode(active: boolean): void {
  _cloudActive = active;
}

// ═══════════════════════════════════════════════════════════════
// LOCAL STORAGE (IndexedDB)
// ═══════════════════════════════════════════════════════════════

const DB_NAME = 'household';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<any>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('services'))  db.createObjectStore('services',  { keyPath: 'id' });
        if (!db.objectStoreNames.contains('bills'))     db.createObjectStore('bills',     { keyPath: 'id' });
        if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files'))     db.createObjectStore('files',     { keyPath: 'id' });
      },
    });
  }
  return dbPromise;
}

// ═══════════════════════════════════════════════════════════════
// CLOUD STORAGE (Supabase)
// ═══════════════════════════════════════════════════════════════

/** Strip undefined fields — Supabase/Postgres doesn't like explicit undefined */
function clean<T extends Record<string, any>>(obj: T): T {
  const result: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

/** Convert camelCase JS object to snake_case DB row */
function toDbRow(obj: Record<string, any>): Record<string, any> {
  const row: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const snakeKey = k.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
    // Serialize complex fields as JSON
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

/** Convert snake_case DB row to camelCase JS object */
function fromDbRow(row: Record<string, any>): Record<string, any> {
  const obj: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    // Skip internal DB columns
    if (k === 'user_id') continue;
    const camelKey = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    // Parse JSON strings back to objects/arrays
    if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
      try { obj[camelKey] = JSON.parse(v); continue; } catch {}
    }
    obj[camelKey] = v;
  }
  return obj;
}

// ─── Services ──────────────────────────────────────────────

export async function getAllServices(): Promise<Service[]> {
  if (isCloud()) {
    const { data, error } = await getSupabase()
      .from('services')
      .select('*');
    if (error) throw error;
    return (data || []).map(r => fromDbRow(r) as Service);
  }
  const db = await getDB();
  return db.getAll('services');
}

export async function getService(id: string): Promise<Service | undefined> {
  if (isCloud()) {
    const { data, error } = await getSupabase()
      .from('services')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data ? fromDbRow(data) as Service : undefined;
  }
  const db = await getDB();
  return db.get('services', id);
}

export async function saveService(s: Service): Promise<void> {
  if (isCloud()) {
    const row = toDbRow(s);
    const { error } = await getSupabase()
      .from('services')
      .upsert(row, { onConflict: 'id' });
    if (error) throw error;
    return;
  }
  const db = await getDB();
  await db.put('services', s);
}

export async function deleteService(id: string): Promise<void> {
  if (isCloud()) {
    const sb = getSupabase();
    // Cascade: delete related records first
    await sb.from('files').delete().eq('service_id', id);
    await sb.from('documents').delete().eq('service_id', id);
    await sb.from('bills').delete().eq('service_id', id);
    const { error } = await sb.from('services').delete().eq('id', id);
    if (error) throw error;
    return;
  }
  const db = await getDB();
  await db.delete('services', id);
  // cascade: delete bills and documents for this service
  const bills = await db.getAll('bills');
  for (const b of bills) {
    if (b.serviceId === id) await db.delete('bills', b.id);
  }
  const docs = await db.getAll('documents');
  for (const d of docs) {
    if (d.serviceId === id) {
      await db.delete('documents', d.id);
      await db.delete('files', d.id);
    }
  }
}

// ─── Bills ─────────────────────────────────────────────────

export async function getBillsForService(serviceId: string): Promise<Bill[]> {
  if (isCloud()) {
    const { data, error } = await getSupabase()
      .from('bills')
      .select('*')
      .eq('service_id', serviceId)
      .order('period_start', { ascending: false });
    if (error) throw error;
    return (data || []).map(r => fromDbRow(r) as Bill);
  }
  const db = await getDB();
  const all = await db.getAll('bills');
  return all.filter((b: Bill) => b.serviceId === serviceId)
    .sort((a: Bill, b: Bill) => (b.periodStart || '').localeCompare(a.periodStart || ''));
}

export async function saveBill(b: Bill): Promise<void> {
  if (isCloud()) {
    const row = toDbRow(b);
    const { error } = await getSupabase()
      .from('bills')
      .upsert(row, { onConflict: 'id' });
    if (error) throw error;
    return;
  }
  const db = await getDB();
  await db.put('bills', b);
}

export async function deleteBill(id: string): Promise<void> {
  if (isCloud()) {
    const { error } = await getSupabase()
      .from('bills')
      .delete()
      .eq('id', id);
    if (error) throw error;
    return;
  }
  const db = await getDB();
  await db.delete('bills', id);
}

// ─── Documents ─────────────────────────────────────────────

export async function getDocsForService(serviceId: string): Promise<Document[]> {
  if (isCloud()) {
    const { data, error } = await getSupabase()
      .from('documents')
      .select('*')
      .eq('service_id', serviceId)
      .order('doc_date', { ascending: false });
    if (error) throw error;
    return (data || []).map(r => fromDbRow(r) as Document);
  }
  const db = await getDB();
  const all = await db.getAll('documents');
  return all.filter((d: Document) => d.serviceId === serviceId)
    .sort((a: Document, b: Document) => (b.docDate || '').localeCompare(a.docDate || ''));
}

export async function getDocument(id: string): Promise<Document | undefined> {
  if (isCloud()) {
    const { data, error } = await getSupabase()
      .from('documents')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data ? fromDbRow(data) as Document : undefined;
  }
  const db = await getDB();
  return db.get('documents', id);
}

export async function saveDocument(d: Document): Promise<void> {
  if (isCloud()) {
    const row = toDbRow(d);
    const { error } = await getSupabase()
      .from('documents')
      .upsert(row, { onConflict: 'id' });
    if (error) throw error;
    return;
  }
  const db = await getDB();
  await db.put('documents', d);
}

export async function deleteDocument(id: string): Promise<void> {
  if (isCloud()) {
    const sb = getSupabase();
    // Delete file from storage bucket too
    await sb.storage.from('documents').remove([id]);
    const { error } = await sb.from('documents').delete().eq('id', id);
    if (error) throw error;
    return;
  }
  const db = await getDB();
  await db.delete('documents', id);
  await db.delete('files', id);
}

// ─── Files (binary) ────────────────────────────────────────

export async function saveFile(id: string, bytes: ArrayBuffer, mimeType: string, fileName: string): Promise<void> {
  if (isCloud()) {
    const sb = getSupabase();
    const blob = new Blob([bytes], { type: mimeType });
    const { error } = await sb.storage
      .from('documents')
      .upload(id, blob, { contentType: mimeType, upsert: true });
    if (error) throw error;
    // Also save metadata in the files table for easy lookup
    await sb.from('files').upsert({
      id,
      mime_type: mimeType,
      file_name: fileName,
      file_size: bytes.byteLength,
    }, { onConflict: 'id' });
    return;
  }
  const db = await getDB();
  await db.put('files', { id, bytes, mimeType, fileName });
}

export async function loadFile(id: string): Promise<{ bytes: ArrayBuffer; mimeType: string; fileName: string } | undefined> {
  if (isCloud()) {
    const sb = getSupabase();
    // Get metadata
    const { data: meta } = await sb.from('files').select('*').eq('id', id).maybeSingle();
    if (!meta) return undefined;
    // Download from storage
    const { data: blob, error } = await sb.storage.from('documents').download(id);
    if (error || !blob) return undefined;
    const bytes = await blob.arrayBuffer();
    return { bytes, mimeType: meta.mime_type, fileName: meta.file_name };
  }
  const db = await getDB();
  return db.get('files', id);
}

export async function deleteFile(id: string): Promise<void> {
  if (isCloud()) {
    const sb = getSupabase();
    await sb.storage.from('documents').remove([id]);
    await sb.from('files').delete().eq('id', id);
    return;
  }
  const db = await getDB();
  await db.delete('files', id);
}

// ─── Settings (localStorage — stays local per device) ──────

const AI_CONFIG_KEY = 'household_ai_config';
const TOKEN_USAGE_KEY = 'household_token_usage';

// Legacy keys — for migration
const LEGACY_API_KEY = 'household_anthropic_api_key';
const LEGACY_MODEL_PREF = 'household_model_preference';

/** Get AI provider configuration. Migrates from legacy single-key format if needed. */
export function getAiConfig(): AiConfig | null {
  try {
    const raw = localStorage.getItem(AI_CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}

  // Migrate from legacy format
  const legacyKey = localStorage.getItem(LEGACY_API_KEY);
  if (legacyKey) {
    const legacyModel = localStorage.getItem(LEGACY_MODEL_PREF) || 'auto';
    const config: AiConfig = {
      providerId: 'anthropic',
      apiKey: legacyKey,
      modelId: legacyModel,
    };
    setAiConfig(config);
    localStorage.removeItem(LEGACY_API_KEY);
    localStorage.removeItem(LEGACY_MODEL_PREF);
    return config;
  }

  return null;
}

export function setAiConfig(config: AiConfig | null): void {
  if (config) {
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config));
  } else {
    localStorage.removeItem(AI_CONFIG_KEY);
  }
}

export function hasAiConfig(): boolean {
  const config = getAiConfig();
  return !!(config && config.apiKey);
}

// Legacy getters
export function getApiKey(): string {
  const config = getAiConfig();
  return config?.apiKey || '';
}

export function getModelPreference(): string {
  const config = getAiConfig();
  return config?.modelId || 'auto';
}

// ─── Token usage tracking ─────────────────────────────────

export interface TokenUsageRecord {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  callCount: number;
  lastUsed: string;
}

export function getTokenUsage(): TokenUsageRecord {
  try {
    const raw = localStorage.getItem(TOKEN_USAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, callCount: 0, lastUsed: '' };
}

export function addTokenUsage(inputTokens: number, outputTokens: number, costUSD: number): void {
  const current = getTokenUsage();
  current.totalInputTokens += inputTokens;
  current.totalOutputTokens += outputTokens;
  current.totalCostUSD += costUSD;
  current.callCount += 1;
  current.lastUsed = new Date().toISOString().slice(0, 10);
  localStorage.setItem(TOKEN_USAGE_KEY, JSON.stringify(current));
}

export function resetTokenUsage(): void {
  localStorage.removeItem(TOKEN_USAGE_KEY);
}

// ─── Nuke everything ───────────────────────────────────────

export async function eraseAll(): Promise<void> {
  if (isCloud()) {
    const sb = getSupabase();
    // RLS ensures we only delete our own data
    await sb.from('files').delete().neq('id', '');
    await sb.from('documents').delete().neq('id', '');
    await sb.from('bills').delete().neq('id', '');
    await sb.from('services').delete().neq('id', '');
    return;
  }
  const db = await getDB();
  const tx = db.transaction(['services', 'bills', 'documents', 'files'], 'readwrite');
  await Promise.all([
    tx.objectStore('services').clear(),
    tx.objectStore('bills').clear(),
    tx.objectStore('documents').clear(),
    tx.objectStore('files').clear(),
    tx.done,
  ]);
}
