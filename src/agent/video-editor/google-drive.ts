/**
 * Google Drive Integration for Video Editor Agent
 * 
 * Handles: listing raw footage, reading metadata, extracting thumbnails,
 * creating folder structure, and the Phase 0 cataloging workflow.
 * 
 * File: src/agent/video-editor/google-drive.ts
 */

import { drive_v3, auth as googleAuth } from '@googleapis/drive';
import * as path from 'path';
import * as fs from 'fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { supabaseAdmin } from '../../lib/supabase';

// --- Agentuity KV catalog persistence ---
// The catalog has no durable home on this platform: /data is not mounted
// (local file dies with the container), Drive uploads fail on service-account
// storage quota, and the cloud env has no Supabase credentials. The runtime's
// own KV storage needs none of those — the handler injects ctx.kv here once
// per request via setCatalogKV().
type CatalogKV = {
	get<T>(name: string, key: string): Promise<{ exists: boolean; data?: T }>;
	set<T>(name: string, key: string, value: T, params?: { contentType?: string }): Promise<void>;
};
let catalogKV: CatalogKV | null = null;
export function setCatalogKV(kv: CatalogKV): void {
	catalogKV = kv;
}

const KV_NAMESPACE = 'video-catalog';
// Chunk the gzip'd base64 so no single value approaches per-value size caps.
const KV_CHUNK_CHARS = 512 * 1024;

export async function saveCatalogToKV(catalogJson: string): Promise<boolean> {
	if (!catalogKV) return false;
	try {
		const b64 = gzipSync(Buffer.from(catalogJson, 'utf-8')).toString('base64');
		const chunks: string[] = [];
		for (let i = 0; i < b64.length; i += KV_CHUNK_CHARS) {
			chunks.push(b64.slice(i, i + KV_CHUNK_CHARS));
		}
		for (let i = 0; i < chunks.length; i++) {
			await catalogKV.set(KV_NAMESPACE, `main.${i}`, chunks[i]!);
		}
		// Manifest last, so a torn write leaves a stale-but-consistent manifest;
		// a mismatched read fails gunzip/parse and falls through to other sources.
		await catalogKV.set(
			KV_NAMESPACE,
			'main.manifest',
			JSON.stringify({ chunks: chunks.length, savedAt: new Date().toISOString() }),
		);
		console.log(`[google-drive] KV catalog backup saved (${chunks.length} chunk(s), ${Math.round(b64.length / 1024)}KB gz)`);
		return true;
	} catch (err) {
		console.warn('[google-drive] KV catalog backup failed:', (err as Error).message);
		return false;
	}
}

export async function fetchCatalogFromKV(): Promise<CatalogEntry[] | null> {
	if (!catalogKV) return null;
	try {
		const manifestRes = await catalogKV.get<string>(KV_NAMESPACE, 'main.manifest');
		if (!manifestRes.exists || manifestRes.data === undefined) return null;
		const rawManifest = manifestRes.data;
		const manifest = (typeof rawManifest === 'string' ? JSON.parse(rawManifest) : rawManifest) as { chunks: number };
		if (!manifest || typeof manifest.chunks !== 'number' || manifest.chunks < 1) return null;

		let b64 = '';
		for (let i = 0; i < manifest.chunks; i++) {
			const chunk = await catalogKV.get<string>(KV_NAMESPACE, `main.${i}`);
			if (!chunk.exists || typeof chunk.data !== 'string') {
				console.warn(`[google-drive] KV catalog chunk ${i} missing — backup unreadable`);
				return null;
			}
			b64 += chunk.data;
		}
		const parsed = JSON.parse(gunzipSync(Buffer.from(b64, 'base64')).toString('utf-8')) as CatalogEntry[];
		return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
	} catch (err) {
		console.warn('[google-drive] KV catalog read failed:', (err as Error).message);
		return null;
	}
}

// --- Auth Setup ---

/**
 * Get Google Drive authentication client
 *
 * Supports two credential sources:
 * 1. GOOGLE_SERVICE_ACCOUNT_JSON env var (for deployed Agentuity servers)
 * 2. File path from GOOGLE_APPLICATION_CREDENTIALS or default path (for local dev)
 */
export function getAuth() {
  let creds: { client_email: string; private_key: string };

  // Check for credentials in environment variable first (for deployed servers)
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    // Fall back to reading from file (for local development)
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
      || './credentials/google-cloud-service-account.json';
    creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  }

  return new googleAuth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file',
    ],
  });
}

