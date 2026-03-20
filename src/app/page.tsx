"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, X as XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { AnimatePresence, motion } from "framer-motion";

type StoredReferencePayload = { mimeType: string; data: string };

type GeneratedImage = {
  id: string;
  prompt: string;
  public_url: string;
  created_at: string | null;
  aspect_ratio: string | null;
  quality: string | null;
  requested_count: number | null;
  reference_images: StoredReferencePayload[];
  estimated_cost_usd: number | null;
  currency: string | null;
  model: string | null;
  pricing_version: string | null;
};

function Spinner() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 animate-spin"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" opacity="0.25" />
      <path d="M22 12a10 10 0 0 0-10-10" />
    </svg>
  );
}

type ReferenceImage = {
  id: string;
  previewUrl: string;
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2].replace(/\s/g, "") };
}

function parseReferenceImagesColumn(raw: unknown): StoredReferencePayload[] {
  if (!raw || !Array.isArray(raw)) return [];
  const out: StoredReferencePayload[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as { mimeType?: unknown; data?: unknown };
    if (typeof o.mimeType !== "string" || typeof o.data !== "string") continue;
    out.push({ mimeType: o.mimeType, data: o.data });
  }
  return out;
}

function storedRefsToReferences(refs: StoredReferencePayload[]): ReferenceImage[] {
  const out: ReferenceImage[] = [];
  for (let i = 0; i < Math.min(4, refs.length); i++) {
    const r = refs[i];
    if (!r?.mimeType || typeof r.data !== "string") continue;
    const data = r.data.replace(/\s/g, "");
    try {
      const previewUrl = `data:${r.mimeType};base64,${data}`;
      out.push({
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `ref-${Date.now()}-${i}`,
        previewUrl,
      });
    } catch {
      // invalid base64
    }
  }
  return out;
}

function skeletonAspectClass(ratio: string): string {
  if (ratio === "1:1") return "aspect-square";
  if (ratio === "16:9") return "aspect-video";

  const parts = ratio.split(":");
  if (parts.length !== 2) return "aspect-square";

  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return "aspect-square";
  }

  return `aspect-[${width}/${height}]`;
}

function ratioToCssAspect(ratio: string): string {
  const parts = ratio.split(":");
  if (parts.length !== 2) return "1 / 1";

  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return "1 / 1";
  }
  return `${width} / ${height}`;
}

function sortImagesNewestFirst(items: GeneratedImage[]): GeneratedImage[] {
  return [...items].sort((a, b) => {
    const aTs = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
    const bTs = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
    return bTs - aTs;
  });
}

const aspectRatioOptions = [
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "5:4",
  "4:5",
  "16:9",
  "9:16",
  "21:9",
  "9:21",
] as const;
const qualityOptions = ["1K", "2K", "4K"] as const;
const countOptions = [1, 2, 3, 4] as const;
const GALLERY_PAGE_SIZE = 60;

const ISLAND_DRAFT_STORAGE_KEY = "nano-banana:island-draft";
const ISLAND_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ISLAND_DRAFT_DB_NAME = "nano-banana-db";
const ISLAND_DRAFT_STORE_NAME = "drafts";
const ISLAND_DRAFT_IDB_KEY = "island-draft-v2";
const PENDING_GENERATIONS_STORAGE_KEY = "nano-banana:pending-generations:v1";
const PENDING_GENERATIONS_TTL_MS = 15 * 60 * 1000;

type IslandDraftV1 = {
  v: 1;
  prompt: string;
  aspectRatio: string;
  quality: string;
  count: number;
};

type IslandDraftV2 = {
  v: 2;
  prompt: string;
  aspectRatio: string;
  quality: string;
  count: number;
  references: string[];
  updatedAt: number;
};

type LocalGenerationMeta = {
  aspect_ratio: string;
  quality: string;
  requested_count: number;
  reference_images: StoredReferencePayload[];
};

type PendingGeneration = {
  id: string;
  aspectRatio: string;
  count: number;
  prompt: string;
  startedAt: number;
};

const LOCAL_GENERATION_META_KEY = "nano-banana:generation-meta:v1";

