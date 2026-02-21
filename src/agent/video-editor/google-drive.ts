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
  };
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
  const localPath = path.join(process.cwd(), 'catalog-results.json');
  
  // Always save locally first as a fallback
  try {
    fs.writeFileSync(localPath, catalogJson, 'utf-8');
    console.log(`[google-drive] Local catalog saved: ${localPath}`);
  } catch (localErr) {
    console.warn('[google-drive] Failed to save local catalog:', localErr);
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
 * Organize videos based on a confirmed catalog
 * Moves files into the proper folder structure
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