function getDrive() {
  const authClient = getAuth();
  return new drive_v3.Drive({ auth: authClient });
}

// --- Types ---

export interface VideoFile {
  id: string;
  name: string;
  mimeType: string;
  size: string; // bytes as string
  createdTime: string;
  modifiedTime: string;
  thumbnailLink?: string;
  webViewLink?: string;
  webContentLink?: string;
  parentFolderId: string;
}

export interface CatalogEntry {
  fileId: string;
  filename: string;
  duration?: string;
  suspectedLocation: string;
  locationConfidence: 'high' | 'medium' | 'low' | 'unknown';
  locationClues: string;
  contentType: 'tennis_action' | 'chess' | 'interview' | 'event' | 'establishing' | 'mixed' | 'unknown';
  activity: string;
  peopleCount?: string;
  quality: 'excellent' | 'good' | 'fair' | 'poor';
  indoorOutdoor: 'indoor' | 'outdoor' | 'unknown';
  notableMoments?: string;
  readableText?: string;
  suggestedModes: ('game_day' | 'our_story' | 'quick_hit' | 'showcase')[];
  thumbnailLink?: string;
  needsManualReview: boolean;
  reviewNotes?: string;
  sceneAnalysis?: {
    duration: number;
    sceneChanges: Array<{ timestamp: number; score: number }>;
    highMotionMoments: number[];
    quietMoments: number[];
    recommendedHooks: number[];
    sceneDescriptions?: Array<{
      timestamp: number;
      description: string;
      isAction: boolean;
      actionType?: string;
      energyLevel: number;
      visualQuality: number;
      hookPotential: boolean;
    }>;
    namedSegments?: Array<{
      id: string;
      label: string;
      startTime: number;
      endTime: number;
      duration: number;
      type: 'action' | 'dialogue' | 'transition' | 'establishing' | 'quiet';
      energy: number;
      hookPotential: boolean;
      actionType?: string;
      cutSafety: {
        canCutAtStart: boolean;
        canCutAtEnd: boolean;
        bestEntryPoint: number;
        bestExitPoint: number;
        reason: string;
      };
    }>;
  };
  semanticTags?: string[];
  timestampScores?: Array<{
    timestamp: number;
    actionQuality: number;  // 1-10 composite
    movement: number;       // 1-5
    people: number;         // 1-5
    tennis: number;         // 1-5
    energy: number;         // 1-5
    /** 0.0-1.0: how much of frame the dominant subject fills.
     *  Acts as a multiplier on actionQuality so wall shots can't score high
     *  even if other axes are misjudged. Added 2026-04-27 — entries scored
     *  before this date may not have the field, treated as 0.30 default. */
    subjectFillRatio?: number;
    brief: string;          // 10-word-max description
    subjectPosition?: string; // where subjects are in frame: center, bottom-center, bottom-left, etc.
    /** 0-10: intensity of visible human FEELING, scored independently of athletic
     *  quality. A blank-faced perfect forehand is emotion 2; a kid covering their
     *  face after an easy miss is emotion 8. This is the axis the selection layer
     *  ranks hooks on. Added 2026-08-06 — entries scored before this are undefined. */
    emotion?: number;
    /** "positive" | "neutral" | "negative" — direction of the feeling above. */
    valence?: string;
    /** Narrative role this moment can play in an edit:
     *  hook | setup | struggle | turn | triumph | reflection | community | none */
    beat?: string;
  }>;
  visualTimeline?: {
    frames: Array<{
      timestamp: number;
      description: string;
      isAction: boolean;
      actionType: string;
      energy: number;        // 1-5
      hookPotential: boolean;
    }>;
    summary: string;
    bestMoments: number[];   // top timestamps by action quality
    actionWindows: Array<{ start: number; end: number; type: string; peakEnergy: number }>;
  };

  /** Narrative beats — populated at planning time by the Beat Finder (Step 0.5)
   *  via brief-aware re-interpretation of `visualTimeline.frames`. Composers
   *  prefer these over raw timestamp scoring when available. Optional because
   *  older catalog entries may lack visualTimeline (Beat Finder skips them). */
  narrativeBeats?: {
    setup: NarrativeBeat[];
    action: NarrativeBeat[];
    resolution: NarrativeBeat[];
    quiet: NarrativeBeat[];
    community: NarrativeBeat[];
    generatedAt: string;
  };
}