function readLocalGenerationMeta(): Record<string, LocalGenerationMeta> {
  try {
    const raw = localStorage.getItem(LOCAL_GENERATION_META_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, LocalGenerationMeta> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const o = v as Partial<LocalGenerationMeta>;
      if (
        typeof o.aspect_ratio !== "string" ||
        typeof o.quality !== "string" ||
        typeof o.requested_count !== "number"
      ) {
        continue;
      }
      out[k] = {
        aspect_ratio: o.aspect_ratio,
        quality: o.quality,
        requested_count: Math.min(4, Math.max(1, Math.floor(o.requested_count))),
        reference_images: parseReferenceImagesColumn(o.reference_images),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeLocalGenerationMeta(meta: Record<string, LocalGenerationMeta>) {
  try {
    localStorage.setItem(LOCAL_GENERATION_META_KEY, JSON.stringify(meta));
  } catch {
    // ignore quota/private mode
  }
}

function readPendingGenerations(): PendingGeneration[] {
  try {
    const raw = localStorage.getItem(PENDING_GENERATIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed
      .filter((item): item is PendingGeneration => {
        if (!item || typeof item !== "object") return false;
        const x = item as Partial<PendingGeneration>;
        return (
          typeof x.id === "string" &&
          typeof x.aspectRatio === "string" &&
          typeof x.count === "number" &&
          Number.isInteger(x.count) &&
          x.count >= 1 &&
          x.count <= 4 &&
          typeof x.prompt === "string" &&
          typeof x.startedAt === "number" &&
          Number.isFinite(x.startedAt) &&
          now - x.startedAt <= PENDING_GENERATIONS_TTL_MS
        );
      })
      .map((x) => ({
        id: x.id,
        aspectRatio: x.aspectRatio,
        count: x.count,
        prompt: x.prompt,
        startedAt: x.startedAt,
      }));
  } catch {
    return [];
  }
}

function writePendingGenerations(items: PendingGeneration[]) {
  try {
    localStorage.setItem(PENDING_GENERATIONS_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore
  }
}

function openIslandDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(ISLAND_DRAFT_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ISLAND_DRAFT_STORE_NAME)) {
        db.createObjectStore(ISLAND_DRAFT_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
  });
}

function idbGetIslandDraft(): Promise<IslandDraftV2 | null> {
  return openIslandDraftDb()
    .then(
      (db) =>
        new Promise<IslandDraftV2 | null>((resolve, reject) => {
          const tx = db.transaction(ISLAND_DRAFT_STORE_NAME, "readonly");
          const store = tx.objectStore(ISLAND_DRAFT_STORE_NAME);
          const req = store.get(ISLAND_DRAFT_IDB_KEY);
          req.onsuccess = () => {
            const value = req.result as IslandDraftV2 | undefined;
            resolve(value ?? null);
          };
          req.onerror = () =>
            reject(req.error ?? new Error("Failed to read draft from IndexedDB"));
          tx.oncomplete = () => db.close();
        }),
    )
    .catch(() => null);
}

function idbSetIslandDraft(payload: IslandDraftV2): Promise<void> {
  return openIslandDraftDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(ISLAND_DRAFT_STORE_NAME, "readwrite");
        const store = tx.objectStore(ISLAND_DRAFT_STORE_NAME);
        const req = store.put(payload, ISLAND_DRAFT_IDB_KEY);
        req.onsuccess = () => resolve();
        req.onerror = () =>
          reject(req.error ?? new Error("Failed to write draft to IndexedDB"));
        tx.oncomplete = () => db.close();
      }),
  );
}

function idbDeleteIslandDraft(): Promise<void> {
  return openIslandDraftDb()
    .then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(ISLAND_DRAFT_STORE_NAME, "readwrite");
          const store = tx.objectStore(ISLAND_DRAFT_STORE_NAME);
          const req = store.delete(ISLAND_DRAFT_IDB_KEY);
          req.onsuccess = () => resolve();
          req.onerror = () =>
            reject(req.error ?? new Error("Failed to delete draft from IndexedDB"));
          tx.oncomplete = () => db.close();
        }),
    )
    .catch(() => undefined);
}

