import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export interface HttpServer {
  [Symbol.asyncDispose](): Promise<void>;
  url: string;
  port: number | undefined;
}

/** Starts a web-page test server and returns its address synchronously. */
export function startHttpServer(dir: string): HttpServer {
  const server = createAssetServer(dir);
  server.listen();
  return createServerHandle(server);
}

/** Starts an asset server reachable only from the local machine. */
export async function startLocalHttpServer(dir: string): Promise<HttpServer> {
  const server = createAssetServer(dir);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return createServerHandle(server);
}

function createAssetServer(dir: string): http.Server {
  const rootPath = path.resolve(dir);
  return http.createServer((request, response) => {
    let pathname: string;
    try {
      const encodedPathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      pathname = decodeURIComponent(encodedPathname.replaceAll(/%(?![\da-f]{2})/giu, '%25'));
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }

    if (pathname === '/') {
      pathname = '/index.html';
    }

    const pathnameWithIndexHtml = pathname.endsWith('/') ? path.join(pathname, 'index.html') : pathname;

    const filePath = path.resolve(rootPath, `.${pathnameWithIndexHtml}`);
    const relativePath = path.relative(rootPath, filePath);
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
      response.writeHead(403);
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
}

function createServerHandle(server: http.Server): HttpServer {
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

function getContentType(pathname: string): string {
  for (const [suffix, contentType] of Object.entries(CONTENT_TYPE_BY_SUFFIX)) {
    if (pathname.endsWith(suffix)) return contentType;
  }
  return 'text/plain';
}