/** A single narrative beat tagged within a video by the Beat Finder step. */
export interface NarrativeBeat {
  timestamp: number;
  duration: number;
  description: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface FolderStructure {
  [location: string]: {
    folderId: string;
    subfolders: {
      [category: string]: string; // category name -> folder ID
    };
  };
}

// --- Core Functions ---

/**
 * List all video files in the root CLC footage folder
 */
export async function listVideoFiles(folderId?: string): Promise<VideoFile[]> {
  const drive = getDrive();
  const targetFolder = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!targetFolder) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID not set in environment');
  }

  const videos: VideoFile[] = [];
  let pageToken: string | undefined;

  do {
    const response = await drive.files.list({
      q: `'${targetFolder}' in parents and (mimeType contains 'video/') and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, thumbnailLink, webViewLink, webContentLink, parents)',
      pageSize: 100,
      pageToken,
      orderBy: 'name',
    });

    const files = response.data.files || [];
    
    for (const file of files) {
      videos.push({
        id: file.id!,
        name: file.name!,
        mimeType: file.mimeType!,
        size: file.size || '0',
        createdTime: file.createdTime!,
        modifiedTime: file.modifiedTime!,
        thumbnailLink: file.thumbnailLink || undefined,
        webViewLink: file.webViewLink || undefined,
        webContentLink: file.webContentLink || undefined,
        parentFolderId: targetFolder,
      });
    }

    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return videos;
}

/**
 * List all files recursively (including subfolders)
 */
export async function listAllVideoFilesRecursive(folderId?: string): Promise<VideoFile[]> {
  const drive = getDrive();
  const targetFolder = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!targetFolder) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID not set in environment');
  }

  const allVideos: VideoFile[] = [];

  // Get videos in this folder
  const videos = await listVideoFiles(targetFolder);
  allVideos.push(...videos);

  // Get subfolders
  const subfolders = await drive.files.list({
    q: `'${targetFolder}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
  });

  // Recurse into subfolders
  for (const folder of subfolders.data.files || []) {
    const subVideos = await listAllVideoFilesRecursive(folder.id!);
    allVideos.push(...subVideos);
  }

  return allVideos;
}

/**
 * Get detailed metadata for a specific video file
 */
export async function getVideoMetadata(fileId: string) {
  const drive = getDrive();

  const response = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, createdTime, modifiedTime, thumbnailLink, webViewLink, webContentLink, videoMediaMetadata, imageMediaMetadata, parents, description',
  });

  return response.data;
}

/**
 * Get thumbnail URL for a video (Google Drive generates these automatically)
 */
export async function getVideoThumbnail(fileId: string): Promise<string | null> {
  const drive = getDrive();

  const response = await drive.files.get({
    fileId,
    fields: 'thumbnailLink',
  });

  return response.data.thumbnailLink || null;
}

/**
 * Upgrade a Google Drive thumbnail URL to a higher resolution.
 * Google Drive thumbnails use a =sNNN suffix to control size (default s220).
 */
export function getHighResThumbnailUrl(thumbnailLink: string | undefined, size: number = 320): string | undefined {
  if (!thumbnailLink) return undefined;
  return thumbnailLink.replace(/=s\d+$/, `=s${size}`);
}

/**
 * Get download URL for a video file (for FFmpeg or Shotstack processing)
 */
export async function getVideoDownloadUrl(fileId: string): Promise<string> {
  // For service accounts, we can generate a direct download link
  // The file must be shared with the service account
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
}

/**
 * Download a video file to a local temp directory
 */
export async function downloadVideo(fileId: string, outputPath: string): Promise<string> {
  const drive = getDrive();

  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  const destPath = path.resolve(outputPath);
  const dest = fs.createWriteStream(destPath);

  return new Promise((resolve, reject) => {
    dest.on('error', (err: Error) => reject(err));
    (response.data as NodeJS.ReadableStream)
      .on('end', () => resolve(destPath))
      .on('error', (err: Error) => reject(err))
      .pipe(dest);
  });
}

// --- Folder Management ---

/**
 * Create a folder in Google Drive
 */
export async function createFolder(name: string, parentFolderId: string): Promise<string> {
  const drive = getDrive();

  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id',
  });

  return response.data.id!;
}

/**
 * Create the full CLC folder structure for organized footage
 * Returns a map of location -> folder IDs
 */