function reconcilePendingGenerations(
  pending: PendingGeneration[],
  items: GeneratedImage[],
): PendingGeneration[] {
  return pending.filter((job) => {
    const matchedCount = items.filter((img) => {
      if (!img.created_at) return false;
      const createdTs = Date.parse(img.created_at);
      if (!Number.isFinite(createdTs)) return false;
      return createdTs >= job.startedAt && img.prompt === job.prompt;
    }).length;
    return matchedCount < job.count;
  });
}

function isAspectRatioValue(
  value: unknown,
): value is (typeof aspectRatioOptions)[number] {
  return (
    typeof value === "string" &&
    (aspectRatioOptions as readonly string[]).includes(value)
  );
}

function isQualityValue(value: unknown): value is (typeof qualityOptions)[number] {
  return (
    typeof value === "string" &&
    (qualityOptions as readonly string[]).includes(value)
  );
}

export default function Home() {
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingGenerations, setPendingGenerations] = useState<PendingGeneration[]>(
    [],
  );
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [quality, setQuality] = useState("1K");
  const [count, setCount] = useState(1);
  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const formRef = useRef<HTMLFormElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [copiedGalleryId, setCopiedGalleryId] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<GeneratedImage | null>(null);
  const [islandDraftHydrated, setIslandDraftHydrated] = useState(false);
  const isGenerating = pendingGenerations.length > 0;
  const totalSpentUsd = images.reduce(
    (sum, img) => sum + (img.estimated_cost_usd ?? 0),
    0,
  );

  useEffect(() => {
    setPendingGenerations(readPendingGenerations());
  }, []);

  useEffect(() => {
    writePendingGenerations(pendingGenerations);
  }, [pendingGenerations]);

  useEffect(() => {
    setPendingGenerations((prev) => reconcilePendingGenerations(prev, images));
  }, [images]);

  useEffect(() => {
    const applyDraft = (d: Partial<IslandDraftV1 | IslandDraftV2>) => {
      if (typeof d.prompt === "string") setPrompt(d.prompt);
      if (isAspectRatioValue(d.aspectRatio)) setAspectRatio(d.aspectRatio);
      if (isQualityValue(d.quality)) setQuality(d.quality);
      if (
        typeof d.count === "number" &&
        Number.isInteger(d.count) &&
        d.count >= 1 &&
        d.count <= 4
      ) {
        setCount(d.count);
      }
      if (Array.isArray((d as Partial<IslandDraftV2>).references)) {
        const refs = (d as Partial<IslandDraftV2>).references!
          .filter((value): value is string => typeof value === "string")
          .slice(0, 4)
          .map((previewUrl, i) => ({
            id:
              typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `draft-ref-${Date.now()}-${i}`,
            previewUrl,
          }));
        setReferences(refs);
      }
    };

    let cancelled = false;
    (async () => {
      const now = Date.now();
      const idbDraft = await idbGetIslandDraft();
      if (cancelled) return;
      if (
        idbDraft &&
        idbDraft.v === 2 &&
        Number.isFinite(idbDraft.updatedAt) &&
        now - idbDraft.updatedAt <= ISLAND_DRAFT_TTL_MS
      ) {
        applyDraft(idbDraft);
        setIslandDraftHydrated(true);
        return;
      }

      try {
        const raw = localStorage.getItem(ISLAND_DRAFT_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (
            parsed &&
            typeof parsed === "object" &&
            "v" in parsed &&
            (parsed as { v: unknown }).v === 1
          ) {
            applyDraft(parsed as Partial<IslandDraftV1>);
          } else if (
            parsed &&
            typeof parsed === "object" &&
            "v" in parsed &&
            (parsed as { v: unknown }).v === 2
          ) {
            const d = parsed as Partial<IslandDraftV2>;
            const isFresh =
              typeof d.updatedAt === "number" &&
              Number.isFinite(d.updatedAt) &&
              now - d.updatedAt <= ISLAND_DRAFT_TTL_MS;
            if (isFresh) applyDraft(d);
            else localStorage.removeItem(ISLAND_DRAFT_STORAGE_KEY);
          }
        }
      } catch {
        // ignore corrupt storage
      }

      if (idbDraft && now - idbDraft.updatedAt > ISLAND_DRAFT_TTL_MS) {
        void idbDeleteIslandDraft();
      }
      setIslandDraftHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!islandDraftHydrated) return;
    const payload: IslandDraftV2 = {
      v: 2,
      prompt,
      aspectRatio,
      quality,
      count,
      references: references.map((ref) => ref.previewUrl).slice(0, 4),
      updatedAt: Date.now(),
    };
    void idbSetIslandDraft(payload);
    try {
      const fallbackPayload: IslandDraftV2 = { ...payload, references: [] };
      localStorage.setItem(ISLAND_DRAFT_STORAGE_KEY, JSON.stringify(fallbackPayload));
    } catch {
      // quota / private mode
    }
  }, [islandDraftHydrated, prompt, aspectRatio, quality, count, references]);

  useEffect(() => {
    let cancelled = false;

    const authHeaders = {
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!}`,
    };

    const parseRows = (
      data: unknown,
      hasExtendedFields: boolean,
      localMeta: Record<string, LocalGenerationMeta>,
    ): GeneratedImage[] =>
      (
        data as Array<{
          id: string | number;
          prompt: string | null;
          public_url: string | null;
          created_at?: string | null;
          aspect_ratio?: string | null;
          quality?: string | null;
          requested_count?: number | null;
          reference_images?: unknown;
          estimated_cost_usd?: number | null;
          currency?: string | null;
          model?: string | null;
          pricing_version?: string | null;
        }> | null
      )?.map((row) => {
        const id = String(row.id);
        const publicUrl = row.public_url ?? "";
        const byId = localMeta[`id:${id}`];
        const byUrl = publicUrl ? localMeta[`url:${publicUrl}`] : undefined;
        const fallbackMeta = byId ?? byUrl;

        const dbReferences = hasExtendedFields
          ? parseReferenceImagesColumn(row.reference_images)
          : [];

        return {
          id,
          prompt: row.prompt ?? "",
          public_url: publicUrl,
          created_at:
            typeof row.created_at === "string" ? row.created_at : null,
          aspect_ratio:
            (hasExtendedFields ? (row.aspect_ratio ?? null) : null) ??
            fallbackMeta?.aspect_ratio ??
            null,
          quality:
            (hasExtendedFields ? (row.quality ?? null) : null) ??
            fallbackMeta?.quality ??
            null,
          requested_count:
            (hasExtendedFields &&
            typeof row.requested_count === "number" &&
            Number.isInteger(row.requested_count)
              ? row.requested_count
              : null) ??
            fallbackMeta?.requested_count ??
            null,
          reference_images:
            dbReferences.length > 0
              ? dbReferences
              : (fallbackMeta?.reference_images ?? []),
          estimated_cost_usd:
            hasExtendedFields &&
            typeof row.estimated_cost_usd === "number" &&
            Number.isFinite(row.estimated_cost_usd)
              ? row.estimated_cost_usd
              : null,
          currency: hasExtendedFields ? (row.currency ?? "USD") : null,
          model: hasExtendedFields ? (row.model ?? null) : null,
          pricing_version: hasExtendedFields ? (row.pricing_version ?? null) : null,
        };
      }) ?? [];

    const load = async () => {
      const extendedSelect =
        "id,prompt,public_url,created_at,aspect_ratio,quality,requested_count,estimated_cost_usd,currency,model,pricing_version";
      const baseSelect = "id,prompt,public_url,created_at";

      const localMeta = readLocalGenerationMeta();

      const extendedRes = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/generated_images?select=${extendedSelect}&order=created_at.desc&limit=${GALLERY_PAGE_SIZE}`,
        { headers: authHeaders },
      );

      if (extendedRes.ok) {
        const data = await extendedRes.json();
        if (cancelled) return;
        const rows = parseRows(data, true, localMeta);
        setImages(sortImagesNewestFirst(rows.filter((r) => r.public_url)));
        return;
      }

      const fallbackRes = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/generated_images?select=${baseSelect}&order=created_at.desc&limit=${GALLERY_PAGE_SIZE}`,
        { headers: authHeaders },
      );

      if (!fallbackRes.ok) return;
      const data = await fallbackRes.json();
      if (cancelled) return;
      const rows = parseRows(data, false, localMeta);
      setImages(sortImagesNewestFirst(rows.filter((r) => r.public_url)));
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const addReferenceFiles = async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) return;

    setErrorMessage(null);

    const next = await Promise.all(
      imageFiles.slice(0, 4).map(async (file) => {
        const id =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${file.name}`;

        return {
          id,
          previewUrl: await readFileAsDataUrl(file),
        } satisfies ReferenceImage;
      }),
    );

    setReferences((prev) => [...prev, ...next].slice(0, 4));
  };

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;

      const imageFiles = Array.from(items)
        .filter((item) => item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));

      if (imageFiles.length === 0) return;

      event.preventDefault();
      void addReferenceFiles(imageFiles);
    };

    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    setErrorMessage(null);
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setErrorMessage("Enter a description.");
      return;
    }

    const requestId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    const startedAt = Date.now();
    setPendingGenerations((prev) => [
      ...prev,
      { id: requestId, aspectRatio, count, prompt: trimmedPrompt, startedAt },
    ]);
    try {
      const referenceImages = references.map((r) => {
        const parsed = parseDataUrl(r.previewUrl);
        if (!parsed) throw new Error("Invalid reference image format.");
        return parsed;
      });

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: trimmedPrompt,
          aspectRatio,
          quality,
          count,
          referenceImages,
        }),
      });

      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(json?.error ?? "Generation failed.");
      }

      const json = (await res.json()) as {
        results: Array<{
          id: string;
          prompt: string;
          public_url: string;
          aspectRatio?: string;
          quality?: string;
          count?: number;
          referenceImages?: StoredReferencePayload[];
          estimatedCostUsd?: number;
          currency?: string;
          model?: string;
          pricingVersion?: string;
        }>;
      };

      const created = json.results.map((r) => ({
        id: String(r.id),
        prompt: r.prompt ?? trimmedPrompt,
        public_url: r.public_url,
        created_at: null,
        aspect_ratio: r.aspectRatio ?? aspectRatio,
        quality: r.quality ?? quality,
        requested_count:
          typeof r.count === "number" &&
          Number.isInteger(r.count) &&
          r.count >= 1 &&
          r.count <= 4
            ? r.count
            : count,
        reference_images: parseReferenceImagesColumn(
          r.referenceImages !== undefined ? r.referenceImages : referenceImages,
        ),
        estimated_cost_usd:
          typeof r.estimatedCostUsd === "number" && Number.isFinite(r.estimatedCostUsd)
            ? r.estimatedCostUsd
            : null,
        currency: r.currency ?? "USD",
        model: r.model ?? "gemini-3-pro-image-preview",
        pricing_version: r.pricingVersion ?? null,
      }));

      const localMeta = readLocalGenerationMeta();
      for (const item of created) {
        const meta: LocalGenerationMeta = {
          aspect_ratio: item.aspect_ratio ?? "1:1",
          quality: item.quality ?? "1K",
          requested_count: item.requested_count ?? 1,
          reference_images: item.reference_images,
        };
        localMeta[`id:${item.id}`] = meta;
        localMeta[`url:${item.public_url}`] = meta;
      }
      writeLocalGenerationMeta(localMeta);

      setImages((prev) => sortImagesNewestFirst([...created, ...prev]));

    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setErrorMessage(message);
    } finally {
      setPendingGenerations((prev) => prev.filter((job) => job.id !== requestId));
    }
  };

  const applyGenerationFromGallery = async (img: GeneratedImage) => {
    setErrorMessage(null);
    setPrompt(img.prompt);

    const ar = img.aspect_ratio;
    if (ar && isAspectRatioValue(ar)) setAspectRatio(ar);
    else setAspectRatio("1:1");

    const q = img.quality;
    if (q && isQualityValue(q)) setQuality(q);
    else setQuality("1K");

    const c = img.requested_count;
    if (
      typeof c === "number" &&
      Number.isInteger(c) &&
      c >= 1 &&
      c <= 4
    ) {
      setCount(c);
    } else {
      setCount(1);
    }

    let refsPayload = img.reference_images;
    if (refsPayload.length === 0) {
      try {
        const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        if (baseUrl && anonKey) {
          const res = await fetch(
            `${baseUrl}/rest/v1/generated_images?select=reference_images&id=eq.${encodeURIComponent(img.id)}&limit=1`,
            {
              headers: {
                apikey: anonKey,
                Authorization: `Bearer ${anonKey}`,
              },
            },
          );
          if (res.ok) {
            const rows = (await res.json()) as Array<{ reference_images?: unknown }>;
            const fetched = parseReferenceImagesColumn(rows[0]?.reference_images);
            if (fetched.length > 0) {
              refsPayload = fetched;
              setImages((prev) =>
                prev.map((item) =>
                  item.id === img.id ? { ...item, reference_images: fetched } : item,
                ),
              );
            }
          }
        }
      } catch {
        // ignore
      }
    }

    const restoredRefs = storedRefsToReferences(refsPayload);
    setReferences(restoredRefs);
    if (restoredRefs.length === 0) {
      setErrorMessage(
        "Для этой генерации не сохранены исходные референсы, прикрепить их нельзя.",
      );
    }

    setCopiedGalleryId(img.id);
    window.setTimeout(() => {
      setCopiedGalleryId((cur) => (cur === img.id ? null : cur));
    }, 2000);

    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
      }
    });

    document.getElementById("nano-banana-input-island")?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  };

  const removeReference = (id: string) => {
    setReferences((prev) => prev.filter((r) => r.id !== id));
  };

  const onPickFiles = async (files: FileList | null) => {
    if (!files) return;
    await addReferenceFiles(Array.from(files));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedImage(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="h-screen bg-[#131315] text-white">
      <nav
        className="fixed top-0 left-0 right-0 z-50 flex h-16 w-full items-center justify-between bg-[#131315]/80 px-8 backdrop-blur-xl"
        aria-label="Primary"
      >
        <span className="text-xl font-bold tracking-tighter text-white">
          Nano Banana Pro
        </span>
        <span className="text-sm font-medium text-white/80">
          Total spent: ${totalSpentUsd.toFixed(4)}
        </span>
      </nav>
      <style>{`
        @keyframes nano-banana-gallery-shimmer {
          0% {
            background-position: 200% 0;
          }
          100% {
            background-position: -200% 0;
          }
        }
        .nano-banana-gallery-skeleton-shimmer {
          background: linear-gradient(
            90deg,
            #1c1c1e 25%,
            #2a2a2a 50%,
            #1c1c1e 75%
          );
          background-size: 200% 100%;
          animation: nano-banana-gallery-shimmer 1.5s infinite;
        }
        @property --nano-banana-angle {
          syntax: "<angle>";
          initial-value: 0deg;
          inherits: false;
        }
        @keyframes nano-banana-island-border-spin {
          to {
            --nano-banana-angle: 360deg;
          }
        }
        .nano-banana-island-frame {
          border: 1px solid transparent;
          border-radius: 20px;
          background:
            linear-gradient(rgba(27, 27, 29, 0.9), rgba(27, 27, 29, 0.9)) padding-box,
            linear-gradient(
              var(--nano-banana-angle),
              rgba(168, 85, 247, 0.78),
              rgba(255, 105, 180, 0.78),
              rgba(255, 75, 75, 0.78),
              rgba(168, 85, 247, 0.78)
            ) border-box;
          animation: nano-banana-island-border-spin 14s linear infinite;
        }
        @keyframes nano-banana-generate-glow {
          0%,
          100% {
            box-shadow: 0 0 0 rgba(168, 85, 247, 0);
          }
          50% {
            box-shadow: 0 0 24px rgba(168, 85, 247, 0.35);
          }
        }
      `}</style>
      <div className="h-full overflow-y-auto px-4 pb-72 pt-20">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {pendingGenerations.flatMap((job) =>
            Array.from({ length: job.count }).map((_, i) => (
            <div
              key={`skeleton-${job.id}-${i}`}
              className="overflow-hidden rounded-xl bg-[#1c1c1e]"
            >
              <div
                className="nano-banana-gallery-skeleton-shimmer w-full"
                style={{ aspectRatio: ratioToCssAspect(job.aspectRatio) }}
              />
            </div>
            )),
          )}
          {images.map((img) => (
            <div
              key={img.id}
              className="overflow-hidden rounded-xl bg-[#1f1f21]"
            >
              <div
                className="group relative cursor-zoom-in"
                onClick={() => setSelectedImage(img)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedImage(img);
                  }
                }}
                aria-label="Открыть изображение и детали"
              >
                <button
                  type="button"
                  aria-label="Скопировать промпт, настройки и референсы в форму"
                  title="Скопировать в форму"
                  className="absolute right-2 top-2 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void applyGenerationFromGallery(img);
                  }}
                >
                  {copiedGalleryId === img.id ? (
                    <Check className="h-4 w-4 text-[#c8f135]" aria-hidden />
                  ) : (
                    <Copy className="h-4 w-4" aria-hidden />
                  )}
                </button>
                <img
                  src={img.public_url}
                  alt={img.prompt}
                  className="block w-full h-auto"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                <div className="absolute left-0 right-0 bottom-0 p-3 opacity-0 transition-opacity group-hover:opacity-100">
                  <p className="text-sm leading-snug text-white">{img.prompt}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <AnimatePresence>
        {selectedImage ? (
          <motion.div
            key="modal-backdrop"
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelectedImage(null)}
          >
            <motion.div
              key="modal-content"
              className="max-h-[90vh] w-full max-w-6xl overflow-hidden rounded-2xl border border-white/10 bg-[#1B1B1D] shadow-2xl"
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ type: "spring", stiffness: 300, damping: 25 }}
              onClick={(e) => e.stopPropagation()}
            >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <p className="text-sm font-semibold text-white/90">Image details</p>
              <button
                type="button"
                aria-label="Закрыть модальное окно"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/5 text-white hover:bg-white/10"
                onClick={() => setSelectedImage(null)}
              >
                <XIcon size={16} />
              </button>
            </div>
            <div className="grid gap-0 md:grid-cols-[minmax(0,1fr)_360px]">
              <div className="max-h-[calc(90vh-56px)] overflow-auto bg-black/30 p-3">
                <img
                  src={selectedImage.public_url}
                  alt={selectedImage.prompt}
                  className="mx-auto h-auto w-full max-w-full rounded-xl object-contain"
                />
              </div>
              <div className="max-h-[calc(90vh-56px)] space-y-4 overflow-auto border-t border-white/10 p-4 md:border-l md:border-t-0">
                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-white/50">
                    Prompt
                  </p>
                  <p className="text-sm leading-relaxed text-white">
                    {selectedImage.prompt || "—"}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-lg bg-white/5 p-2">
                    <p className="text-[11px] uppercase text-white/50">Aspect ratio</p>
                    <p className="text-white">{selectedImage.aspect_ratio ?? "—"}</p>
                  </div>
                  <div className="rounded-lg bg-white/5 p-2">
                    <p className="text-[11px] uppercase text-white/50">Quality</p>
                    <p className="text-white">{selectedImage.quality ?? "—"}</p>
                  </div>
                  <div className="rounded-lg bg-white/5 p-2">
                    <p className="text-[11px] uppercase text-white/50">Count</p>
                    <p className="text-white">{selectedImage.requested_count ?? "—"}</p>
                  </div>
                  <div className="rounded-lg bg-white/5 p-2">
                    <p className="text-[11px] uppercase text-white/50">References</p>
                    <p className="text-white">{selectedImage.reference_images.length}</p>
                  </div>
                  <div className="rounded-lg bg-white/5 p-2">
                    <p className="text-[11px] uppercase text-white/50">Cost</p>
                    <p className="text-white">
                      {selectedImage.estimated_cost_usd !== null
                        ? `$${selectedImage.estimated_cost_usd.toFixed(4)}`
                        : "—"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-white/5 p-2">
                    <p className="text-[11px] uppercase text-white/50">Model</p>
                    <p className="truncate text-white">{selectedImage.model ?? "—"}</p>
                  </div>
                </div>
                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-white/50">ID</p>
                  <p className="break-all text-xs text-white/80">{selectedImage.id}</p>
                </div>
                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-white/50">
                    Created
                  </p>
                  <p className="text-sm text-white/80">
                    {selectedImage.created_at
                      ? new Date(selectedImage.created_at).toLocaleString()
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-white/50">
                    Public URL
                  </p>
                  <a
                    href={selectedImage.public_url}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all text-xs text-[#c8f135] hover:underline"
                  >
                    {selectedImage.public_url}
                  </a>
                </div>
              </div>
            </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div
        id="nano-banana-input-island"
        className="nano-banana-island-frame fixed left-1/2 bottom-6 z-50 w-[calc(100%-48px)] max-w-2xl -translate-x-1/2 overflow-hidden p-[1px]"
        style={{
          boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
        }}
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          void addReferenceFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <div className="relative rounded-[19px] bg-[#1B1B1D]/90 p-4 backdrop-blur-xl">
          <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-3">
            {errorMessage ? (
              <p className="text-sm text-red-400">{errorMessage}</p>
            ) : null}

            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {references.map((ref) => (
                  <div
                    key={ref.id}
                    className="relative h-16 w-16 overflow-hidden rounded-lg bg-white/5"
                  >
                    <img
                      src={ref.previewUrl}
                      alt="Reference image"
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      aria-label="Remove reference image"
                      className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => removeReference(ref.id)}
                    >
                      <XIcon size={14} />
                    </button>
                  </div>
                ))}

                {references.length < 4 ? (
                  <button
                    type="button"
                    aria-label="Add reference images"
                    className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-white/30 bg-transparent text-white/90 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <span className="text-3xl leading-none">+</span>
                  </button>
                ) : null}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void onPickFiles(e.target.files);
                  }}
                />
              </div>
            </div>

            <Textarea
              ref={textareaRef}
              rows={2}
              className="border-0 bg-transparent px-0 py-1 text-white placeholder:text-white/40 focus-visible:ring-0 focus-visible:border-0 resize-none"
              placeholder="Describe your image..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  formRef.current?.requestSubmit();
                }
              }}
            />

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-8 gap-1.5 rounded-full bg-white/5 px-3 text-xs text-white/90 hover:bg-white/10"
                    >
                      Ratio {aspectRatio}
                      <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[140px]">
                    <DropdownMenuLabel>Aspect ratio</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={aspectRatio}
                      onValueChange={(value) => setAspectRatio(value)}
                    >
                      {aspectRatioOptions.map((option) => (
                        <DropdownMenuRadioItem key={option} value={option}>
                          {option}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-8 gap-1.5 rounded-full bg-white/5 px-3 text-xs text-white/90 hover:bg-white/10"
                    >
                      Quality {quality}
                      <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[120px]">
                    <DropdownMenuLabel>Quality</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={quality}
                      onValueChange={(value) => setQuality(value)}
                    >
                      {qualityOptions.map((option) => (
                        <DropdownMenuRadioItem key={option} value={option}>
                          {option}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-8 gap-1.5 rounded-full bg-white/5 px-3 text-xs text-white/90 hover:bg-white/10"
                    >
                      Count {count}
                      <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[100px]">
                    <DropdownMenuLabel>Count</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={String(count)}
                      onValueChange={(value) => setCount(Number(value))}
                    >
                      {countOptions.map((option) => (
                        <DropdownMenuRadioItem key={option} value={String(option)}>
                          {option}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <button
                type="submit"
                className="whitespace-nowrap inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-[#a855f7] via-[#ff69b4] to-[#ff4b4b] px-5 py-2 text-sm font-semibold text-white transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-60"
                style={
                  isGenerating
                    ? {
                        animation: "nano-banana-generate-glow 1.6s ease-in-out infinite",
                      }
                    : undefined
                }
              >
                {isGenerating ? <Spinner /> : null}
                Generate
                <span className="ml-1 inline-flex items-center gap-1 rounded-md bg-black/15 px-1.5 py-0.5 text-[10px] font-medium text-black/80">
                  <span>⌘</span>
                  <span>Enter</span>
                </span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
