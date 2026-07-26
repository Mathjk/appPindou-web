import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type Session, type User } from '@supabase/supabase-js';

import { normalizeLoadedAppData, prepareAppDataForCloud } from './storage';
import type { AppData } from './types';

const SUPABASE_URL = 'https://bjgxzxblwzwdsdgxznps.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_3lyN7_8dXPQvVgRk51ymyA_G1U6_dQZ';
const INTERNAL_AUTH_EMAIL_DOMAIN = 'users.app-pindou.example.com';
const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/;

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

export type AccountProfile = {
  id: string;
  username: string;
  recovery_email?: string | null;
  updated_at?: string | null;
};

export type CloudSnapshotMeta = {
  version: number;
  updated_at?: string | null;
  client_updated_at?: string | null;
};

export type CloudSnapshot = {
  data: AppData;
  meta: CloudSnapshotMeta;
};

export function normalizeAccountUsername(value: string) {
  return value.trim().toLowerCase();
}

export function validateAccountUsername(value: string) {
  const username = normalizeAccountUsername(value);
  if (!username) return '请输入用户名';
  if (!USERNAME_PATTERN.test(username)) return '用户名需为 3-32 位小写字母、数字、下划线或短横线';
  return '';
}

export function validateAccountPassword(value: string) {
  if (!value) return '请输入密码';
  if (value.length < 6) return '密码至少需要 6 位';
  return '';
}

function usernameToAuthEmail(username: string) {
  return `${normalizeAccountUsername(username)}@${INTERNAL_AUTH_EMAIL_DOMAIN}`;
}

function cleanRecoveryEmail(value?: string) {
  const trimmed = value?.trim();
  return trimmed || null;
}

export async function getCurrentAccountSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export function subscribeToAccountChanges(callback: (session: Session | null) => void) {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return () => subscription.unsubscribe();
}

export async function signUpWithUsername(usernameInput: string, password: string, recoveryEmail?: string) {
  const usernameError = validateAccountUsername(usernameInput);
  if (usernameError) throw new Error(usernameError);
  const passwordError = validateAccountPassword(password);
  if (passwordError) throw new Error(passwordError);

  const username = normalizeAccountUsername(usernameInput);
  const { data, error } = await supabase.auth.signUp({
    email: usernameToAuthEmail(username),
    password,
    options: {
      data: {
        username,
        recovery_email: cleanRecoveryEmail(recoveryEmail),
      },
    },
  });
  if (error) throw error;
  if (data.session?.user) {
    await upsertCurrentProfile(username, recoveryEmail);
  }
  return data;
}

export async function signInWithUsername(usernameInput: string, password: string) {
  const usernameError = validateAccountUsername(usernameInput);
  if (usernameError) throw new Error(usernameError);
  const passwordError = validateAccountPassword(password);
  if (passwordError) throw new Error(passwordError);

  const { data, error } = await supabase.auth.signInWithPassword({
    email: usernameToAuthEmail(usernameInput),
    password,
  });
  if (error) throw error;
  return data;
}

export async function signOutAccount() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

async function getCurrentUser() {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error) throw error;
  return user;
}

async function requireCurrentUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new Error('请先登录账号');
  return user;
}

export async function upsertCurrentProfile(usernameInput: string, recoveryEmail?: string) {
  const user = await requireCurrentUser();
  const username = normalizeAccountUsername(usernameInput);
  const { error } = await supabase.from('profiles').upsert(
    {
      id: user.id,
      username,
      recovery_email: cleanRecoveryEmail(recoveryEmail),
    },
    { onConflict: 'id' },
  );
  if (error) throw error;
}

export async function ensureProfileForSession(session: Session) {
  const username = normalizeAccountUsername(String(session.user.user_metadata?.username ?? ''));
  if (!username || !USERNAME_PATTERN.test(username)) return;
  await upsertCurrentProfile(username, String(session.user.user_metadata?.recovery_email ?? ''));
}

export async function fetchAccountProfile() {
  const user = await requireCurrentUser();
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, recovery_email, updated_at')
    .eq('id', user.id)
    .maybeSingle<AccountProfile>();
  if (error) throw error;
  return data;
}

export async function fetchCloudSnapshotMeta() {
  const user = await requireCurrentUser();
  const { data, error } = await supabase
    .from('app_snapshots')
    .select('version, updated_at, client_updated_at')
    .eq('user_id', user.id)
    .maybeSingle<CloudSnapshotMeta>();
  if (error) throw error;
  return data;
}

export async function saveCloudSnapshot(data: AppData) {
  const user = await requireCurrentUser();
  const clientUpdatedAt = new Date().toISOString();
  const snapshot = prepareAppDataForCloud(data);
  const { data: row, error } = await supabase
    .from('app_snapshots')
    .upsert(
      {
        user_id: user.id,
        version: 1,
        data: snapshot,
        client_updated_at: clientUpdatedAt,
      },
      { onConflict: 'user_id' },
    )
    .select('version, updated_at, client_updated_at')
    .single<CloudSnapshotMeta>();
  if (error) throw error;
  return row;
}

export async function loadCloudSnapshot() {
  const user = await requireCurrentUser();
  const { data: row, error } = await supabase
    .from('app_snapshots')
    .select('version, updated_at, client_updated_at, data')
    .eq('user_id', user.id)
    .maybeSingle<CloudSnapshotMeta & { data: Partial<AppData> }>();
  if (error) throw error;
  if (!row) return null;
  return {
    data: normalizeLoadedAppData(row.data),
    meta: {
      version: row.version,
      updated_at: row.updated_at,
      client_updated_at: row.client_updated_at,
    },
  } satisfies CloudSnapshot;
}

export function accountErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/relation .* does not exist|schema cache|permission denied|row-level security/i.test(message)) {
    return `Supabase 数据表或权限还没配置好：${message}`;
  }
  if (/Invalid login credentials/i.test(message)) return '用户名或密码不正确';
  if (/User already registered|already exists|duplicate key/i.test(message)) return '这个用户名已经被注册';
  if (/Email not confirmed/i.test(message)) return '当前 Supabase 项目要求邮箱确认，请先关闭 Auth 的邮箱确认后再使用用户名登录';
  return message || '账号操作失败';
}
