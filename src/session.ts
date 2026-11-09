/**
 * 会话读写。
 *
 * 会话用 AES-GCM 加密后放进 Cookie：base64url(iv).base64url(ciphertext)。
 * GCM 自带完整性校验，不需要额外 HMAC。
 *
 * 会话里可能带登录者自己的 GitHub 访问令牌，用于读取私有仓库数据和提交 Review；
 * 令牌只存在于加密 Cookie 中，不写日志、不入库。
 * 只使用 Workers 与浏览器都存在的 btoa/atob，不依赖 Node 的 Buffer。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toB64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromB64Url = (value: string): Uint8Array => {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const keyOf = async (secret: string): Promise<CryptoKey> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
};

export interface SessionPayload {
  login: string;
  name: string;
  avatar: string;
  /** 过期时间，毫秒时间戳 */
  exp: number;
  /** 登录者的 GitHub 令牌：用于提交 Review；未配置服务端只读令牌时也用于取数 */
  token?: string;
}

export const createSession = async (
  payload: SessionPayload,
  secret: string,
): Promise<string> => {
  const key = await keyOf(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  return `${toB64Url(iv)}.${toB64Url(new Uint8Array(cipher))}`;
};

export const readSession = async (
  cookieHeader: string | null,
  secret: string,
): Promise<SessionPayload | null> => {
  if (!cookieHeader) return null;
  const raw = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("sess="));
  if (!raw) return null;

  const value = raw.slice("sess=".length);
  const [ivPart, bodyPart] = value.split(".");
  if (!ivPart || !bodyPart) return null;

  try {
    const key = await keyOf(secret);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64Url(ivPart) },
      key,
      fromB64Url(bodyPart),
    );
    const payload = JSON.parse(decoder.decode(plain)) as SessionPayload;
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
};

/** 解析 Cookie 中的指定字段，用于校验 OAuth 回调。 */
export const readCookie = (cookieHeader: string | null, name: string): string | null => {
  if (!cookieHeader) return null;
  const hit = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};