export async function createCatalogFolderStructure(rootFolderId?: string): Promise<FolderStructure> {
  const root = rootFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!root) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID not set in environment');
  }

  const locations = [
    'Hempstead',
    'Long Beach',
    'Brooklyn',
    'Westchester',
    'Connecticut',
    'Newark NJ',
    'Special Events',
    'Multi-Location',
    'Unidentified',
  ];

  const categories = [
    'Tennis Action',
    'Chess',
    'Interviews',
    'Events & Ceremonies',
  ];

  const specialEventCategories = [
    'US Open',
    'Other Events',
  ];

  // Create "CLC Organized Footage" parent folder
  const organizedRootId = await createFolder('CLC Organized Footage', root);

  const structure: FolderStructure = {};

  for (const location of locations) {
    const locationFolderId = await createFolder(location, organizedRootId);
    structure[location] = {
      folderId: locationFolderId,
      subfolders: {},
    };

    // Special Events has its own subcategories
    if (location === 'Special Events') {
      for (const eventCategory of specialEventCategories) {
        const eventFolderId = await createFolder(eventCategory, locationFolderId);
        structure[location].subfolders[eventCategory] = eventFolderId;
      }
    }
    // Multi-Location and Unidentified don't need subcategories
    else if (location !== 'Multi-Location' && location !== 'Unidentified') {
      for (const category of categories) {
        const categoryFolderId = await createFolder(category, locationFolderId);
        structure[location].subfolders[category] = categoryFolderId;
      }
    }
  }

  return structure;
}

/**
 * Move a file to a different folder in Google Drive
 */
export async function moveFile(fileId: string, newParentId: string, currentParentId: string): Promise<void> {
  const drive = getDrive();

  await drive.files.update({
    fileId,
    addParents: newParentId,
    removeParents: currentParentId,
    fields: 'id, parents',
  });
}

// --- Phase 0: Cataloging ---

/**
 * Generate a blank catalog from all videos in the folder
 * The AI agent will fill in the details by analyzing thumbnails/metadata
 */
export async function generateBlankCatalog(folderId?: string): Promise<CatalogEntry[]> {
  const videos = await listVideoFiles(folderId);

  return videos.map((video) => ({
    fileId: video.id,
    filename: video.name,
    suspectedLocation: 'unknown',
    locationConfidence: 'unknown' as const,
    locationClues: '',
    contentType: 'unknown' as const,
    activity: '',
    quality: 'good' as const,
    indoorOutdoor: 'unknown' as const,
    suggestedModes: [],
    thumbnailLink: video.thumbnailLink,
    needsManualReview: true,
    reviewNotes: 'Not yet analyzed',
  }));
}

/**
 * Save catalog to Google Drive as a JSON file for review
 * Falls back to local file (catalog-results.json) if Drive save fails
 */
export async function saveCatalog(catalog: CatalogEntry[], parentFolderId?: string): Promise<string> {
  const catalogJson = JSON.stringify(catalog, null, 2);
  // Use persistent volume (/data) on Railway, fall back to cwd for local dev
  const persistDir = fs.existsSync('/data') ? '/data' : process.cwd();
  const localPath = path.join(persistDir, 'catalog-results.json');

  // Always save locally first as a fallback
  try {
    fs.writeFileSync(localPath, catalogJson, 'utf-8');
    console.log(`[google-drive] Local catalog saved: ${localPath}`);
  } catch (localErr) {
    console.warn('[google-drive] Failed to save local catalog:', localErr);
  }

  // Platform KV first — needs no external credentials at all.
  await saveCatalogToKV(catalogJson);

  // Supabase Storage as a second durable copy when credentials exist (they
  // are absent in the current cloud env). The Drive upload below fails
  // silently — service accounts have no storage quota of their own, so
  // files.create into a personal-Drive folder is rejected.
  try {
    if (supabaseAdmin) {
      const { error } = await supabaseAdmin.storage
        .from('raw-videos')
        .upload('catalog/catalog-backup.json', catalogJson, {
          upsert: true,
          contentType: 'application/json',
        });
      if (error) {
        console.warn('[google-drive] Supabase catalog backup failed:', error.message);
      } else {
        console.log('[google-drive] Supabase catalog backup saved');
      }
    }
  } catch (err) {
    console.warn('[google-drive] Supabase catalog backup error:', (err as Error).message);
  }

  // Try to save to Google Drive
  try {
    const drive = getDrive();
    const root = parentFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID;

    if (!root) {
      throw new Error('GOOGLE_DRIVE_FOLDER_ID not set in environment');
    }

    const response = await drive.files.create({
      requestBody: {
        name: `video-catalog-${new Date().toISOString().split('T')[0]}.json`,
        mimeType: 'application/json',
        parents: [root],
      },
      media: {
        mimeType: 'application/json',
        body: catalogJson,
      },
      fields: 'id, webViewLink',
    });

    const driveLink = response.data.webViewLink || response.data.id!;
    console.log(`[google-drive] Drive catalog saved: ${driveLink}`);
    return driveLink;
  } catch (driveErr) {
    const errorMsg = driveErr instanceof Error ? driveErr.message : String(driveErr);
    console.warn(`[google-drive] Drive save failed: ${errorMsg}`);
    console.log(`[google-drive] Using local fallback: ${localPath}`);
    return `Local file: ${localPath}`;
  }
}

