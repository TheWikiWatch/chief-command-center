"use client";

import { useEffect, useSyncExternalStore } from "react";

import { setOwnerName } from "@/lib/identity";
import { rememberVaultRoot } from "@/lib/vault-client";
import { requestJson } from "@/lib/request";

/**
 * The install's public configuration (/api/app/config): the owner's name and which optional features
 * exist. Fetched once per page; the last answer is remembered on this device so a reload doesn't flash
 * features in and out while the request is in flight.
 */
export type AppFeatures = { fleetHealth: boolean; today: boolean; vault: boolean };
export type ClientAppConfig = { ownerName: string; vaultRoot: string; features: AppFeatures };

const KEY = "chief-app-config";
const NONE: ClientAppConfig = { ownerName: "", vaultRoot: "", features: { fleetHealth: false, today: false, vault: false } };

let current: ClientAppConfig = readCached() ?? NONE;
let started = false;
const listeners = new Set<() => void>();

function readCached(): ClientAppConfig | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = JSON.parse(localStorage.getItem(KEY) || "null") as ClientAppConfig | null;
    return raw && typeof raw === "object" && raw.features ? { ...NONE, ...raw, features: { ...NONE.features, ...raw.features } } : null;
  } catch {
    return null;
  }
}

function set(next: ClientAppConfig) {
  current = next;
  setOwnerName(next.ownerName);
  rememberVaultRoot(next.vaultRoot);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
  for (const listener of listeners) listener();
}

export async function loadAppConfig(): Promise<ClientAppConfig> {
  const data = await requestJson<{ ok?: boolean } & Partial<ClientAppConfig>>("/api/app/config");
  const next: ClientAppConfig = {
    ownerName: String(data.ownerName || ""),
    vaultRoot: String(data.vaultRoot || ""),
    features: { ...NONE.features, ...(data.features || {}) },
  };
  set(next);
  return next;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The install's config; loads it the first time any component asks. */
export function useAppConfig(): ClientAppConfig {
  useEffect(() => {
    if (started) return;
    started = true;
    setOwnerName(current.ownerName);
    rememberVaultRoot(current.vaultRoot);
    loadAppConfig().catch(() => {
      started = false; // try again on the next mount
    });
  }, []);
  return useSyncExternalStore(subscribe, () => current, () => NONE);
}
