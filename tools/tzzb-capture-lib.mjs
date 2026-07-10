const allowedHost = 'tzzb.10jqka.com.cn';
const allowedMethods = new Set(['GET', 'POST']);

export function shouldCaptureResponse(response) {
  const url = response.url();
  const method = response.request().method();
  const contentType = response.headers()['content-type'] || '';

  if (!url.includes(allowedHost)) return false;
  if (!allowedMethods.has(method)) return false;

  return contentType.includes('json') || url.includes('/caishen_fund/');
}

export function isSensitiveKey(key) {
  return /password|passwd|pwd|token|cookie|secret|auth/i.test(key);
}

export function redactRequestPostData(postData) {
  if (!postData) return postData;

  try {
    const parsed = JSON.parse(postData);
    for (const key of Object.keys(parsed)) {
      if (isSensitiveKey(key)) parsed[key] = '[REDACTED]';
    }
    return JSON.stringify(parsed);
  } catch {
    return postData;
  }
}
