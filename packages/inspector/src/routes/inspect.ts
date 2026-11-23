import { Router } from 'express';
import { inspectScreen, SCREENSHOT_MIME_TYPE } from '../lib/inspect-screen.js';
import { logger } from '../lib/logger.js';
import { DeviceError, DeviceManager } from '../lib/device-manager.js';
import { inspectWebView, listWebViews, locateWebViewXPath } from '../lib/webview-inspection.js';
import { timeoutAfter } from '../lib/timeout.js';

const WEBVIEW_LIST_TIMEOUT_MS = 10_000;

/**
 * Express router for the inspect endpoint.
 * GET /api/inspect — returns screenshot + element list from the same device moment.
 */
export function createInspectRouter(deviceManager: DeviceManager) {
  const router = Router();

  // GET /api/inspect
  // Returns screenshot + element list from the same moment (no drift).
  // GET /api/inspect?scale=0.5 — optional screenshot downscale factor, 0 < scale <= 1.
  // GET /api/inspect?etag=<etag> — 304 with no body when the capture still hashes to <etag>.
  router.get('/inspect', async (req, res) => {
    const scale = req.query.scale === undefined ? 1 : Number(req.query.scale);
    if (!(scale > 0 && scale <= 1)) {
      res.status(400).json({ error: 'scale must be a number between 0 (exclusive) and 1' });
      return;
    }

    // Claim the inspect slot before looking at the device: mid-switch there is briefly no device,
    // and that must read as "busy" (503), not "disconnected" (409).
    if (!deviceManager.beginInspect()) {
      res.status(503).json({ error: 'Inspect already in progress' });
      return;
    }

    try {
      const device = deviceManager.device;
      if (!device) {
        res.status(409).json({ error: 'No device selected' });
        return;
      }

      const { screenshot, screen, elements, etag } = await inspectScreen(device, scale, () => deviceManager.screenSize());
      if (req.query.etag === etag) {
        res.status(304).end();
        return;
      }

      res.json({
        screenshot: `data:${SCREENSHOT_MIME_TYPE};base64,${screenshot.toString('base64')}`,
        screen,
        elements,
        etag,
      });
    } catch (err) {
      logger.error(`Inspect failed: ${(err as Error).message}`);
      res.status(500).json({ error: (err as Error).message });
    } finally {
      deviceManager.endInspect();
    }
  });

  router.get('/webviews', async (_req, res) => {
    try {
      const webViews = await deviceManager.withDevice(device =>
        timeoutAfter(listWebViews(device), WEBVIEW_LIST_TIMEOUT_MS),
      );
      res.json({ webViews });
    } catch (err) {
      sendWebViewError(res, err, 'Webview discovery');
    }
  });

  router.get('/webview/inspect', async (req, res) => {
    const webViewId = req.query.webViewId;
    if (typeof webViewId !== 'string' || !webViewId) {
      res.status(400).json({ error: 'webViewId is required' });
      return;
    }

    try {
      const result = await deviceManager.withDevice(async device =>
        inspectWebView(device, webViewId, await deviceManager.screenSize()),
      );
      res.json(result);
    } catch (err) {
      sendWebViewError(res, err, 'Webview inspection');
    }
  });

  router.post('/webview/locate', async (req, res) => {
    const { webViewId, locator } = (req.body ?? {}) as { webViewId?: unknown; locator?: unknown };
    if (typeof webViewId !== 'string' || !webViewId) {
      res.status(400).json({ error: 'webViewId is required' });
      return;
    }
    if (typeof locator !== 'string' || !locator.trim()) {
      res.status(400).json({ error: 'locator must be a non-empty XPath expression' });
      return;
    }

    try {
      const matches = await deviceManager.withDevice(async device =>
        locateWebViewXPath(device, webViewId, locator, await deviceManager.screenSize()),
      );
      res.json({ matches });
    } catch (err) {
      sendWebViewError(res, err, 'Webview locator check');
    }
  });

  return router;
}

function sendWebViewError(res: import('express').Response, err: unknown, operation: string): void {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof DeviceError && err.code === 'not_found') {
    res.status(409).json({ error: message });
    return;
  }
  if (err instanceof DeviceError && err.code === 'in_progress') {
    res.status(503).json({ error: message });
    return;
  }
  if (message.startsWith('Invalid XPath locator:')) {
    res.status(400).json({ error: message });
    return;
  }
  if (message.startsWith('Operation timed out after')) {
    res.status(504).json({ error: message });
    return;
  }
  if (message.includes('was not found')) {
    res.status(404).json({ error: message });
    return;
  }
  logger.error(`${operation} failed: ${message}`);
  res.status(500).json({ error: message });
}
