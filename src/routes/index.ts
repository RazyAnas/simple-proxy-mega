import { getBodyBuffer } from '@/utils/body';
import {
  getProxyHeaders,
  getAfterResponseHeaders,
  getBlacklistedHeaders,
} from '@/utils/headers';
import {
  createTokenIfNeeded,
  isAllowedToMakeRequest,
  setTokenHeader,
} from '@/utils/turnstile';

export default defineEventHandler(async (event) => {
  // handle CORS, if applicable
  if (isPreflightRequest(event)) return handleCors(event, {});

  // parse destination URL
  const destination = getQuery<{ destination?: string }>(event).destination;
  if (!destination)
    return await sendJson({
      event,
      status: 200,
      data: {
        message: `Proxy is working as expected (v${
          useRuntimeConfig(event).version
        })`,
      },
    });

  if (!(await isAllowedToMakeRequest(event)))
    return await sendJson({
      event,
      status: 401,
      data: {
        error: 'Invalid or missing token',
      },
    });

  // read body
  const body = await getBodyBuffer(event);
  const token = await createTokenIfNeeded(event);

  // proxy
  try {
    await specificProxyRequest(event, destination, {
      blacklistedHeaders: getBlacklistedHeaders(),
      fetchOptions: {
        redirect: 'follow',
        headers: getProxyHeaders(event.headers),
        body,
      },
      onResponse(outputEvent, response) {
        let headers = getAfterResponseHeaders(response.headers, response.url);
        if (headers['content-type'] && headers['content-type'].includes('text/html')) {
          // Intercept the HTML and modify the links
          response.text().then(html => {
            const updatedHtml = html.replace(/href="([^"]*)"/g, (match, url) => {
              let newUrl = url;

              // Handle relative paths (e.g., "/home")
              if (url.startsWith('/')) {
                const destinationUrl = new URL(destination);
                newUrl = destinationUrl.origin + url;
              }

              // Handle full URLs (e.g., "http://example.com/home")
              if (newUrl.startsWith('http') || newUrl.startsWith('//')) {
                return `href="/?destination=${encodeURIComponent(newUrl)}"`;
              }

              // Return the original if it doesn't match the above patterns
              return match;
            });
            outputEvent.res.setHeader('Content-Length', Buffer.byteLength(updatedHtml));
            outputEvent.res.end(updatedHtml);
          });
        } else {
          setResponseHeaders(outputEvent, headers);
          if (token) setTokenHeader(event, token);
        }
      },
    });
  } catch (e) {
    console.log('Error fetching', e);
    throw e;
  }
});
