import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LEARNING_SOURCE_CATALOG, type LearningSourceKey } from "./source-catalog";

type ImportCursor = { after?: string | number; line?: number };
type ImportOptions = {
  sourceKey: LearningSourceKey;
  limit: number;
  cursor?: ImportCursor;
  rightsHolder?: string;
  authorizationEvidenceUrl?: string;
};

type SourceRow = { id: string; source_key: string };
type ImportedContent = {
  source_id: string;
  source_record_id: string;
  content_type: string;
  language: string;
  translation_language: string | null;
  content: Record<string, unknown>;
  normalized_text: string | null;
  topic_tags: string[];
  content_hash: string;
  license_id: string;
  attribution: Record<string, unknown>;
  moderation_status: "approved" | "pending";
  quality_score: number | null;
  last_verified_at: string;
};

type ImportResult = {
  imported: number;
  skipped: number;
  rejected: number;
  nextCursor: ImportCursor | null;
};

type TatoebaSentence = {
  id?: number;
  text?: string;
  lang?: string;
  license?: string;
  owner?: string | null;
  is_unapproved?: boolean;
  translations?: TatoebaSentence[] | TatoebaSentence[][];
};

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeText(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function safeLimit(value: number) {
  return Math.max(1, Math.min(500, Math.floor(value)));
}

async function ensureSource(admin: SupabaseClient, options: ImportOptions) {
  const source = LEARNING_SOURCE_CATALOG[options.sourceKey];
  if (source.sourceKind === "authorized_facebook_page" && (!options.rightsHolder || !options.authorizationEvidenceUrl)) {
    throw new Error("Facebook Page imports require a rights holder and public permission evidence URL");
  }
  const { data, error } = await admin.from("learning_sources").upsert({
    source_key: source.key,
    display_name: source.displayName,
    provider: source.provider,
    homepage_url: source.homepageUrl,
    data_url: source.dataUrl,
    license_id: source.licenseId,
    license_url: source.licenseUrl,
    attribution_text: source.attributionText,
    source_kind: source.sourceKind,
    rights_holder: options.rightsHolder ?? null,
    authorization_evidence_url: options.authorizationEvidenceUrl ?? null,
    terms_snapshot: {
      verifiedAt: new Date().toISOString(),
      catalogVersion: 1,
      noPrivateOrGroupScraping: true
    },
    enabled: true,
    updated_at: new Date().toISOString()
  }, { onConflict: "source_key" }).select("id, source_key").single();
  if (error || !data) throw new Error(error?.message ?? "Could not register learning source");
  return data as SourceRow;
}

function flattenTranslations(value: TatoebaSentence["translations"]): TatoebaSentence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => Array.isArray(item) ? item : [item]);
}

