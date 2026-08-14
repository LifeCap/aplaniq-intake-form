import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startIntake } from '../../netlify/functions/intake-start.mjs';
import { uploadIntakeChunk } from '../../netlify/functions/intake-upload.mjs';
import { completeIntake } from '../../netlify/functions/intake-complete.mjs';
import { jsonResponse } from '../../netlify/functions/intake-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const port = Number(process.env.PORT || 4173);

function memoryStore(seed = {}) {
  const records = new Map(Object.entries(seed));
  return {
    async get(key) {
      return records.get(key) || null;
    },
    async set(key, value) {
      records.set(key, value);
    },
  };
}

function createDriveFetchMock() {
  let fileCounter = 0;
  let folderCounter = 0;
  let sessionCounter = 0;
  const sessions = new Map();

  return async (url, options = {}) => {
    const href = String(url);
    if (href.includes('oauth2.googleapis.com')) {
      return Response.json({ access_token: 'local-drive-token' });
    }

    if (href.includes('uploadType=resumable')) {
      const body = JSON.parse(options.body || '{}');
      const sessionId = `session-${++sessionCounter}`;
      sessions.set(sessionId, {
        size: Number(options.headers?.['x-upload-content-length'] || 0),
        received: 0,
        name: body.name || `file-${sessionCounter}`,
      });
      return new Response('', {
        status: 200,
        headers: { location: `mock://upload/${sessionId}` },
      });
    }

    if (href.startsWith('mock://upload/')) {
      const sessionId = href.slice('mock://upload/'.length);
      const session = sessions.get(sessionId);
      if (!session) return new Response('Missing upload session.', { status: 404 });

      let bodyBuffer = Buffer.alloc(0);
      if (Buffer.isBuffer(options.body)) bodyBuffer = options.body;
      else if (options.body instanceof ArrayBuffer) bodyBuffer = Buffer.from(options.body);
      else if (ArrayBuffer.isView(options.body)) bodyBuffer = Buffer.from(options.body.buffer, options.body.byteOffset, options.body.byteLength);
      else if (options.body && typeof options.body.arrayBuffer === 'function') bodyBuffer = Buffer.from(await options.body.arrayBuffer());
      const range = String(options.headers?.['content-range'] || '');
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      if (!match) return new Response('Missing content range.', { status: 400 });

      const start = Number(match[1]);
      const end = Number(match[2]);
      const total = Number(match[3]);
      if (start !== session.received || total !== session.size || end - start + 1 !== bodyBuffer.length) {
        return new Response('Out of sync.', { status: 409 });
      }

      session.received = end + 1;
      if (session.received < total) {
        return new Response('', {
          status: 308,
          headers: { range: `bytes=0-${session.received - 1}` },
        });
      }

      return Response.json({
        id: `file-${++fileCounter}`,
        webViewLink: `https://drive.example/file-${fileCounter}`,
      });
    }

    if (href.includes('drive/v3/files')) {
      if (href.includes('uploadType=multipart')) {
        return Response.json({
          id: `drive-file-${++fileCounter}`,
          webViewLink: `https://drive.example/file-${fileCounter}`,
        });
      }

      return Response.json({
        id: `drive-folder-${++folderCounter}`,
        webViewLink: `https://drive.example/folder-${folderCounter}`,
      });
    }

    return new Response('Unhandled mock fetch URL.', { status: 500 });
  };
}

const store = memoryStore();
const driveFetch = createDriveFetchMock();
const env = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REFRESH_TOKEN: 'refresh-token',
  GOOGLE_DRIVE_PARENT_FOLDER_ID: 'parent-folder',
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'hello@aplaniq.co',
  SMTP_PASSWORD: 'secret',
  SMTP_FROM: 'hello@aplaniq.co',
  INTAKE_RECIPIENT: 'hello@aplaniq.co',
};
const transport = {
  async sendMail() {
    return { messageId: 'local-message-1' };
  },
};

async function nodeRequestToWebRequest(req) {
  const origin = `http://127.0.0.1:${port}`;
  const url = new URL(req.url || '/', origin);
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const body = ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : Buffer.concat(bodyChunks);
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body,
    duplex: body ? 'half' : undefined,
  });
}

async function sendWebResponse(res, webResponse) {
  res.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => res.setHeader(key, value));
  const body = Buffer.from(await webResponse.arrayBuffer());
  res.end(body);
}

async function serveFile(res, filePath, contentType) {
  const file = await readFile(filePath);
  res.statusCode = 200;
  res.setHeader('content-type', contentType);
  res.end(file);
}

const server = createServer(async (req, res) => {
  try {
    if ((req.url || '/').startsWith('/.netlify/functions/intake-start')) {
      const request = await nodeRequestToWebRequest(req);
      const payload = await request.json();
      const result = await startIntake(payload, { env, fetch: driveFetch, store });
      return sendWebResponse(res, jsonResponse(result.ok ? 200 : result.status, result.ok ? result : { error: result.error }));
    }

    if ((req.url || '/').startsWith('/.netlify/functions/intake-upload')) {
      const request = await nodeRequestToWebRequest(req);
      const result = await uploadIntakeChunk(request, { fetch: driveFetch, store });
      return sendWebResponse(res, jsonResponse(result.ok ? 200 : result.status, result.ok ? {
        uploadComplete: result.uploadComplete,
        uploadedBytes: result.uploadedBytes,
        file: result.file,
      } : { error: result.error }));
    }

    if ((req.url || '/').startsWith('/.netlify/functions/intake-complete')) {
      const request = await nodeRequestToWebRequest(req);
      const payload = await request.json();
      const result = await completeIntake(payload, { env, fetch: driveFetch, store, transport });
      return sendWebResponse(res, jsonResponse(result.ok ? 200 : result.status, result.ok ? result : { error: result.error }));
    }

    if ((req.url || '/') === '/' || (req.url || '/').startsWith('/aplaniq_intake_form.html')) {
      return serveFile(res, path.join(rootDir, 'aplaniq_intake_form.html'), 'text/html; charset=utf-8');
    }

    if ((req.url || '/').startsWith('/aplaniq-wordmark-white-2048.png')) {
      return serveFile(res, path.join(rootDir, 'aplaniq-wordmark-white-2048.png'), 'image/png');
    }

    res.statusCode = 404;
    res.end('Not found');
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.end(error.message || 'Server error');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`E2E server listening on http://127.0.0.1:${port}`);
});
