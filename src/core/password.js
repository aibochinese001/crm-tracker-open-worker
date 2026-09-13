// @ts-check
/**
 * PBKDF2 密码哈希（Web Crypto，Workers 原生支持）
 */

const ITERATIONS = 100000;
const HASH_ALGO = 'SHA-256';

/**
 * 生成随机 salt（16 字节 hex）
 * @returns {string}
 */
export function makeSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * PBKDF2 哈希密码
 * @param {string} password
 * @param {string} [salt] hex；缺省时自动生成
 * @returns {Promise<{hash: string, salt: string}>} hash 为 hex
 */
export async function hashPassword(password, salt) {
  const useSalt = salt || makeSalt();
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const saltBytes = new Uint8Array(useSalt.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: HASH_ALGO, salt: saltBytes, iterations: ITERATIONS },
    keyMaterial,
    256
  );
  const hash = Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return { hash, salt: useSalt };
}

/**
 * 校验密码
 * @param {string} password
 * @param {string} salt
 * @param {string} expectedHash
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, salt, expectedHash) {
  try {
    const { hash } = await hashPassword(password, salt);
    // 常量时间比较，防时序侧信道
    if (hash.length !== expectedHash.length) return false;
    let diff = 0;
    for (let i = 0; i < hash.length; i++) {
      diff |= hash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}