async function importTatoeba(admin: SupabaseClient, source: SourceRow, options: ImportOptions): Promise<ImportResult> {
  const limit = safeLimit(options.limit);
  const url = new URL("https://api.tatoeba.org/v1/sentences");
  url.searchParams.set("lang", "eng");
  url.searchParams.set("trans:lang", "vie");
  url.searchParams.set("trans:is_direct", "yes");
  url.searchParams.set("is_unapproved", "no");
  url.searchParams.set("showtrans", "matching");
  url.searchParams.set("showtrans:is_unapproved", "no");
  url.searchParams.set("limit", String(Math.min(100, limit)));
  if (options.cursor?.after != null) url.searchParams.set("after", String(options.cursor.after));

  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "LexiDuel/1.0 licensed-learning-import" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Tatoeba import failed with status ${response.status}`);
  const body = await response.json() as { data?: TatoebaSentence[]; paging?: { next?: string | null } };
  const rows: ImportedContent[] = [];
  let rejected = 0;

  for (const sentence of body.data ?? []) {
    const english = typeof sentence.text === "string" ? normalizeText(sentence.text) : "";
    const translations = flattenTranslations(sentence.translations).filter((item) => item.lang === "vie" && !item.is_unapproved);
    if (!sentence.id || !english || sentence.is_unapproved || translations.length === 0) { rejected += 1; continue; }
    const englishLicense = sentence.license || "CC BY 2.0 FR";
    for (const translation of translations) {
      const vietnamese = typeof translation.text === "string" ? normalizeText(translation.text) : "";
      if (!translation.id || !vietnamese) { rejected += 1; continue; }
      const translationLicense = translation.license || "CC BY 2.0 FR";
      const recordId = `${sentence.id}:${translation.id}`;
      const content = { english, vietnamese, englishSentenceId: sentence.id, vietnameseSentenceId: translation.id };
      rows.push({
        source_id: source.id,
        source_record_id: recordId,
        content_type: "sentence_pair",
        language: "en",
        translation_language: "vi",
        content,
        normalized_text: english.toLocaleLowerCase("en"),
        topic_tags: [],
        content_hash: sha256(JSON.stringify(content)),
        license_id: englishLicense === translationLicense ? englishLicense : `${englishLicense}; ${translationLicense}`,
        attribution: {
          source: "Tatoeba",
          sourceUrl: `https://tatoeba.org/en/sentences/show/${sentence.id}`,
          translationUrl: `https://tatoeba.org/en/sentences/show/${translation.id}`,
          englishOwner: sentence.owner ?? null,
          vietnameseOwner: translation.owner ?? null,
          englishLicense,
          vietnameseLicense: translationLicense
        },
        moderation_status: "approved",
        quality_score: 80,
        last_verified_at: new Date().toISOString()
      });
      if (rows.length >= limit) break;
    }
    if (rows.length >= limit) break;
  }

  const result = await persistRows(admin, rows);
  const next = body.paging?.next ? new URL(body.paging.next).searchParams.get("after") : null;
  return { ...result, rejected: rejected + result.rejected, nextCursor: next ? { after: next } : null };
}

