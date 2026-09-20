// worker.js - Cloudflare Worker for extracting ALL files from archives
import { unzipSync } from 'fflate';

// Files that must NEVER be served to the public
const BLOCKED_FILES = [
  'worker.js',
  'wrangler.toml',
  'package.json',
  'package-lock.json',
  '.gitignore',
  '.dev.vars',
  '.env',
];

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.slice(1).toLowerCase();

    // Block access to source files
    if (BLOCKED_FILES.includes(pathname)) {
      return new Response('Not Found', { status: 404, headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'online', service: 'Extract Sources' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Main extraction endpoint
    if (url.pathname === '/extract' && request.method === 'POST') {
      return handleExtract(request, corsHeaders, ctx);
    }

    // Let Cloudflare serve static files (index.html, etc.)
    return env.ASSETS.fetch(request);
  },
};

// ---------------- Main extraction handler ----------------

async function handleExtract(request, corsHeaders, ctx) {
  try {
    const formData = await request.formData();
    const webhookUrl = formData.get('webhook');
    const archiveFile = formData.get('archive');
    const delayMs = parseInt(formData.get('delay') || '300');
    const skipDuplicates = formData.get('skipDuplicates') !== 'false';

    if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      return jsonResponse({ error: 'Invalid Discord webhook URL' }, 400, corsHeaders);
    }

    if (!archiveFile) {
      return jsonResponse({ error: 'No archive file provided' }, 400, corsHeaders);
    }

    const arrayBuffer = await archiveFile.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    const fileName = archiveFile.name || 'archive.zip';

    // Extract all files recursively (handles nested ZIPs)
    const files = extractAllFiles(uint8, fileName);

    if (files.length === 0) {
      return jsonResponse({ error: 'No files found in archive' }, 400, corsHeaders);
    }

    // Deduplicate files by name (keeps first occurrence)
    const seen = new Set();
    const uniqueFiles = [];
    for (const file of files) {
      const key = file.name.toLowerCase();
      if (skipDuplicates && seen.has(key)) continue;
      seen.add(key);
      uniqueFiles.push(file);
    }

    // Stream progress as NDJSON
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    ctx.waitUntil((async () => {
      try {
        await writer.write(encoder.encode(
          JSON.stringify({
            type: 'start',
            total: uniqueFiles.length,
            duplicatesSkipped: files.length - uniqueFiles.length,
          }) + '\n'
        ));

        let sent = 0;
        let failed = 0;

        for (let i = 0; i < uniqueFiles.length; i++) {
          const file = uniqueFiles[i];
          try {
            await sendToDiscord(webhookUrl, file, i + 1, uniqueFiles.length);
            sent++;
            await writer.write(encoder.encode(
              JSON.stringify({
                type: 'progress',
                current: i + 1,
                total: uniqueFiles.length,
                file: file.name,
                size: file.data.length,
                status: 'sent',
              }) + '\n'
            ));
          } catch (err) {
            failed++;
            await writer.write(encoder.encode(
              JSON.stringify({
                type: 'progress',
                current: i + 1,
                total: uniqueFiles.length,
                file: file.name,
                status: 'failed',
                error: err.message,
              }) + '\n'
            ));
          }

          // 0.30s delay between files
          if (i < uniqueFiles.length - 1) {
            await sleep(delayMs);
          }
        }

        await writer.write(encoder.encode(
          JSON.stringify({ type: 'done', sent, failed, total: uniqueFiles.length }) + '\n'
        ));
      } catch (err) {
        await writer.write(encoder.encode(
          JSON.stringify({ type: 'error', message: err.message }) + '\n'
        ));
      } finally {
        await writer.close();
      }
    })());

    return new Response(readable, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, corsHeaders);
  }
}

// ---------------- Helpers ----------------

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Recursively extracts all files from ZIP archives.
 * Handles nested ZIPs. Skips directories.
 */
function extractAllFiles(uint8, fileName, depth = 0) {
  const results = [];
  if (depth > 10) return results; // Guard against zip bombs

  let entries;
  try {
    entries = unzipSync(uint8);
  } catch {
    // Not a valid zip - treat as single file
    if (depth === 0) {
      results.push({ name: fileName, data: uint8 });
    }
    return results;
  }

  for (const [entryName, entryData] of Object.entries(entries)) {
    if (entryName.endsWith('/') || entryData.length === 0) continue;

    const lower = entryName.toLowerCase();

    // Nested ZIP - recurse
    if (lower.endsWith('.zip') || isZipMagic(entryData)) {
      const nested = extractAllFiles(entryData, entryName, depth + 1);
      results.push(...nested);
    } else {
      const baseName = entryName.split('/').pop();
      results.push({ name: baseName, data: entryData });
    }
  }

  return results;
}

// ZIP magic bytes: 50 4B 03 04
function isZipMagic(data) {
  return (
    data.length >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07)
  );
}

/**
 * Sends a single file to Discord via webhook (multipart/form-data).
 */
async function sendToDiscord(webhookUrl, file, index, total) {
  const form = new FormData();

  let safeName = file.name.replace(/[/\\?%*:|"<>]/g, '_');
  if (safeName.length > 90) {
    const ext = safeName.includes('.') ? safeName.slice(safeName.lastIndexOf('.')) : '';
    safeName = safeName.slice(0, 80) + ext;
  }
  if (!safeName.includes('.')) safeName += '.txt';

  const blob = new Blob([file.data], { type: 'application/octet-stream' });
  form.append('file', blob, safeName);
  form.append('payload_json', JSON.stringify({
    content: `📦 **${index}/${total}** \`${safeName}\``,
  }));

  const res = await fetch(webhookUrl + '?wait=true', {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      const retryAfter = (parseFloat(res.headers.get('retry-after')) || 1) * 1000;
      await sleep(retryAfter + 100);
      const retry = await fetch(webhookUrl + '?wait=true', {
        method: 'POST',
        body: form,
      });
      if (!retry.ok) {
        throw new Error(`Discord error ${retry.status}: ${await retry.text()}`);
      }
      return;
    }
    throw new Error(`Discord error ${res.status}: ${text.slice(0, 200)}`);
  }
}