/**
 * Fetch the most recently saved catalog back OUT of Google Drive.
 *
 * saveCatalog() has always uploaded a dated copy to Drive, but nothing ever
 * read it back — loadExistingCatalog() checked only the local file and then
 * fell through to the bundled catalog-seed.json. On Railway without a /data
 * volume the local file lives on the container's ephemeral filesystem, so a
 * redeploy silently reverted the whole library to the un-enriched seed. The
 * log line even reads normally ("Loaded 247 entries from bundled catalog
 * seed"), so a day of backfill could disappear with no visible error.
 *
 * Note saveCatalog uses files.create, so each save writes a NEW dated file
 * rather than overwriting. We therefore sort by createdTime and take the
 * newest, not the first match on the name.
 */
export async function fetchLatestCatalogFromDrive(
  parentFolderId?: string,
): Promise<{ catalog: CatalogEntry[]; fileName: string } | null> {
  const root = parentFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!root) {
    console.warn('[google-drive] No GOOGLE_DRIVE_FOLDER_ID — cannot restore catalog from Drive');
    return null;
  }

  try {
    const drive = getDrive();
    const list = await drive.files.list({
      q: `'${root}' in parents and name contains 'video-catalog-' and trashed = false`,
      orderBy: 'createdTime desc',
      pageSize: 5,
      fields: 'files(id, name, createdTime, size)',
    });

    const files = list.data.files || [];
    if (files.length === 0) {
      console.log('[google-drive] No video-catalog-*.json found in Drive');
      return null;
    }

    // Take the newest that actually parses — a save interrupted mid-upload can
    // leave a truncated file, and silently loading a half-catalog is worse than
    // falling back to the seed.
    for (const f of files) {
      if (!f.id) continue;
      try {
        const res = await drive.files.get(
          { fileId: f.id, alt: 'media' },
          { responseType: 'text' },
        );
        const parsed = JSON.parse(String(res.data)) as CatalogEntry[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log(`[google-drive] Restored ${parsed.length} catalog entries from Drive: ${f.name}`);
          return { catalog: parsed, fileName: f.name || f.id };
        }
        console.warn(`[google-drive] ${f.name} parsed but was empty — trying the next newest`);
      } catch (err) {
        console.warn(`[google-drive] ${f.name} unreadable (${(err as Error).message}) — trying the next newest`);
      }
    }
    return null;
  } catch (err) {
    console.warn('[google-drive] Catalog restore from Drive failed:', (err as Error).message);
    return null;
  }
}

/**
 * Scan recent catalog backups and return the one with the MOST scored entries.
 *
 * fetchLatestCatalogFromDrive takes the newest file, which is wrong after a
 * wipe: a cold start that failed to hydrate falls back to the seed, and the
 * rescore loop then uploads new backups of the nearly-unscored catalog —
 * making "newest" the poisoned one while the pre-wipe backup with a day of
 * scoring sits one file older. Recovery must pick by content, not recency.
 */
