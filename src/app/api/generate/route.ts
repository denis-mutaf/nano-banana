import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { supabaseAdmin } from "@/lib/supabase";

type ReferenceImage = { mimeType: string; data: string };

type GeneratedImageRow = {
  id: string;
  prompt: string;
  public_url: string;
  aspectRatio: string;
  quality: string;
  count: number;
  referenceImages: ReferenceImage[];
  estimatedCostUsd: number;
  currency: string;
  model: string;
  pricingVersion: string;
};

const MODEL_ID = "gemini-3-pro-image-preview";
const PRICING_VERSION = "2026-03-20-v1";
const CURRENCY = "USD";

const qualityToResolution: Record<string, number> = {
  "1K": 1024,
  "2K": 2048,
  "4K": 4096,
};

const qualityBaseCostUsd: Record<string, number> = {
  "1K": 0.02,
  "2K": 0.04,
  "4K": 0.08,
};

function estimateCostUsdPerImage(
  quality: string,
  referenceCount: number,
): number {
  const base = qualityBaseCostUsd[quality] ?? qualityBaseCostUsd["1K"];
  const referenceFee = Math.min(4, Math.max(0, referenceCount)) * 0.0025;
  return Number((base + referenceFee).toFixed(6));
}

function safeString(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function clampCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(4, Math.max(1, Math.floor(n)));
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      prompt?: unknown;
      aspectRatio?: unknown;
      quality?: unknown;
      count?: unknown;
      referenceImages?: unknown;
    };

    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    const aspectRatio = safeString(body?.aspectRatio, "1:1");
    const quality = safeString(body?.quality, "1K");
    const count = clampCount(body?.count);
    const referenceImages = Array.isArray(body?.referenceImages)
      ? (body.referenceImages as unknown[]).filter(
          (v): v is ReferenceImage =>
            typeof v === "object" &&
            v !== null &&
            typeof (v as { mimeType?: unknown }).mimeType === "string" &&
            typeof (v as { data?: unknown }).data === "string",
        )
      : [];

    if (!prompt) {
      return NextResponse.json(
        { error: "Prompt is required." },
        { status: 400 },
      );
    }

    const resolutionPixels = qualityToResolution[quality] ?? 1024;
    const finalPrompt = `${prompt}. Aspect ratio: ${aspectRatio}. Image resolution: ${resolutionPixels} pixels on the longest side.`;
    const estimatedCostUsd = estimateCostUsdPerImage(
      quality,
      referenceImages.length,
    );

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Server misconfiguration: GEMINI_API_KEY is missing." },
        { status: 500 },
      );
    }

    const genAI = new GoogleGenAI({ apiKey });

    const imageParts = referenceImages.map((ref) => ({
      inlineData: { mimeType: ref.mimeType, data: ref.data.replace(/\s/g, "") },
    }));

    const textPart = { text: finalPrompt };
    const userContent = { role: "user", parts: [...imageParts, textPart] };

    const results = await Promise.all(
      Array.from({ length: count }).map(async (_, i) => {
        const response = await genAI.models.generateContent({
          model: MODEL_ID,
          contents: [userContent],
          config: { responseModalities: ["IMAGE", "TEXT"] },
        });

        const parts = response.candidates?.[0]?.content?.parts ?? [];
        const inlinePart = parts.find((part) => part?.inlineData?.data);
        const inlineData = inlinePart?.inlineData;

        if (!inlineData?.data || !inlineData?.mimeType) {
          throw new Error("Image was not returned by the model.");
        }

        const buffer = Buffer.from(inlineData.data, "base64");
        const storagePath = `generated-images/${Date.now()}-${i}.png`;

        const { error: uploadError } = await supabaseAdmin.storage
          .from("generated-images")
          .upload(storagePath, buffer, {
            contentType: inlineData.mimeType,
            upsert: false,
          });

        if (uploadError) {
          throw new Error(`Failed to upload image: ${uploadError.message}`);
        }

        const { data: publicData } = await supabaseAdmin.storage
          .from("generated-images")
          .getPublicUrl(storagePath);

        if (!publicData?.publicUrl) {
          throw new Error("Failed to get public URL for uploaded image.");
        }

        const public_url = publicData.publicUrl;

        let insertedId: string;
        const extendedInsert = await supabaseAdmin
          .from("generated_images")
          .insert({
            prompt,
            aspect_ratio: aspectRatio,
            storage_path: storagePath,
            public_url,
            quality,
            requested_count: count,
            reference_images: referenceImages,
            estimated_cost_usd: estimatedCostUsd,
            currency: CURRENCY,
            model: MODEL_ID,
            pricing_version: PRICING_VERSION,
          })
          .select("id")
          .single();

        if (extendedInsert.error) {
          const fallbackInsert = await supabaseAdmin
            .from("generated_images")
            .insert({
              prompt,
              aspect_ratio: aspectRatio,
              storage_path: storagePath,
              public_url,
            })
            .select("id")
            .single();

          if (fallbackInsert.error) {
            throw new Error(
              `Failed to insert database row: ${fallbackInsert.error.message}`,
            );
          }

          insertedId = String(fallbackInsert.data.id);
        } else {
          insertedId = String(extendedInsert.data.id);
        }

        return {
          id: insertedId,
          prompt,
          public_url,
          aspectRatio,
          quality,
          count,
          referenceImages,
          estimatedCostUsd,
          currency: CURRENCY,
          model: MODEL_ID,
          pricingVersion: PRICING_VERSION,
        } satisfies GeneratedImageRow;
      }),
    );

    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

