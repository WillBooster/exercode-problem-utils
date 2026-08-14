import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { isContainedPath } from './safeFs.js';
import { sandboxUserName } from './sandboxUser.js';

export interface HttpServer {
  [Symbol.asyncDispose](): Promise<void>;
  url: string;
  port: number | undefined;
}

/**
 * Start a HTTP server for testing web pages.
 */
export function startHttpServer(dir: string): HttpServer {
  const server = http.createServer((request, response) => {
    let pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

    if (pathname === '/') {
      pathname = '/index.html';
    }

    const pathnameWithIndexHtml = pathname.endsWith('/') ? path.join(pathname, 'index.html') : pathname;

    const filePath = path.join(dir, pathnameWithIndexHtml);

    // Under delegation this read runs as the trusted harness user while the served directory
    // belongs to the sandboxed submission, so a planted symlink (or symlinked parent) pointing at
    // e.g. the problem's expected outputs would otherwise be served straight back to the page.
    if (!isServableSubmissionPath(dir, filePath)) {
      response.statusCode = 404;
      response.end();
      return;
    }

    if (fs.existsSync(filePath)) {
      try {
        const buffer = fs.readFileSync(filePath);
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          'Content-Type': getContentType(pathnameWithIndexHtml),
        });
        response.end(buffer);
      } catch {
        response.statusCode = 500;
        response.end();
      }
    } else {
      response.statusCode = 404;
      response.end();
    }
  });

  server.listen();

  const address = server.address();
  if (!address) throw new Error('server has been unexpectedly closed');

  return {
    [Symbol.asyncDispose]: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
    url: typeof address === 'string' ? address : `http://127.0.0.1:${address.port}`,
    port: typeof address === 'object' ? address.port : undefined,
  };
}

const CONTENT_TYPE_BY_SUFFIX: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function isServableSubmissionPath(dir: string, filePath: string): boolean {
  // Without user separation the page's own code can read these files anyway, so keep the previous
  // behavior and stay usable for course authoring outside the judge image.
  if (!sandboxUserName) return true;
  try {
    return isContainedPath(fs.realpathSync(dir), fs.realpathSync(filePath));
  } catch {
    // A missing file is reported as 404 below; anything unresolvable is not servable either.
    return !fs.existsSync(filePath);
  }
}

function getContentType(pathname: string): string {
  for (const [suffix, contentType] of Object.entries(CONTENT_TYPE_BY_SUFFIX)) {
    if (pathname.endsWith(suffix)) return contentType;
  }
  return 'text/plain';
}