export async function fetchBestScoredCatalogFromDrive(
  parentFolderId?: string,
): Promise<{ catalog: CatalogEntry[]; fileName: string; scoredCount: number; scanned: number } | null> {
  const root = parentFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!root) return null;

  try {
    const drive = getDrive();
    const list = await drive.files.list({
      q: `'${root}' in parents and name contains 'video-catalog-' and trashed = false`,
      orderBy: 'createdTime desc',
      pageSize: 15,
      fields: 'files(id, name, createdTime, size)',
    });

    const files = list.data.files || [];
    let best: { catalog: CatalogEntry[]; fileName: string; scoredCount: number } | null = null;
    let scanned = 0;

    for (const f of files) {
      if (!f.id) continue;
      try {
        const res = await drive.files.get(
          { fileId: f.id, alt: 'media' },
          { responseType: 'text' },
        );
        const parsed = JSON.parse(String(res.data)) as CatalogEntry[];
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
        scanned++;
        const scoredCount = parsed.filter(e => e.timestampScores && e.timestampScores.length > 0).length;
        console.log(`[google-drive] Backup ${f.name}: ${scoredCount} scored of ${parsed.length}`);
        if (!best || scoredCount > best.scoredCount) {
          best = { catalog: parsed, fileName: f.name || f.id, scoredCount };
        }
      } catch (err) {
        console.warn(`[google-drive] Backup ${f.name} unreadable: ${(err as Error).message}`);
      }
    }

    return best ? { ...best, scanned } : null;
  } catch (err) {
    console.warn('[google-drive] Backup scan failed:', (err as Error).message);
    return null;
  }
}

/**
 * Read the catalog backup out of Supabase Storage (see saveCatalog for why
 * this is the backup that actually survives restarts).
 */
export async function fetchCatalogFromSupabase(): Promise<CatalogEntry[] | null> {
  try {
    if (!supabaseAdmin) return null;
    const { data, error } = await supabaseAdmin.storage
      .from('raw-videos')
      .download('catalog/catalog-backup.json');
    if (error || !data) {
      console.warn('[google-drive] No Supabase catalog backup:', error?.message || 'empty');
      return null;
    }
    const parsed = JSON.parse(await data.text()) as CatalogEntry[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch (err) {
    console.warn('[google-drive] Supabase catalog read failed:', (err as Error).message);
    return null;
  }
}

/**
 * Organize videos based on a confirmed catalog
 * Moves videos into the proper folder structure
 */
export async function organizeVideosByCatalog(
  catalog: CatalogEntry[],
  folderStructure: FolderStructure,
  sourceFolderId?: string
): Promise<{ moved: number; skipped: number; errors: string[] }> {
  const sourceFolder = sourceFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!sourceFolder) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID not set in environment');
  }

  let moved = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const entry of catalog) {
    try {
      // Skip entries that still need review and send to Unidentified
      if (entry.needsManualReview || entry.suspectedLocation === 'Unknown') {
        if (folderStructure['Unidentified']) {
          await moveFile(entry.fileId, folderStructure['Unidentified'].folderId, sourceFolder);
          moved++;
        } else {
          skipped++;
        }
        continue;
      }

      let location = entry.suspectedLocation;
      
      // Handle special event routing
      if (location === 'US Open') {
        location = 'Special Events';
      } else if (location.startsWith('Special Event:')) {
        location = 'Special Events';
      }

      const locationFolder = folderStructure[location];

      if (!locationFolder) {
        errors.push(`No folder found for location: ${location} (file: ${entry.filename})`);
        skipped++;
        continue;
      }

      // Determine target subfolder based on content type or special event type
      let targetFolderId = locationFolder.folderId; // default to location root

      // For Special Events, route based on the original suspectedLocation
      if (location === 'Special Events') {
        if (entry.suspectedLocation === 'US Open') {
          targetFolderId = locationFolder.subfolders['US Open'] || locationFolder.folderId;
        } else if (entry.suspectedLocation.startsWith('Special Event:')) {
          targetFolderId = locationFolder.subfolders['Other Events'] || locationFolder.folderId;
        }
      } else {
        // For regular CLC locations, route by content type
        const contentTypeToFolder: Record<string, string> = {
          'tennis_action': 'Tennis Action',
          'chess': 'Chess',
          'interview': 'Interviews',
          'event': 'Events & Ceremonies',
        };

        const subfolderName = contentTypeToFolder[entry.contentType];
        if (subfolderName && locationFolder.subfolders[subfolderName]) {
          targetFolderId = locationFolder.subfolders[subfolderName];
        }
      }

      await moveFile(entry.fileId, targetFolderId, sourceFolder);
      moved++;

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to move ${entry.filename}: ${errorMsg}`);
    }
  }

  return { moved, skipped, errors };
}

// --- Utility ---

/**
 * Get a summary of what's in the Drive folder
 */
export async function getFolderSummary(folderId?: string): Promise<{
  totalFiles: number;
  totalSizeGB: number;
  videoFormats: Record<string, number>;
  dateRange: { earliest: string; latest: string };
}> {
  const videos = await listVideoFiles(folderId);

  const formats: Record<string, number> = {};
  let totalSize = 0;
  let earliest = '';
  let latest = '';

  for (const video of videos) {
    // Count formats
    const ext = video.name.split('.').pop()?.toLowerCase() || 'unknown';
    formats[ext] = (formats[ext] || 0) + 1;

    // Sum size
    totalSize += parseInt(video.size, 10) || 0;

    // Track date range
    if (!earliest || video.createdTime < earliest) earliest = video.createdTime;
    if (!latest || video.createdTime > latest) latest = video.createdTime;
  }

  return {
    totalFiles: videos.length,
    totalSizeGB: Math.round((totalSize / (1024 * 1024 * 1024)) * 100) / 100,
    videoFormats: formats,
    dateRange: { earliest, latest },
  };
}

/**
 * Check if the Drive connection is working
 */
export async function testConnection(): Promise<{ success: boolean; message: string }> {
  try {
    const drive = getDrive();
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    if (!folderId) {
      return { success: false, message: 'GOOGLE_DRIVE_FOLDER_ID not set in environment' };
    }

    const response = await drive.files.get({
      fileId: folderId,
      fields: 'id, name',
    });

    return {
      success: true,
      message: `Connected to folder: "${response.data.name}" (${response.data.id})`,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Connection failed: ${errorMsg}` };
  }
}

