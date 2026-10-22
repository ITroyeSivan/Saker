import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

// Keep captured wire bytes intact. Decode only a bounded copy for readers.
export function responseBodyText(receipt, maximumBytes = 65536) {
  const head = String(receipt.responseHead || '');
  const type = /^content-type:\s*([^\r\n]*)/im.exec(head)?.[1] || '';
  const encoding = (/^content-encoding:\s*([^\r\n]*)/im.exec(head)?.[1] || '').trim().toLowerCase();
  if (receipt.bodyUnavailable) return { available: false, text: '[响应正文不可读取]' };
  let bytes = Buffer.from(receipt.responseBodyBase64 || '', 'base64');
  try {
    if (encoding && encoding !== 'identity') {
      if (receipt.responseTruncated) throw new Error('压缩响应未完整保存');
      const decode = { gzip: gunzipSync, 'x-gzip': gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[encoding];
      if (!decode) throw new Error('尚不支持的响应压缩格式：' + encoding);
      bytes = decode(bytes, { maxOutputLength: maximumBytes });
    }
    if (type && !/(?:text\/|json|xml|javascript|x-www-form-urlencoded|svg)/i.test(type))
      return { available: true, binary: true, text: '[二进制响应 ' + bytes.length + ' 字节]' };
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1] || 'utf-8';
    return { available: true, text: new TextDecoder(charset).decode(bytes.subarray(0, maximumBytes)) };
  } catch (error) {
    return { available: false, text: '[响应正文不可读取：' + (error.code === 'ERR_BUFFER_TOO_LARGE' ? '解压后超过 ' + maximumBytes + ' 字节' : String(error.message)) + ']' };
  }
}
