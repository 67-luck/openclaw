import { constants, createCipheriv, publicEncrypt, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

// Investigation-only public key. The private key stays outside the repository and CI.
const PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA4Pyll0syBr1HSP5RD7Z4\n5WFsDVHMwPtVqF7HHEP0KenhcC9ou4dMqtKmb/ZRed3rEEYnJ4e60bXlb+oJSVxy\nWZAet/biwPPzI8/opIiSB1noJwpHx1P7Tz3fGf68jT/0k+IekqHaY2hkmck1SpO/\nUxV4dYFDmwEMxDImJKRpMZkVPNauIlGsPPtRSqDHptQ0da4DtfaxUDVGUza7I3So\nfqZ2H2o67fuwlhuInl7cHdy09QrLbW6Pv3zt8IIDLb1ndN6JrRLhFY6McvH712r7\nk8eQaQrIsO4vJ8aWS+aV69iV4sLIF5zRob7jgVxuwiB1J2jW3uT9qa0Txwl16IsJ\nzLcefIB9DpwZ1gxTa3d8sJmQyBBtN4jfASoxDLXWyx8Ai+k2//bzaVNGOuFBhBHI\nACOkdFt91RT0QIF08CeitbHqM0XUZ/xZZlZA3FrHB6mn1CEHtOjThmsjwu3jxwQ+\nrT48tpIIrbDRpvtzdZM4iR8wQfqnGOfY8Nakf3XAbnlZAgMBAAE=\n-----END PUBLIC KEY-----\n";

export function sealChatFailureLogs(logs: Record<string, string | undefined>) {
  const limit = 4 * 1024 * 1024;
  const bounded = Object.fromEntries(
    Object.entries(logs).map(([name, value]) => {
      if (value === undefined) {
        return [name, { available: false }];
      }
      const bytes = Buffer.from(value);
      return [
        name,
        {
          available: true,
          bytes: bytes.length,
          truncated: bytes.length > limit,
          text: bytes.subarray(Math.max(0, bytes.length - limit)).toString("utf8"),
        },
      ];
    }),
  );
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(gzipSync(Buffer.from(JSON.stringify(bounded)))),
    cipher.final(),
  ]);
  const wrappedKey = publicEncrypt(
    { key: PUBLIC_KEY, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    key,
  );
  return {
    schema: 1,
    algorithm: "RSA-OAEP-SHA256/AES-256-GCM/gzip",
    key: wrappedKey.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