// --- Render Library (date-organized uploads) ---

/**
 * Find an existing subfolder by name, or create it if missing.
 */
async function findOrCreateFolder(name: string, parentId: string): Promise<string> {
  const drive = getDrive();
  const q = `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 });
  const existing = res.data.files?.[0]?.id;
  if (existing) {
    return existing;
  }
  return createFolder(name, parentId);
}

/**
 * Get or create a date-organized folder: Renders/YYYY/MM
 * Returns the month folder ID.
 */
export async function getOrCreateDateFolder(rootFolderId?: string): Promise<{ folderId: string; path: string }> {
  const root = rootFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!root) throw new Error('GOOGLE_DRIVE_FOLDER_ID not set');

  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');

  const rendersFolderId = await findOrCreateFolder('Renders', root);
  const yearFolderId = await findOrCreateFolder(year, rendersFolderId);
  const monthFolderId = await findOrCreateFolder(month, yearFolderId);

  return { folderId: monthFolderId, path: `Renders/${year}/${month}` };
}

/**
 * Download a video from a URL and upload it to Google Drive.
 * Used for saving rendered videos from S3 back to Drive.
 */
export async function uploadVideoFromUrl(
  url: string,
  filename: string,
  parentFolderId: string,
): Promise<{ fileId: string; webViewLink: string }> {
  // Fetch the video from the remote URL
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const { Readable } = await import('stream');
  const stream = Readable.from(buffer);

  const drive = getDrive();
  const driveRes = await drive.files.create({
    requestBody: {
      name: filename,
      mimeType: 'video/mp4',
      parents: [parentFolderId],
    },
    media: {
      mimeType: 'video/mp4',
      body: stream,
    },
    fields: 'id, webViewLink',
  });

  return {
    fileId: driveRes.data.id!,
    webViewLink: driveRes.data.webViewLink || `https://drive.google.com/file/d/${driveRes.data.id}/view`,
  };
}

/**
 * Upload a video file (Buffer) directly to Google Drive.
 * Used for user-uploaded videos via the Quick Edit feature.
 */
export async function uploadVideoFile(
  buffer: Buffer,
  filename: string,
  parentFolderId?: string,
): Promise<{ fileId: string; filename: string; webViewLink: string }> {
  const root = parentFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!root) throw new Error('GOOGLE_DRIVE_FOLDER_ID not set');

  const uploadsFolderId = await findOrCreateFolder('Quick Uploads', root);

  const { Readable } = await import('stream');
  const stream = Readable.from(buffer);

  const drive = getDrive();
  const driveRes = await drive.files.create({
    requestBody: {
      name: filename,
      mimeType: 'video/mp4',
      parents: [uploadsFolderId],
    },
    media: {
      mimeType: 'video/mp4',
      body: stream,
    },
    fields: 'id, webViewLink',
  });

  return {
    fileId: driveRes.data.id!,
    filename,
    webViewLink: driveRes.data.webViewLink || `https://drive.google.com/file/d/${driveRes.data.id}/view`,
  };
}