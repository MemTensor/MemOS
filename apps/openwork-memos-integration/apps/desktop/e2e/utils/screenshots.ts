/**
 * Screenshot utilities for AI-powered visual testing.
 * Captures screenshots with metadata for automated evaluation.
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Types
// ============================================================================

export interface ScreenshotMetadata {
  testName: string;
  stateName: string;
  viewport: { width: number; height: number };
  route: string;
  timestamp: string;
  evaluationCriteria: string[];
}

export interface CaptureResult {
  success: boolean;
  path: string;
  error?: string;
}

// ============================================================================
// Screenshot Capture
// ============================================================================

/**
 * Capture a screenshot with metadata for AI evaluation.
 * Includes error handling to prevent test failures from screenshot issues.
 *
 * @param page - Playwright page to capture
 * @param testName - Name of the test (used in filename)
 * @param stateName - Description of the UI state (used in filename)
 * @param evaluationCriteria - List of criteria for AI evaluation
 * @returns Capture result with success status and path
 */
export async function captureForAI(
  page: Page,
  testName: string,
  stateName: string,
  evaluationCriteria: string[]
): Promise<CaptureResult> {
  const timestamp = Date.now();
  const sanitizedTestName = sanitizeFilename(testName);
  const sanitizedStateName = sanitizeFilename(stateName);
  const filename = `${sanitizedTestName}-${sanitizedStateName}-${timestamp}.png`;
  const screenshotDir = join(__dirname, '../test-results/screenshots');
  const screenshotPath = join(screenshotDir, filename);

  try {
    // Ensure directory exists
    await fs.mkdir(screenshotDir, { recursive: true });

    // Capture screenshot with animations disabled for consistency
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
      animations: 'disabled',
    });

    // Save metadata alongside screenshot
    const viewport = page.viewportSize() || { width: 1280, height: 720 };
    const metadata: ScreenshotMetadata = {
      testName,
      stateName,
      viewport,
      route: page.url(),
      timestamp: new Date().toISOString(),
      evaluationCriteria,
    };

    await fs.writeFile(
      screenshotPath.replace('.png', '.json'),
      JSON.stringify(metadata, null, 2)
    );

    return { success: true, path: screenshotPath };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[Screenshot] Failed to capture "${testName}/${stateName}": ${errorMessage}`);
    return { success: false, path: '', error: errorMessage };
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Sanitize a string for use in filenames.
 * Removes or replaces characters that are problematic in file paths.
 */
function sanitizeFilename(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}
