import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type UnsubscribeDependencies = {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  post?: (url: URL, address: ResolvedAddress) => Promise<number>;
};

export type OneClickResult = {
  httpStatus: number;
  targetHost: string;
};

export function selectOneClickUrl(
  urls: string[] | null,
  listUnsubscribePost: string | null
): string | null {
  if (!/list-unsubscribe\s*=\s*one-click/i.test(listUnsubscribePost ?? "")) {
    return null;
  }

  for (const rawUrl of urls ?? []) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol === "https:") return url.toString();
    } catch {
      // Ignore malformed alternatives and keep looking for a usable HTTPS URL.
    }
  }

  return null;
}

function tagValue(header: string, tag: string): string | null {
  const match = header.match(new RegExp(`(?:^|;)\\s*${tag}\\s*=\\s*([^;]+)`, "i"));
  return match?.[1]?.trim() ?? null;
}

/** Require a passing DKIM domain whose signature covers both RFC 8058 headers. */
export function hasAuthenticatedOneClick(
  authenticationResults: string[],
  dkimSignatures: string[]
): boolean {
  const passingDomains = new Set<string>();
  for (const result of authenticationResults) {
    for (const match of result.matchAll(/\bdkim\s*=\s*pass\b([^;]*)/gi)) {
      const domain = match[1]?.match(/\bheader\.d\s*=\s*([^\s;]+)/i)?.[1];
      if (domain) passingDomains.add(domain.replace(/^"|"$/g, "").toLowerCase());
    }
  }
  if (passingDomains.size === 0) return false;

  return dkimSignatures.some((signature) => {
    const domain = tagValue(signature, "d")?.toLowerCase();
    const signedHeaders = tagValue(signature, "h")
      ?.toLowerCase()
      .split(":")
      .map((name) => name.trim());
    return Boolean(
      domain &&
        passingDomains.has(domain) &&
        signedHeaders?.includes("list-unsubscribe") &&
        signedHeaders.includes("list-unsubscribe-post")
    );
  });
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isPrivateIpv4(address);
  if (family !== 6) return false;

  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPublicAddress(normalized.slice("::ffff:".length));
  }

  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

async function resolveAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));
}

export async function validateOneClickUrl(
  rawUrl: string,
  resolver: (hostname: string) => Promise<ResolvedAddress[]> = resolveAddresses
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Malformed unsubscribe URL");
  }

  if (url.protocol !== "https:") throw new Error("Unsubscribe URL must use HTTPS");
  if (url.username || url.password) throw new Error("Unsubscribe URL may not contain credentials");
  if (url.port && url.port !== "443") throw new Error("Unsubscribe URL must use port 443");

  const hostname = url.hostname.toLowerCase();
  if (
    !hostname ||
    isIP(hostname) !== 0 ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  ) {
    throw new Error("Unsubscribe URL host is not a public hostname");
  }

  const addresses = await resolver(hostname);
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("Unsubscribe URL resolved to a non-public address");
  }

  return { url, addresses };
}

function postToResolvedAddress(url: URL, address: ResolvedAddress): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        servername: url.hostname,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength("List-Unsubscribe=One-Click"),
          "User-Agent": "fastmail-email-triage/1.0",
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, address.address, address.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        resolve(status);
      }
    );

    req.setTimeout(10_000, () => req.destroy(new Error("Unsubscribe request timed out")));
    req.on("error", reject);
    req.write("List-Unsubscribe=One-Click");
    req.end();
  });
}

export async function unsubscribeOneClick(
  rawUrl: string,
  dependencies: UnsubscribeDependencies = {}
): Promise<OneClickResult> {
  const { url, addresses } = await validateOneClickUrl(rawUrl, dependencies.resolve);
  const post = dependencies.post ?? postToResolvedAddress;
  const httpStatus = await post(url, addresses[0]!);

  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`Unsubscribe endpoint returned HTTP ${httpStatus}`);
  }

  return { httpStatus, targetHost: url.hostname.toLowerCase() };
}