async function importCmuDict(admin: SupabaseClient, source: SourceRow, options: ImportOptions): Promise<ImportResult> {
  const limit = safeLimit(options.limit);
  const startLine = Math.max(0, options.cursor?.line ?? 0);
  const response = await fetch(LEARNING_SOURCE_CATALOG.cmudict.dataUrl!, {
    headers: { Accept: "text/plain", "User-Agent": "LexiDuel/1.0 licensed-learning-import" },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`CMUdict import failed with status ${response.status}`);
  const lines = (await response.text()).split(/\r?\n/u);
  const rows: ImportedContent[] = [];
  let line = startLine;
  let rejected = 0;
  while (line < lines.length && rows.length < limit) {
    const raw = lines[line];
    line += 1;
    if (!raw || raw.startsWith(";;;")) continue;
    const separator = raw.indexOf(" ");
    if (separator < 1) { rejected += 1; continue; }
    const entry = raw.slice(0, separator).trim();
    const word = entry.replace(/\(\d+\)$/u, "").toLocaleLowerCase("en");
    const phonemes = raw.slice(separator).trim().split(/\s+/u);
    if (!word || phonemes.length === 0) { rejected += 1; continue; }
    const content = { word, pronunciationVariant: entry, arpabet: phonemes, stressPattern: phonemes.filter((phone) => /\d$/u.test(phone)).map((phone) => phone.at(-1)) };
    rows.push({
      source_id: source.id,
      source_record_id: entry,
      content_type: "pronunciation_entry",
      language: "en",
      translation_language: null,
      content,
      normalized_text: word,
      topic_tags: ["pronunciation", "american-english", "arpabet"],
      content_hash: sha256(`${entry}\n${phonemes.join(" ")}`),
      license_id: LEARNING_SOURCE_CATALOG.cmudict.licenseId,
      attribution: { source: "CMU Pronouncing Dictionary", sourceUrl: LEARNING_SOURCE_CATALOG.cmudict.homepageUrl, copyright: "1993-2015 Carnegie Mellon University" },
      moderation_status: "approved",
      quality_score: 95,
      last_verified_at: new Date().toISOString()
    });
  }
  const result = await persistRows(admin, rows);
  return { ...result, rejected: rejected + result.rejected, nextCursor: line < lines.length ? { line } : null };
}

async function importAuthorizedFacebookPage(admin: SupabaseClient, source: SourceRow, options: ImportOptions): Promise<ImportResult> {
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const graphVersion = process.env.FACEBOOK_GRAPH_VERSION || "v23.0";
  if (!token || !pageId) throw new Error("FACEBOOK_PAGE_ACCESS_TOKEN and FACEBOOK_PAGE_ID are required");
  const limit = Math.min(100, safeLimit(options.limit));
  const url = new URL(`https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(pageId)}/posts`);
  url.searchParams.set("fields", "id,message,permalink_url,created_time,updated_time");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("access_token", token);
  if (options.cursor?.after != null) url.searchParams.set("after", String(options.cursor.after));
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Facebook Graph API import failed with status ${response.status}`);
  const body = await response.json() as {
    data?: { id?: string; message?: string; permalink_url?: string; created_time?: string; updated_time?: string }[];
    paging?: { cursors?: { after?: string } };
  };
  const rows: ImportedContent[] = [];
  let rejected = 0;
  for (const post of body.data ?? []) {
    const message = typeof post.message === "string" ? normalizeText(post.message) : "";
    if (!post.id || message.length < 20 || message.length > 5000 || !post.permalink_url) { rejected += 1; continue; }
    const content = { text: message, permalinkUrl: post.permalink_url, publishedAt: post.created_time ?? null, updatedAt: post.updated_time ?? null };
    rows.push({
      source_id: source.id,
      source_record_id: post.id,
      content_type: "authorized_social_post",
      language: "en",
      translation_language: null,
      content,
      normalized_text: message.toLocaleLowerCase("en"),
      topic_tags: ["authorized-facebook-page"],
      content_hash: sha256(JSON.stringify(content)),
      license_id: "Rights-holder authorization",
      attribution: { source: "Facebook Page", pageId, rightsHolder: options.rightsHolder, authorizationEvidenceUrl: options.authorizationEvidenceUrl, permalinkUrl: post.permalink_url },
      moderation_status: "pending",
      quality_score: null,
      last_verified_at: new Date().toISOString()
    });
  }
  const result = await persistRows(admin, rows);
  const after = body.paging?.cursors?.after;
  return { ...result, rejected: rejected + result.rejected, nextCursor: after ? { after } : null };
}

async function importCoVoST(admin: SupabaseClient, source: SourceRow, options: ImportOptions): Promise<ImportResult> {
  const archiveUrl = process.env.COVOST_TSV_URL;
  if (!archiveUrl || !archiveUrl.startsWith("https://")) throw new Error("COVOST_TSV_URL must point to an authorized official CoVoST TSV archive over HTTPS");
  const limit = safeLimit(options.limit);
  const startLine = Math.max(1, options.cursor?.line ?? 1);
  const response = await fetch(archiveUrl, { headers: { Accept: "text/tab-separated-values,text/plain" }, cache: "no-store" });
  if (!response.ok) throw new Error(`CoVoST archive import failed with status ${response.status}`);
  if (!response.body) throw new Error("CoVoST archive returned no readable body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let headers: string[] | null = null;
  let sentenceIndex = -1;
  let translationIndex = -1;
  let pathIndex = -1;
  let dataLine = 0;
  let reachedEnd = false;
  const rows: ImportedContent[] = [];
  let rejected = 0;
  const processLine = (rawLine: string) => {
    if (!headers) {
      headers = rawLine.split("\t").map((value) => value.trim().toLocaleLowerCase("en"));
      sentenceIndex = headers.findIndex((value) => ["sentence", "source", "source_sentence", "english"].includes(value));
      translationIndex = headers.findIndex((value) => ["translation", "target", "target_sentence", "vietnamese"].includes(value));
      pathIndex = headers.findIndex((value) => ["path", "audio", "audio_path"].includes(value));
      if (sentenceIndex < 0 || translationIndex < 0) throw new Error("CoVoST TSV must include sentence and translation columns");
      return;
    }
    dataLine += 1;
    if (dataLine < startLine || rows.length >= limit) return;
    const values = rawLine.split("\t");
    const sourceText = normalizeText(values[sentenceIndex] ?? "");
    const translation = normalizeText(values[translationIndex] ?? "");
    const audioPath = pathIndex >= 0 ? normalizeText(values[pathIndex] ?? "") : "";
    const sourceRecordId = audioPath || `line:${dataLine + 1}`;
    if (!sourceText || !translation || sourceText.length > 2000 || translation.length > 2000) { rejected += 1; return; }
    const content = { english: sourceText, vietnamese: translation, audioPath: audioPath || null };
    rows.push({
      source_id: source.id, source_record_id: sourceRecordId, content_type: "sentence_pair", language: "en", translation_language: "vi",
      content, normalized_text: sourceText.toLocaleLowerCase("en"), topic_tags: ["speech-translation", "covost"],
      content_hash: sha256(JSON.stringify(content)), license_id: "CC0 1.0",
      attribution: { source: "Meta AI CoVoST 2", sourceUrl: process.env.COVOST_PUBLIC_PROVENANCE_URL || LEARNING_SOURCE_CATALOG["meta-covost"].homepageUrl, audioLicense: "Mozilla Common Voice CC0" },
      moderation_status: "approved", quality_score: 90, last_verified_at: new Date().toISOString()
    });
  };
  while (rows.length < limit) {
    const chunk = await reader.read();
    if (chunk.done) { reachedEnd = true; buffer += decoder.decode(); break; }
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) { processLine(line); if (rows.length >= limit) break; }
  }
  if (reachedEnd && buffer) processLine(buffer);
  if (!reachedEnd) await reader.cancel();
  if (!headers) throw new Error("CoVoST TSV archive is empty");
  const result = await persistRows(admin, rows);
  return { ...result, rejected: rejected + result.rejected, nextCursor: reachedEnd ? null : { line: dataLine + 1 } };
}

async function persistRows(admin: SupabaseClient, rows: ImportedContent[]): Promise<Omit<ImportResult, "nextCursor">> {
  if (rows.length === 0) return { imported: 0, skipped: 0, rejected: 0 };
  const { data, error } = await admin.from("learning_content")
    .upsert(rows, { onConflict: "source_id,source_record_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(error.message);
  const imported = data?.length ?? 0;
  return { imported, skipped: rows.length - imported, rejected: 0 };
}

export async function importLearningSource(admin: SupabaseClient, rawOptions: ImportOptions): Promise<ImportResult> {
  const options = { ...rawOptions, limit: safeLimit(rawOptions.limit) };
  const source = await ensureSource(admin, options);
  const { data: run, error: runError } = await admin.from("source_import_runs").insert({ source_id: source.id, status: "running", cursor_state: options.cursor ?? {}, started_at: new Date().toISOString() }).select("id").single();
  if (runError || !run) throw new Error(runError?.message ?? "Could not create source import run");
  try {
    let result: ImportResult;
    if (options.sourceKey === "tatoeba-en-vi") result = await importTatoeba(admin, source, options);
    else if (options.sourceKey === "cmudict") result = await importCmuDict(admin, source, options);
    else if (options.sourceKey === "authorized-facebook-page") result = await importAuthorizedFacebookPage(admin, source, options);
    else if (options.sourceKey === "meta-covost") result = await importCoVoST(admin, source, options);
    else throw new Error("Unsupported learning source");
    await Promise.all([
      admin.from("source_import_runs").update({ status: result.nextCursor ? "partial" : "completed", cursor_state: result.nextCursor ?? {}, imported_count: result.imported, skipped_count: result.skipped, rejected_count: result.rejected, completed_at: new Date().toISOString() }).eq("id", run.id),
      admin.from("learning_sources").update({ last_imported_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", source.id)
    ]);
    return result;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Source import failed";
    await admin.from("source_import_runs").update({ status: "failed", error_message: message.slice(0, 1800), completed_at: new Date().toISOString() }).eq("id", run.id);
    throw cause;
  }
}
